// Endpoint użytkownika do zarządzania pojedynczymi filmami na jego liście do obejrzenia

// Funkcja pomocnicza zapewniająca, że adresy URL plakatów używają HTTPS
function normalizePosterUrl(url) {
  if (!url) return null;
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
}

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

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const movieId = params.id;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Log do debugowania
  console.log(`[movies/[id].js] Method: ${method}, Movie ID: ${movieId}`);

  try {
    // Sprawdź uwierzytelnienie
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      console.error('[movies/[id].js] No userId found');
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[movies/[id].js] User ID: ${userId}`);

    switch (method) {
      case 'GET':
        return handleGetMovie(env.db, userId, movieId, corsHeaders);
      case 'PUT':
        return handleUpdateMovie(env.db, userId, request, movieId, corsHeaders);
      case 'DELETE':
        return handleDeleteMovie(env.db, userId, movieId, corsHeaders);
      default:
        return new Response('Method not allowed', { 
          status: 405,
          headers: corsHeaders 
        });
    }
  } catch (error) {
    console.error('[movies/[id].js] Error:', error);
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Pobierz konkretny film z recenzją użytkownika i statusem obejrzenia
async function handleGetMovie(db, userId, movieId, corsHeaders) {
  const query = `
    SELECT 
      m.id,
      m.title,
      m.media_type as type,
      m.release_date,
      strftime('%Y', m.release_date) as year,
      m.genre,
      m.poster_url as poster,
      m.trailer_url,
      m.description,
      m.duration,
      r.rating,
      r.content as review,
      w.watched_date as watchedDate,
      COALESCE(w.status, CASE WHEN w.id IS NOT NULL THEN 'watched' ELSE 'planning' END) as status
    FROM movies m
    LEFT JOIN reviews r ON m.id = r.movie_id AND r.user_id = ?
    LEFT JOIN watched w ON m.id = w.movie_id AND w.user_id = ?
    WHERE m.id = ?
  `;
  
  const movie = await db.prepare(query).bind(userId, userId, movieId).first();
  
  if (!movie) {
    return new Response(JSON.stringify({ error: 'Movie not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Przekształć do formatu zgodnego z frontendem
  // sanitize year and duration
  const rawYear = parseInt(movie.year);
  const currentYear = new Date().getFullYear();
  const year = (Number.isFinite(rawYear) && rawYear >= 1800 && rawYear <= currentYear + 5) ? rawYear : null;
  const movieDuration = (movie.duration !== undefined && movie.duration !== null) ? Number(movie.duration) : null;

  const transformedMovie = {
    id: movie.id,
    title: movie.title,
    type: movie.type,
    year: year,
    release_date: movie.release_date || null,
    genre: normalizeGenre(movie.genre) || 'Unknown',
    description: movie.description || '',
    rating: movie.rating || 0,
    status: movie.status,
    watchedDate: movie.watchedDate || null,
    // Provide canonical poster_url for frontend to prefer, keep poster fallback for legacy clients
    poster_url: normalizePosterUrl(movie.poster) || null,
    poster: normalizePosterUrl(movie.poster) || `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(movie.title)}`,
    trailer_url: movie.trailer_url || null,
    // do not default to 120 minutes for movies; keep null if unknown
    duration: movie.type === 'movie' ? movieDuration : null,
    review: movie.review || ''
  };

  // Jeśli to serial, oblicz średnią długość odcinka
  if (transformedMovie.type === 'series') {
    try {
      const avgRes = await env.db.prepare(`
        SELECT AVG(e.duration) as avg_duration
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        WHERE s.series_id = ?
      `).bind(movieId).first();
      if (avgRes && avgRes.avg_duration !== null) {
        transformedMovie.avgEpisodeLength = Math.round(avgRes.avg_duration);
        // set duration to avgEpisodeLength for frontend convenience
        transformedMovie.duration = transformedMovie.avgEpisodeLength;
      } else {
        transformedMovie.avgEpisodeLength = null;
      }
    } catch (e) {
      console.warn('[movies/[id].js] Could not compute avg episode duration:', e);
      transformedMovie.avgEpisodeLength = null;
    }
  }

  return new Response(JSON.stringify(transformedMovie), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Zaktualizuj film (ocena, recenzja, status obejrzenia)
async function handleUpdateMovie(db, userId, request, movieId, corsHeaders) {
  let data;
  try {
    data = await request.json();
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  console.log('handleUpdateMovie called:', { userId, movieId, data });
  
  let completedChallenges = [];
  
  try {
    // Zweryfikuj, czy film istnieje
    const movie = await db.prepare('SELECT id FROM movies WHERE id = ?').bind(movieId).first();
    if (!movie) {
      return new Response(JSON.stringify({ error: 'Movie not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Zaktualizuj status obejrzenia na podstawie pola status
    if (data.status) {
      console.log('Updating watched status:', data.status);
      const watchedDate = data.watchedDate || new Date().toISOString().split('T')[0];
      
      // Sprawdź, czy rekord watched istnieje
      const existingWatched = await db.prepare(
        'SELECT id FROM watched WHERE user_id = ? AND movie_id = ?'
      ).bind(userId, movieId).first();
      
      if (existingWatched) {
        // Zaktualizuj istniejący rekord nowym statusem
        await db.prepare(`
          UPDATE watched 
          SET watched_date = ?, status = ?
          WHERE user_id = ? AND movie_id = ?
        `).bind(watchedDate, data.status, userId, movieId).run();
      } else {
        // Wstaw nowy rekord ze statusem
        await db.prepare(`
          INSERT INTO watched (user_id, movie_id, watched_date, status)
          VALUES (?, ?, ?, ?)
        `).bind(userId, movieId, watchedDate, data.status).run();
      }
      
      console.log('About to call checkChallengeProgress');
      
      // Sprawdź postęp w wyzwaniach po dodaniu filmu (dla statusu 'watched')
      if (data.status === 'watched') {
        console.log('Status is watched, calling checkChallengeProgress');
        completedChallenges = await checkChallengeProgress(db, userId, movieId, watchedDate);
        console.log('checkChallengeProgress returned:', completedChallenges);
      }
    }
    
    // Zaktualizuj recenzję i ocenę
    // UWAGA: Rating jest wymagany w schemacie bazy (NOT NULL, 1-5)
    if (data.rating !== undefined && data.rating > 0) {
      // Sprawdź, czy recenzja istnieje
      const existingReview = await db.prepare(
        'SELECT id FROM reviews WHERE user_id = ? AND movie_id = ?'
      ).bind(userId, movieId).first();
      
      const content = data.review || '';
      
      if (existingReview) {
        // Zaktualizuj istniejącą recenzję
        await db.prepare(`
          UPDATE reviews 
          SET content = ?, rating = ?, updated_at = datetime('now')
          WHERE user_id = ? AND movie_id = ?
        `).bind(content, data.rating, userId, movieId).run();
      } else {
        // Wstaw nową recenzję
        await db.prepare(`
          INSERT INTO reviews (user_id, movie_id, content, rating)
          VALUES (?, ?, ?, ?)
        `).bind(userId, movieId, content, data.rating).run();
      }
    } else if (data.rating !== undefined && data.rating === 0) {
      // Jeśli ocena wynosi 0, usuń recenzję
      await db.prepare(`
        DELETE FROM reviews WHERE user_id = ? AND movie_id = ?
      `).bind(userId, movieId).run();
    }
    
    return new Response(JSON.stringify({ 
      success: true,
      completedChallenges: completedChallenges 
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error updating movie:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.toString()
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Usuń film z listy obejrzanych użytkownika (usuwa status obejrzenia i recenzję, ale nie sam film)
async function handleDeleteMovie(db, userId, movieId, corsHeaders) {
  try {
    // Zweryfikuj, czy film istnieje
    const movie = await db.prepare('SELECT id, media_type FROM movies WHERE id = ?').bind(movieId).first();
    if (!movie) {
      return new Response(JSON.stringify({ error: 'Movie not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Jeśli to serial, usuń również wszystkie obejrzane odcinki użytkownika
    if (movie.media_type === 'series') {
      await db.prepare(`
        DELETE FROM user_episodes_watched 
        WHERE user_id = ? 
        AND episode_id IN (
          SELECT e.id FROM episodes e
          JOIN seasons s ON e.season_id = s.id
          WHERE s.series_id = ?
        )
      `).bind(userId, movieId).run();
    }
    
    // Usuń z listy obejrzanych
    const watchedResult = await db.prepare('DELETE FROM watched WHERE user_id = ? AND movie_id = ?')
      .bind(userId, movieId)
      .run();
    
    // Usuń recenzję
    const reviewResult = await db.prepare('DELETE FROM reviews WHERE user_id = ? AND movie_id = ?')
      .bind(userId, movieId)
      .run();
    
    console.log(`[handleDeleteMovie] Deleted ${watchedResult.meta?.changes || 0} watched records and ${reviewResult.meta?.changes || 0} review records`);
    
    return new Response(JSON.stringify({ 
      success: true,
      deletedWatched: watchedResult.meta?.changes || 0,
      deletedReviews: reviewResult.meta?.changes || 0
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error deleting movie:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      details: error.toString()
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
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

// Sprawdź postęp w wyzwaniach i przyznaj odznakę, jeśli wyzwanie ukończone
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
