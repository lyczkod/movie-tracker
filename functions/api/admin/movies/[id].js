// Endpoint administracyjny do zarządzania pojedynczymi filmami
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
        return handleGetMovie(env.db, movieId, corsHeaders);
      case 'PUT':
        return handleUpdateMovie(env.db, request, movieId, corsHeaders);
      case 'DELETE':
        return handleDeleteMovie(env.db, movieId, corsHeaders);
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

// Pobierz konkretny film
async function handleGetMovie(db, movieId, corsHeaders) {
  const movie = await db.prepare('SELECT * FROM movies WHERE id = ?').bind(movieId).first();
  
  if (!movie) {
    return new Response(JSON.stringify({ error: 'Movie not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Dla seriali zwróć duration z tabeli movies (nie wyliczaj ponownie z odcinków)
  // Wartość w movies.duration to ustawiony avg, który jest propagowany do odcinków
  
  return new Response(JSON.stringify(movie), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Zaktualizuj film
async function handleUpdateMovie(db, request, movieId, corsHeaders) {
  const data = await request.json();
  
  // Zbuduj zapytanie UPDATE dynamicznie na podstawie podanych pól
  const updates = [];
  const values = [];
  
  if (data.title !== undefined) {
    updates.push('title = ?');
    values.push(data.title);
  }
  if (data.type !== undefined) {
    updates.push('media_type = ?');
    values.push(data.type);
  }
  if (data.year !== undefined) {
    updates.push('release_date = ?');
    values.push(data.year || null);
  }
  if (data.genre !== undefined) {
    updates.push('genre = ?');
    values.push(data.genre);
  }
  if (data.poster !== undefined) {
    updates.push('poster_url = ?');
    values.push(data.poster);
  }
  if (data.trailer !== undefined) {
    updates.push('trailer_url = ?');
    values.push(data.trailer);
  }
  if (data.description !== undefined) {
    updates.push('description = ?');
    values.push(data.description);
  }
  // Pobierz aktualny avg duration PRZED aktualizacją (jeśli będzie zmiana duration)
  let oldAvgDuration = null;
  let episodeDuration = null;
  if (data.duration !== undefined) {
    episodeDuration = Number(data.duration);
    
    // Pobierz aktualną wartość duration dla serialu
    try {
      const movie = await db.prepare('SELECT media_type, duration FROM movies WHERE id = ?').bind(movieId).first();
      if (movie && movie.media_type === 'series') {
        oldAvgDuration = movie.duration;
      }
    } catch (e) {
      console.error('Error fetching old duration:', e);
    }
    
    updates.push('duration = ?');
    values.push(episodeDuration);
  }
  
  if (updates.length === 0) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  values.push(movieId);
  
  await db.prepare(`
    UPDATE movies 
    SET ${updates.join(', ')}
    WHERE id = ?
  `).bind(...values).run();

  // Dla seriali - propaguj duration tylko do odcinków, które:
  // 1. Mają taki sam czas jak stary avg
  // 2. NIE mają wypełnionego opisu (czyli nie były ręcznie edytowane)
  if (episodeDuration !== null && oldAvgDuration !== null) {
    try {
      await db.prepare(`
        UPDATE episodes SET duration = ?
        WHERE season_id IN (SELECT id FROM seasons WHERE series_id = ?)
        AND duration = ?
        AND (description IS NULL OR description = '')
      `).bind(episodeDuration, movieId, oldAvgDuration).run();
      console.log(`Updated non-edited episodes with duration ${oldAvgDuration} to ${episodeDuration} for series ${movieId}`);
    } catch (e) {
      console.error('Error propagating duration to episodes:', e);
    }
  }

  return new Response(JSON.stringify({ success: true, id: movieId }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Usuń film
async function handleDeleteMovie(db, movieId, corsHeaders) {
  try {
    console.log(`[DELETE] Starting deletion for movie ID: ${movieId}`);
    
    // Sprawdź czy film istnieje
    const movie = await db.prepare('SELECT media_type FROM movies WHERE id = ?').bind(movieId).first();
    
    if (!movie) {
      console.log(`[DELETE] Movie ${movieId} not found`);
      return new Response(JSON.stringify({ error: 'Movie not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    console.log(`[DELETE] Movie type: ${movie.media_type}`);
    
    if (movie.media_type === 'series') {
      console.log(`[DELETE] Deleting series with seasons and episodes`);
      // Dla seriali - usuń najpierw wszystkie powiązane dane
      
      // Pobierz ID wszystkich sezonów
      const seasons = await db.prepare('SELECT id FROM seasons WHERE series_id = ?').bind(movieId).all();
      console.log(`[DELETE] Found ${seasons.results?.length || 0} seasons`);
      
      if (seasons && seasons.results && seasons.results.length > 0) {
        for (const season of seasons.results) {
          // Pobierz ID wszystkich odcinków w tym sezonie
          const episodes = await db.prepare('SELECT id FROM episodes WHERE season_id = ?').bind(season.id).all();
          
          if (episodes && episodes.results && episodes.results.length > 0) {
            for (const episode of episodes.results) {
              // Usuń wpisy user_episodes_watched dla tego odcinka
              await db.prepare('DELETE FROM user_episodes_watched WHERE episode_id = ?').bind(episode.id).run();
            }
            
            // Usuń wszystkie odcinki w tym sezonie
            await db.prepare('DELETE FROM episodes WHERE season_id = ?').bind(season.id).run();
          }
        }
        
        // Usuń wszystkie sezony
        await db.prepare('DELETE FROM seasons WHERE series_id = ?').bind(movieId).run();
      }
    }
    
    // Usuń powiązane rekordy (dla filmów i seriali)
    console.log(`[DELETE] Deleting watched entries`);
    await db.prepare('DELETE FROM watched WHERE movie_id = ?').bind(movieId).run();
    
    console.log(`[DELETE] Deleting reviews`);
    await db.prepare('DELETE FROM reviews WHERE movie_id = ?').bind(movieId).run();
    
    // Usuń film/serial
    console.log(`[DELETE] Deleting movie record`);
    await db.prepare('DELETE FROM movies WHERE id = ?').bind(movieId).run();

    console.log(`[DELETE] Successfully deleted movie ${movieId}`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error deleting movie/series:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to delete movie/series',
      details: error.message 
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

  const token = authHeader.substring(7);
  
  try {
    const payload = JSON.parse(atob(token));
    return payload.userId;
  } catch (error) {
    return null;
  }
}
