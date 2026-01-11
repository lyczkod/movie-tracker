// Endpoint administracyjny do zarządzania filmami w bazie danych

// Funkcja pomocnicza zapewniająca, że adresy URL plakatów używają HTTPS
function normalizePosterUrl(url) {
  if (!url) return null;
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Sprawdź czy użytkownik jest administratorem
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const user = await env.db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
    if (!user || user.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    switch (method) {
      case 'GET':
        return handleGetMovies(env.db, request, corsHeaders);
      case 'POST':
        return handleCreateMovie(env.db, request, corsHeaders);
      case 'PUT':
        return handleUpdateMovie(env.db, request, corsHeaders);
      case 'DELETE':
        return handleDeleteMovie(env.db, request, corsHeaders);
      default:
        return new Response('Method not allowed', { 
          status: 405,
          headers: corsHeaders 
        });
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Pobierz filmy (wszystkie lub konkretny po ID)
async function handleGetMovies(db, request, corsHeaders) {
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const movieId = pathParts[pathParts.length - 1] !== 'movies' ? pathParts[pathParts.length - 1] : null;

  if (movieId) {
    // Pobierz konkretny film
    const movie = await db.prepare('SELECT * FROM movies WHERE id = ?').bind(movieId).first();
    if (!movie) {
      return new Response(JSON.stringify({ error: 'Movie not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(movie), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } else {
    // Pobierz wszystkie filmy
    const movies = await db.prepare('SELECT * FROM movies ORDER BY title').all();
    return new Response(JSON.stringify(movies.results || []), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Check whether a column exists in a table (without altering the DB)
async function hasColumn(db, tableName, columnName) {
  try {
    const info = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    const cols = (info && info.results) ? info.results : (info || []);
    return Array.isArray(cols) && cols.some(c => c.name === columnName);
  } catch (e) {
    console.error('hasColumn error:', e);
    return false;
  }
}

// Utwórz nowy film
async function handleCreateMovie(db, request, corsHeaders) {
  try {
    const data = await request.json();
    // Check if DB has duration column so we can persist minutes (don't alter DB automatically)
    const hasMoviesDuration = await hasColumn(db, 'movies', 'duration');
    
    console.log('[admin/movies] Creating movie with data:', JSON.stringify(data, null, 2));
    
    if (!data.title || !data.type) {
      return new Response(JSON.stringify({ error: 'Title and type are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Sprawdź czy film już istnieje
    const existing = await db.prepare('SELECT id FROM movies WHERE title = ? AND media_type = ?')
      .bind(data.title, data.type).first();
    
    if (existing) {
      return new Response(JSON.stringify({ error: 'Movie already exists', id: existing.id }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Oblicz całkowitą liczbę odcinków dla serialu
    const totalSeasons = data.totalSeasons || 1;
    const episodesPerSeason = data.episodesPerSeason || (data.type === 'series' ? 10 : 1);
    const totalEpisodes = data.type === 'series' ? totalSeasons * episodesPerSeason : 1;

    // Buduj INSERT dynamicznie, aby uniknąć dołączania kolumn, które mogą nie istnieć (np. duration) — nie modyfikując schematu DB
    const insertCols = ['title','media_type','release_date','genre','poster_url','trailer_url','description','total_seasons','total_episodes'];
    const insertPlaceholders = ['?','?','?','?','?','?','?','?','?'];
    const insertValues = [
      data.title,
      data.type,
      data.year || new Date().getFullYear().toString(),
      data.genre || 'Unknown',
      normalizePosterUrl(data.poster) || `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(data.title)}`,
      data.trailer || null,
      data.description || '',
      totalSeasons,
      totalEpisodes
    ];
    // Zapisz duration dla filmów i seriali (dla seriali to średnia długość odcinka)
    if (hasMoviesDuration && data.duration !== undefined) {
      insertCols.splice(7,0,'duration'); // wprowadź przed total_seasons
      insertPlaceholders.splice(7,0,'?');
      insertValues.splice(7,0,Number(data.duration));
    }

    const result = await db.prepare(`
      INSERT INTO movies (${insertCols.join(',')})
      VALUES (${insertPlaceholders.join(',')})
    `).bind(...insertValues).run();

    const movieId = result.meta.last_row_id;

    // Jeśli to serial, utwórz sezony i odcinki
    if (data.type === 'series') {
      console.log('[admin/movies] Received data.duration:', data.duration, 'type:', typeof data.duration);
      // Użyj podanej duration dla odcinków lub domyślnie 45
        let episodeDuration = data.duration !== undefined ? Number(data.duration) : 45;
        if (Number.isNaN(episodeDuration)) episodeDuration = 45;
      console.log(`[admin/movies] Creating series: episodeDuration=${episodeDuration}`);
      const hasEpisodeDisplay = await hasColumn(db, 'episodes', 'display_number');
      
      for (let seasonNum = 1; seasonNum <= totalSeasons; seasonNum++) {
        // Utwórz sezon
        const seasonResult = await db.prepare(`
          INSERT INTO seasons (series_id, season_number, episode_count, title)
          VALUES (?, ?, ?, ?)
        `).bind(
          movieId,
          seasonNum,
          episodesPerSeason,
          `Sezon ${seasonNum}`
        ).run();

        const seasonId = seasonResult.meta.last_row_id;

        // Utwórz odcinki dla tego sezonu
          for (let episodeNum = 1; episodeNum <= episodesPerSeason; episodeNum++) {
          const displayNumber = `S${String(seasonNum).padStart(2, '0')} - E${String(episodeNum).padStart(3, '0')}`;
            if (hasEpisodeDisplay) {
              await db.prepare(`
                INSERT INTO episodes (season_id, episode_number, title, duration, display_number)
                VALUES (?, ?, ?, ?, ?)
              `).bind(
                seasonId,
                episodeNum,
                `Odcinek ${episodeNum}`,
                episodeDuration,
                displayNumber
              ).run();
            } else {
              await db.prepare(`
                INSERT INTO episodes (season_id, episode_number, title, duration)
                VALUES (?, ?, ?, ?)
              `).bind(
                seasonId,
                episodeNum,
                `Odcinek ${episodeNum}`,
                episodeDuration
              ).run();
            }
        }
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      id: movieId,
      debug: {
        receivedDuration: data.duration,
        usedDuration: data.type === 'series' ? (data.duration !== undefined ? Number(data.duration) : 45) : null
      } 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error in handleCreateMovie:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Zaktualizuj istniejący film
async function handleUpdateMovie(db, request, corsHeaders) {
  const data = await request.json();
  // Spróbuj wyodrębnić ID z URL, jeśli nie podano w ładunku
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const pathId = pathParts[pathParts.length - 1] !== 'movies' ? pathParts[pathParts.length - 1] : null;
  if (!data.id && pathId) data.id = pathId;
  console.log('[admin/movies] Update payload:', JSON.stringify(data).slice(0, 1000));
  
  if (!data.id) {
    return new Response(JSON.stringify({ error: 'Movie ID is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Pobierz istniejący film, aby znać aktualny media_type na wypadek, gdyby `data.type` nie było podane
  const existingMovie = await db.prepare('SELECT id, media_type FROM movies WHERE id = ?').bind(data.id).first();
  const existingType = existingMovie ? existingMovie.media_type : null;
  const updates = [];
  const params = [];

  if (data.title) {
    updates.push('title = ?');
    params.push(data.title);
  }
  if (data.type) {
    updates.push('media_type = ?');
    params.push(data.type);
  }
  if (data.year !== undefined) {
    updates.push('release_date = ?');
    params.push(data.year);
  }
  if (data.genre) {
    updates.push('genre = ?');
    params.push(data.genre);
  }
  if (data.poster !== undefined) {
    updates.push('poster_url = ?');
    params.push(normalizePosterUrl(data.poster));
  }
  if (data.trailer !== undefined) {
    updates.push('trailer_url = ?');
    params.push(data.trailer);
  }
  if (data.description !== undefined) {
    updates.push('description = ?');
    params.push(data.description);
  }
  // Przechowaj wartość duration przed dalszym przetwarzaniem, aby później użyć jej z odcinkami
  let episodeDuration = null;
  if (data.duration !== undefined) {
    episodeDuration = Number(data.duration);
    if (Number.isNaN(episodeDuration)) episodeDuration = null;
    // Przechowuj duration w movies tylko jeśli tabela movies ma kolumnę duration
    const hasMoviesDuration = await hasColumn(db, 'movies', 'duration');
    // Dla filmów powinny być przechowywane wartości duration, dla seriali będzie to NULL
    // Określ, czy ten film jest traktowany jako serial czy film; preferuj podany data.type, a następnie istniejący typ filmu
    const isSeries = (data.type !== undefined) ? (data.type === 'series') : (existingType === 'series');
    if (hasMoviesDuration) {
      updates.push('duration = ?');
      params.push(isSeries ? null : episodeDuration);
    } else {
      // Jeśli celem jest film, a schemat DB nie obsługuje duration, zwróć informacyjny błąd
      if (!isSeries) {
        return new Response(JSON.stringify({ error: 'Movies table missing duration column; please apply DB migration to support updating movie duration.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      console.warn('[admin/movies] duration column missing, skipping update of movies.duration (series propagation may still occur)');
    }
  }

  // Jeśli nie ma bezpośrednich aktualizacji filmu, ale podano nową wartość duration
  // i celem jest propagacja do odcinków serialu, powinniśmy kontynuować.
  const isSeriesForPropagate = (data.type !== undefined) ? (data.type === 'series') : (existingType === 'series');
  if (updates.length === 0 && !(episodeDuration !== null && isSeriesForPropagate)) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  params.push(data.id);
  
  // Sprawdź obecność kolumny duration w tabeli movies (nie zmieniaj schematu tutaj)
  const hasMoviesDuration = await hasColumn(db, 'movies', 'duration');
  console.log('[admin/movies] Updates:', updates, 'Params:', params);
  if (updates.length > 0) {
    await db.prepare(`
      UPDATE movies SET ${updates.join(', ')} WHERE id = ?
    `).bind(...params).run();
  } else {
    console.log('[admin/movies] No direct movie updates to run, skipping UPDATE movies query');
  }

  // Jeśli admin podał duration dla serialu, propaguj ją do wszystkich odcinków
  try {
    // Określ, czy powinniśmy propagować duration do odcinków: jeśli celem jest serial i podano episodeDuration
    const isSeriesForPropagate = (data.type !== undefined) ? (data.type === 'series') : (existingType === 'series');
    console.log(`[admin/movies] Propagate duration? episodeDuration=${episodeDuration}, isSeriesForPropagate=${isSeriesForPropagate}`);
    if (episodeDuration !== null && isSeriesForPropagate) {
      await db.prepare(`
        UPDATE episodes SET duration = ?
        WHERE season_id IN (SELECT id FROM seasons WHERE series_id = ?)
      `).bind(episodeDuration, data.id).run();
      console.log(`Updated episodes duration to ${episodeDuration} for series ${data.id}`);
    }
  } catch (e) {
    console.error('Error propagating duration to episodes:', e);
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Usuń film
async function handleDeleteMovie(db, request, corsHeaders) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  if (!id) {
    return new Response(JSON.stringify({ error: 'Movie ID is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Usuń powiązane rekordy najpierw (jeśli nie ma kaskadowania)
  await db.prepare('DELETE FROM challenge_watched WHERE movie_id = ?').bind(id).run();
  await db.prepare('DELETE FROM reviews WHERE movie_id = ?').bind(id).run();
  await db.prepare('DELETE FROM watched WHERE movie_id = ?').bind(id).run();
  await db.prepare('DELETE FROM movies WHERE id = ?').bind(id).run();

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
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
      return null;
    }
    
    return payload.userId;
  } catch {
    return null;
  }
}
