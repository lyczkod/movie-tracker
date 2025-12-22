// Endpoint administracyjny do konfiguracji sezonów i odcinków dla serialu
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

async function checkAdminRole(db, userId) {
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
  return user && user.role === 'admin';
}

// GET - Pobierz sezony serialu
export async function onRequestGet(context) {
  const { request, env, params } = context;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const isAdmin = await checkAdminRole(env.db, userId);
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const seriesId = parseInt(params.id);
    
    // Pobierz wszystkie sezony dla danego serialu
    const seasons = await env.db.prepare(`
      SELECT id, season_number, episode_count, title, air_date
      FROM seasons
      WHERE series_id = ?
      ORDER BY season_number ASC
    `).bind(seriesId).all();

    return new Response(JSON.stringify(seasons.results || []), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching seasons:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// POST - Konfiguruj sezony serialu
export async function onRequestPost(context) {
  const { request, env, params } = context;
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const isAdmin = await checkAdminRole(env.db, userId);
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const seriesId = parseInt(params.id);
    const data = await request.json();
    const { seasons } = data;

    if (!seasons || !Array.isArray(seasons) || seasons.length === 0) {
      return new Response(JSON.stringify({ error: 'Tablica sezonów jest wymagana' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Zweryfikuj czy serial istnieje
    const series = await env.db.prepare('SELECT id, media_type FROM movies WHERE id = ? AND media_type = ?')
      .bind(seriesId, 'series').first();
    
    if (!series) {
      return new Response(JSON.stringify({ error: 'Series not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Usuń istniejące sezony i odcinki (kaskadowanie obsłuży odcinki)
    await env.db.prepare('DELETE FROM seasons WHERE series_id = ?').bind(seriesId).run();

    // Wstaw nowe sezony i odcinki
    let totalEpisodes = 0;
    
    for (const season of seasons) {
      const { seasonNumber, episodeCount } = season;
      
      // Wstaw sezon
      const seasonResult = await env.db.prepare(`
        INSERT INTO seasons (series_id, season_number, episode_count, title)
        VALUES (?, ?, ?, ?)
      `).bind(seriesId, seasonNumber, episodeCount, `Sezon ${seasonNumber}`).run();
      
      const seasonId = seasonResult.meta.last_row_id;
      
      // Wstaw odcinki dla tego sezonu
      const hasEpisodeDisplay = await env.db.prepare("PRAGMA table_info(episodes)").all().then(info => {
        const cols = (info && info.results) ? info.results : (info || []);
        return Array.isArray(cols) && cols.some(c => c.name === 'display_number');
      }).catch(e => { console.warn('[admin/seasons] hasEpisodeDisplay error:', e); return false; });
      // Determine default episodeDuration: prefer the movie's duration (if exists), otherwise fallback to 45
      const movieInfo = await env.db.prepare('SELECT id, duration FROM movies WHERE id = ?').bind(seriesId).first();
      const defaultEpisodeDuration = (movieInfo && movieInfo.duration !== null && movieInfo.duration !== undefined) ? Number(movieInfo.duration) : 45;
        for (let epNum = 1; epNum <= episodeCount; epNum++) {
        const displayNumber = `S${String(seasonNumber).padStart(2, '0')} - E${String(epNum).padStart(3, '0')}`;
        if (hasEpisodeDisplay) {
          await env.db.prepare(`
            INSERT INTO episodes (season_id, episode_number, title, duration, display_number)
            VALUES (?, ?, ?, ?, ?)
          `).bind(seasonId, epNum, `Odcinek ${epNum}`, defaultEpisodeDuration, displayNumber).run();
        } else {
          await env.db.prepare(`
            INSERT INTO episodes (season_id, episode_number, title, duration)
            VALUES (?, ?, ?, ?)
          `).bind(seasonId, epNum, `Odcinek ${epNum}`, defaultEpisodeDuration).run();
        }
      }
      
      totalEpisodes += episodeCount;
    }

    // Zaktualizuj całkowitą liczbę odcinków serialu
    await env.db.prepare(`
      UPDATE movies 
      SET total_seasons = ?, total_episodes = ?
      WHERE id = ?
    `).bind(seasons.length, totalEpisodes, seriesId).run();

    return new Response(JSON.stringify({ 
      success: true,
      totalSeasons: seasons.length,
      totalEpisodes: totalEpisodes
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error saving seasons:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}
