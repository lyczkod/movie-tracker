// Endpoint API dla operacji na filmach/serialach
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  // Nagłówki CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    switch (method) {
      case 'GET':
        return handleGet(env.db, request, url, corsHeaders);
      case 'POST':
        return handlePost(env.db, request, corsHeaders);
      default:
        return new Response('Method not allowed', { 
          status: 405,
          headers: corsHeaders 
        });
    }
  } catch (error) {
    console.error('Error in movies API:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Pobierz filmy/seriale z recenzjami i statusem obejrzenia
async function handleGet(db, request, url, corsHeaders) {
  const userId = await getUserIdFromRequest(request);
  
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  const status = url.searchParams.get('status');
  const type = url.searchParams.get('type');

  // Połącz tabele Movies z tabelami Reviews i Watched
  // Zwróć tylko filmy, z którymi użytkownik wchodził w interakcję (obejrzane lub zrecenzowane)
  let query = `
    SELECT 
      m.id,
      m.title,
      m.media_type as type,
      m.release_date,
      strftime('%Y', m.release_date) as year,
      m.genre,
      m.poster_url as poster_url,
      m.poster_url as poster,
      m.trailer_url,
      m.description,
      m.duration,
      COALESCE(m.total_seasons, 1) as total_seasons,
      COALESCE(m.total_episodes, 1) as total_episodes,
      COALESCE(r.rating, 0) as rating,
      r.content as review,
      w.watched_date as watchedDate,
      COALESCE(w.status, 'watched') as status
    FROM movies m
    LEFT JOIN reviews r ON m.id = r.movie_id AND r.user_id = ?
    LEFT JOIN watched w ON m.id = w.movie_id AND w.user_id = ?
    WHERE (w.id IS NOT NULL OR r.id IS NOT NULL)
  `;
  
  let params = [userId, userId];
  let additionalWhere = [];

  // Filtruj według statusu, jeśli został podany (i nie jest 'all')
  if (status && status !== 'all') {
    additionalWhere.push('COALESCE(w.status, \'watched\') = ?');
    params.push(status);
  }

  if (type) {
    additionalWhere.push('m.media_type = ?');
    params.push(type);
  }

  if (additionalWhere.length > 0) {
    query += ' AND ' + additionalWhere.join(' AND ');
  }

  query += ' ORDER BY COALESCE(w.watched_date, m.created_at) DESC';

    function normalizePosterUrl(url) {
      if (!url) return null;
      if (url.startsWith('http://')) return url.replace('http://', 'https://');
      return url;
    }

    try {
    function normalizeGenre(genre) {
      if (!genre || typeof genre !== 'string') return '';
        return genre.split(/[,;|]+/)
        .map(s => s.trim())
        .map(s => s.replace(/_/g, ' '))
        .map(s => {
          const key = s.toLowerCase();
          if (key === 'science fiction' || key === 'science_fiction' || key === 'science-fiction') return 'Sci-Fi';
          if (key === 'drama' || key === 'dramat') return 'Dramat';
          return s;
        })
        .filter(Boolean)
        .join(', ');
    }
    const result = await db.prepare(query).bind(...params).all();
    
    if (!result || !result.results) {
      console.error('Query returned no results object:', result);
      return new Response(JSON.stringify([]), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    console.log('Query returned', result.results.length, 'rows');
    
    // Dla każdego serialu pobierz liczbę obejrzanych odcinków
        const transformedResults = await Promise.all(result.results.map(async row => {
      try {
        let watchedEpisodes = 0;
        
        // Jeśli to serial, policz obejrzane odcinki
        if (row.type === 'series') {
          try {
            const episodesResult = await db.prepare(`
              SELECT COUNT(*) as count
              FROM user_episodes_watched uew
              JOIN episodes e ON uew.episode_id = e.id
              JOIN seasons s ON e.season_id = s.id
              WHERE s.series_id = ? AND uew.user_id = ?
            `).bind(row.id, userId).first();
            
            watchedEpisodes = episodesResult?.count || 0;
          } catch (e) {
            console.warn('Could not fetch watched episodes:', e);
          }
        }
            // Oblicz średnią długość odcinka dla serialu
            let avgEpisodeLength = null;
            if (row.type === 'series') {
              try {
                const avgRes = await db.prepare(`
                  SELECT AVG(e.duration) as avg_duration
                  FROM episodes e
                  JOIN seasons s ON e.season_id = s.id
                  WHERE s.series_id = ?
                `).bind(row.id).first();
                if (avgRes && avgRes.avg_duration !== null) {
                  avgEpisodeLength = Math.round(avgRes.avg_duration);
                }
              } catch (e) {
                console.warn('Could not compute avg episode duration:', e);
              }
            }

        {
          // year: upewnij się, że jest liczbą i w rozsądnym zakresie
          const rawYear = parseInt(row.year);
          const currentYear = new Date().getFullYear();
          const year = (Number.isFinite(rawYear) && rawYear >= 1800 && rawYear <= currentYear + 5) ? rawYear : null;

          // movie duration: preferuj wartość z movies.duration jeśli dostępna
          const movieDuration = (row.duration !== undefined && row.duration !== null) ? Number(row.duration) : null;

          return {
            id: row.id,
            title: row.title,
            type: row.type,
            year: year,
            release_date: row.release_date || null,
            genre: normalizeGenre(row.genre) || 'Unknown',
            rating: row.rating || 0,
            status: row.status || 'watched',
            watchedDate: row.watchedDate || null,
            description: row.description || '',
            // Udostępnij plakat w różnych formatach kluczy
            poster_url: normalizePosterUrl(row.poster_url || row.poster) || null,
            poster: normalizePosterUrl(row.poster_url || row.poster) || `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(row.title)}`,
            // Dla filmów preferuj explicit movieDuration; dla seriali udostępnij avgEpisodeLength jeśli dostępne
            duration: row.type === 'movie' ? movieDuration : (avgEpisodeLength || null),
            review: row.review || '',
            // Pola specyficzne dla seriali
            totalSeasons: row.total_seasons || null,
            totalEpisodes: row.total_episodes || null,
            watchedEpisodes: watchedEpisodes,
            avgEpisodeLength: avgEpisodeLength,
            // Oblicz postęp dla serialu
            progress: row.type === 'series' && row.total_episodes > 0 
              ? Math.round((watchedEpisodes / row.total_episodes) * 100) 
              : null
          };
        }
      } catch (rowError) {
        console.error('Error processing row:', row.id, rowError);
        // Zwróć podstawowy obiekt w przypadku błędu
          return {
          id: row.id,
          title: row.title,
          type: row.type || 'movie',
          year: parseInt(row.year) || new Date().getFullYear(),
          genre: normalizeGenre(row.genre) || 'Unknown',
          rating: row.rating || 0,
          status: row.status || 'watched',
          watchedDate: row.watchedDate || null,
          poster_url: null,
          poster: `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(row.title || 'Movie')}`,
          duration: null,
          review: ''
        };
      }
    }));
    
    return new Response(JSON.stringify(transformedResults), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error in handleGet:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      query: query,
      params: params 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Dodaj film do listy obejrzanych użytkownika (nie twórz nowego filmu!)
async function handlePost(db, request, corsHeaders) {
  const userId = await getUserIdFromRequest(request);
  
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  const data = await request.json();
  
  try {
    // Zweryfikuj, czy film istnieje
    if (!data.id) {
      return new Response(JSON.stringify({ error: 'Movie ID is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Normalizuj ID: frontend czasami dodaje przedrostek `db_` do ID z bazy danych (zobacz /api/search)
    let movieIdParam = data.id;
    if (typeof movieIdParam === 'string') {
      if (movieIdParam.startsWith('db_')) {
        movieIdParam = movieIdParam.replace(/^db_/, '');
      }
      // jeśli ciąg cyfr, konwertuj na liczbę
      if (/^\d+$/.test(movieIdParam)) {
        movieIdParam = parseInt(movieIdParam, 10);
      }
    }

    if (typeof movieIdParam !== 'number' || Number.isNaN(movieIdParam)) {
      return new Response(JSON.stringify({ error: 'Movie ID invalid' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const movie = await db.prepare('SELECT id FROM movies WHERE id = ?').bind(movieIdParam).first();
    if (!movie) {
      return new Response(JSON.stringify({ error: 'Movie not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const movieId = movie.id;
    
    // Dodaj do tabeli watched z odpowiednim statusem
    const watchedStatus = data.status || 'watched';
    
    // Sprawdź, czy już znajduje się w tabeli watched
    const alreadyWatched = await db.prepare('SELECT id FROM watched WHERE user_id = ? AND movie_id = ?')
      .bind(userId, movieId).first();
    
    if (!alreadyWatched) {
      await db.prepare(`
        INSERT INTO watched (user_id, movie_id, watched_date, status)
        VALUES (?, ?, ?, ?)
      `).bind(userId, movieId, data.watchedDate || new Date().toISOString().split('T')[0], watchedStatus).run();
    } else {
      // Zaktualizuj status, jeśli już istnieje
      await db.prepare(`
        UPDATE watched 
        SET status = ?, watched_date = ?
        WHERE user_id = ? AND movie_id = ?
      `).bind(watchedStatus, data.watchedDate || new Date().toISOString().split('T')[0], userId, movieId).run();
    }
    
    // Dodaj lub zaktualizuj recenzję, jeśli podano ocenę
    if (data.rating > 0) {
      const existingReview = await db.prepare('SELECT id FROM reviews WHERE user_id = ? AND movie_id = ?')
        .bind(userId, movieId).first();
      
      if (existingReview) {
        await db.prepare(`
          UPDATE reviews SET content = ?, rating = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
          WHERE user_id = ? AND movie_id = ?
        `).bind(data.review || '', data.rating, userId, movieId).run();
      } else {
        await db.prepare(`
          INSERT INTO reviews (user_id, movie_id, content, rating)
          VALUES (?, ?, ?, ?)
        `).bind(userId, movieId, data.review || '', data.rating).run();
      }
    }
    
    // Sprawdź postęp w wyzwaniach po dodaniu filmu (tylko dla statusu 'watched')
    let completedChallenges = [];
    if (watchedStatus === 'watched') {
      console.log('Status is watched, calling checkChallengeProgress');
      completedChallenges = await checkChallengeProgress(db, userId, movieId, data.watchedDate || new Date().toISOString().split('T')[0]);
      console.log('checkChallengeProgress returned:', completedChallenges);
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      id: movieId,
      completedChallenges: completedChallenges
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error in handlePost:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Sprawdź postęp w wyzwaniach i przyznaj odznaki
async function checkChallengeProgress(db, userId, movieId, watchedDate) {
  const completedChallenges = [];
  
  try {
    console.log(`Checking challenge progress for user ${userId}, movie ${movieId}`);
    
    // Pobierz wszystkie aktywne wyzwania, w których użytkownik uczestniczy
    const participations = await db.prepare(`
      SELECT 
        cp.id as participant_id,
        cp.challenge_id,
        cp.completed_silver_at,
        cp.completed_gold_at,
        cp.completed_platinum_at,
        c.type,
        c.criteria_value,
        c.target_silver,
        c.target_gold,
        c.target_platinum,
        c.badge_silver_id,
        c.badge_gold_id,
        c.badge_platinum_id,
        c.start_date,
        c.end_date
      FROM challenge_participants cp
      JOIN challenges c ON cp.challenge_id = c.id
      WHERE cp.user_id = ? 
        AND cp.completed_platinum_at IS NULL
        AND c.end_date >= date('now')
    `).bind(userId).all();
    
    console.log(`Found ${participations.results?.length || 0} active challenges`);

    if (!participations.results || participations.results.length === 0) {
      return completedChallenges;
    }

    // Pobierz informacje o filmie
    const movie = await db.prepare(`
      SELECT id, media_type, genre
      FROM movies
      WHERE id = ?
    `).bind(movieId).first();

    if (!movie) {
      return completedChallenges;
    }

    // Sprawdź każde wyzwanie
    for (const participation of participations.results) {
      // Policz postęp dla tego wyzwania
      let progress = 0;
      
      if (participation.type === 'movies' || participation.type === 'both') {
        // Zlicz obejrzane filmy w okresie wyzwania
        const moviesQuery = await db.prepare(`
          SELECT COUNT(DISTINCT w.movie_id) as count
          FROM watched w
          JOIN movies m ON w.movie_id = m.id
          WHERE w.user_id = ?
            AND m.media_type = 'movie'
            AND w.watched_date >= ?
            AND w.watched_date <= ?
        `).bind(userId, participation.start_date, participation.end_date).first();
        
        progress += moviesQuery?.count || 0;
      }

      if (participation.type === 'series' || participation.type === 'both') {
        // Zlicz obejrzane seriale (wszystkie odcinki) w okresie wyzwania
        const seriesQuery = await db.prepare(`
          SELECT COUNT(DISTINCT m.id) as count
          FROM movies m
          WHERE m.media_type = 'series'
            AND m.id IN (
              SELECT DISTINCT e.series_id
              FROM episodes e
              WHERE NOT EXISTS (
                SELECT 1 FROM episodes e2
                WHERE e2.series_id = e.series_id
                  AND e2.id NOT IN (
                    SELECT uew.episode_id
                    FROM user_episodes_watched uew
                    WHERE uew.user_id = ?
                      AND uew.watched_date >= ?
                      AND uew.watched_date <= ?
                  )
              )
            )
        `).bind(userId, participation.start_date, participation.end_date).first();
        
        progress += seriesQuery?.count || 0;
      }

      if (participation.type === 'genre') {
        // Zlicz filmy/seriale z określonego gatunku
        const genreQuery = await db.prepare(`
          SELECT COUNT(DISTINCT w.movie_id) as count
          FROM watched w
          JOIN movies m ON w.movie_id = m.id
          WHERE w.user_id = ?
            AND m.genre LIKE ?
            AND w.watched_date >= ?
            AND w.watched_date <= ?
        `).bind(userId, `%${participation.criteria_value}%`, participation.start_date, participation.end_date).first();
        
        progress = genreQuery?.count || 0;
      }

      // Ogranicz progress do maksymalnego targetu (platinum)
      const maxTarget = participation.target_platinum || participation.target_gold || participation.target_silver || 0;
      if (progress > maxTarget) {
        progress = maxTarget;
      }

      console.log(`Challenge ${participation.challenge_id}: progress=${progress}, maxTarget=${maxTarget}`);

      // Aktualizuj progress w bazie danych
      const updateResult = await db.prepare(`
        UPDATE challenge_participants
        SET progress = ?
        WHERE id = ?
      `).bind(progress, participation.participant_id).run();
      
      console.log(`Updated progress for participant ${participation.participant_id}:`, updateResult);

      // Sprawdź i przyznaj odznaki dla różnych tierów
      const tiersToCheck = [
        { name: 'platinum', target: participation.target_platinum, badgeId: participation.badge_platinum_id, completedField: 'completed_platinum_at', completed: participation.completed_platinum_at },
        { name: 'gold', target: participation.target_gold, badgeId: participation.badge_gold_id, completedField: 'completed_gold_at', completed: participation.completed_gold_at },
        { name: 'silver', target: participation.target_silver, badgeId: participation.badge_silver_id, completedField: 'completed_silver_at', completed: participation.completed_silver_at }
      ];

      for (const tier of tiersToCheck) {
        if (!tier.completed && tier.target && progress >= tier.target && tier.badgeId) {
          // Oznacz tier jako ukończony
          await db.prepare(`
            UPDATE challenge_participants
            SET ${tier.completedField} = datetime('now')
            WHERE id = ?
          `).bind(participation.participant_id).run();

          // Sprawdź czy użytkownik już ma tę odznakę
          const existingBadge = await db.prepare(`
            SELECT id FROM user_badges
            WHERE user_id = ? AND badge_id = ? AND challenge_participant_id = ?
          `).bind(userId, tier.badgeId, participation.participant_id).first();

          if (!existingBadge) {
            // Pobierz informacje o odznace
            const badge = await db.prepare(`
              SELECT id, name, description, image_url, level
              FROM badges
              WHERE id = ?
            `).bind(tier.badgeId).first();
            
            // Wstaw odznakę
            await db.prepare(`
              INSERT INTO user_badges (user_id, badge_id, level, challenge_participant_id, earned_at)
              VALUES (?, ?, ?, ?, datetime('now'))
            `).bind(userId, tier.badgeId, badge?.level || tier.name, participation.participant_id).run();
            
            // Pobierz nazwę wyzwania
            const challenge = await db.prepare(`
              SELECT title FROM challenges WHERE id = ?
            `).bind(participation.challenge_id).first();
            
            // Dodaj do listy ukończonych wyzwań
            completedChallenges.push({
              challengeId: participation.challenge_id,
              challengeTitle: challenge?.title,
              tier: tier.name,
              badge: badge
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking challenge progress:', error);
    // Nie przerywaj głównego procesu, jeśli wystąpi błąd
  }
  
  return completedChallenges;
}

// Wyodrębnij ID użytkownika z tokenu autoryzacyjnego
async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));
    
    if (payload.exp < Date.now()) {
      return null; // Token wygasł
    }
    
    return payload.userId;
  } catch {
    return null;
  }
}