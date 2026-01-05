// Endpoint admin API do zarządzania odcinkami seriali
async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

async function checkAdminRole(db, userId) {
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').bind(userId).first();
  return user && user.role === 'admin';
}

// Sprawdza, czy kolumna display_number istnieje w tabeli episodes nie modyfikując bazy danych
async function hasEpisodesDisplayColumn(db) {
  try {
    const info = await db.prepare("PRAGMA table_info(episodes)").all();
    const cols = (info && info.results) ? info.results : (info || []);
    return Array.isArray(cols) && cols.some(c => c.name === 'display_number');
  } catch (e) {
    console.error('hasEpisodesDisplayColumn error:', e);
    return false;
  }
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const seriesId = params.id;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const isAdmin = await checkAdminRole(env.db, userId);
    if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    switch (method) {
      case 'GET':
        return handleGetAdminEpisodes(env.db, seriesId, corsHeaders);
      case 'PUT':
        return handleUpdateEpisode(env.db, request, corsHeaders);
      case 'POST':
        return handleBulkUpdate(env.db, request, corsHeaders);
      default:
        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }
  } catch (error) {
    console.error('[admin episodes] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleGetAdminEpisodes(db, seriesId, corsHeaders) {
  try {
    const series = await db.prepare('SELECT id, title FROM movies WHERE id = ? AND media_type = ?').bind(seriesId, 'series').first();
    if (!series) return new Response(JSON.stringify({ error: 'Series not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Warunkowo pobierz display_number tylko jeśli kolumna istnieje w DB
    const hasDisplay = await hasEpisodesDisplayColumn(db);
    const selectCols = hasDisplay ? 'e.id as episode_id, e.season_id, s.season_number, e.episode_number, e.title as episode_title, e.description, e.air_date, e.duration, e.display_number' : 'e.id as episode_id, e.season_id, s.season_number, e.episode_number, e.title as episode_title, e.description, e.air_date, e.duration';
    const rows = await db.prepare(`
      SELECT ${selectCols}
      FROM episodes e
      JOIN seasons s ON e.season_id = s.id
      WHERE s.series_id = ?
      ORDER BY s.season_number, e.episode_number
    `).bind(seriesId).all();

    const episodes = (rows && rows.results) ? rows.results.map(r => ({
      id: r.episode_id,
      seasonId: r.season_id,
      seasonNumber: r.season_number,
      episodeNumber: r.episode_number,
      displayNumber: r.display_number || `S${String(r.season_number).padStart(2,'0')} - E${String(r.episode_number).padStart(3,'0')}`,
      title: r.episode_title,
      description: r.description,
      airDate: r.air_date || null,
      duration: r.duration
    })) : [];

    // Jeśli kolumna display_number istnieje, ale niektóre wiersze mają NULL w display_number, uzupełnij je
    // aby nowo utworzone odcinki (lub istniejące po migracji) miały wartości.
    try {
      if (hasDisplay) {
        const missing = await db.prepare(`SELECT COUNT(*) as cnt FROM episodes e JOIN seasons s ON e.season_id = s.id WHERE s.series_id = ? AND (e.display_number IS NULL OR e.display_number = '')`).bind(seriesId).first();
        const missingCount = (missing && missing.cnt) ? Number(missing.cnt) : 0;
        if (missingCount > 0) {
          // Uzupełnij używając season_number + episode_number
          await db.prepare(`
            UPDATE episodes
            SET display_number = 'S' || printf('%02d', (SELECT season_number FROM seasons WHERE id = episodes.season_id)) || ' - E' || printf('%03d', episodes.episode_number)
            WHERE id IN (SELECT e.id FROM episodes e JOIN seasons s ON e.season_id = s.id WHERE s.series_id = ? AND (e.display_number IS NULL OR e.display_number = ''))
          `).bind(seriesId).run();
          console.log(`[admin/episodes] Backfilled ${missingCount} display_number fields for series ${seriesId}`);
        }
      }
    } catch (e) {
      console.warn('[admin/episodes] Error during display_number backfill:', e);
      // Kontynuuj bez przerywania odpowiedzi użytkownikowi - to nie jest krytyczne
    }

    return new Response(JSON.stringify({ series: { id: series.id, title: series.title }, episodes, hasDisplay }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[admin episodes get] error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Get failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleUpdateEpisode(db, request, corsHeaders) {
  try {
    const data = await request.json();
    console.log('[admin/episodes] PUT payload:', JSON.stringify(data).slice(0, 1000));
    if (!data || !data.id) return new Response(JSON.stringify({ error: 'Episode id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    // Sprawdza, czy kolumna display_number istnieje w tabeli episodes nie modyfikując bazy danych
    const hasDisplay = await hasEpisodesDisplayColumn(db);

    const updates = [];
    const params = [];
    if (data.title !== undefined) { updates.push('title = ?'); params.push(data.title); }
    if (data.description !== undefined) { updates.push('description = ?'); params.push(data.description); }
    if (data.airDate !== undefined) { updates.push('air_date = ?'); params.push(data.airDate || null); }
    
    // Sprawdź czy odcinek jest ręcznie edytowany (ma opis lub różny duration od avg)
    let isDurationManuallyEdited = false;
    if (data.duration !== undefined) {
      const parsedDuration = Number(data.duration);
      const finalDuration = Number.isNaN(parsedDuration) ? null : parsedDuration;
      
      // Pobierz aktualny avg duration serialu dla tego odcinka
      try {
        const seriesInfo = await db.prepare(`
          SELECT m.duration as series_avg
          FROM episodes e
          JOIN seasons s ON e.season_id = s.id
          JOIN movies m ON s.series_id = m.id
          WHERE e.id = ?
        `).bind(data.id).first();
        
        if (seriesInfo && seriesInfo.series_avg !== finalDuration) {
          isDurationManuallyEdited = true;
          console.log(`[admin/episodes] Episode ${data.id} duration manually edited: ${finalDuration} (series avg: ${seriesInfo.series_avg})`);
        }
      } catch (e) {
        console.warn('[admin/episodes] Could not check series avg:', e);
      }
      
      updates.push('duration = ?');
      params.push(finalDuration);
    }
    
    // Jeśli edytowano description, również oznacz jako ręcznie edytowany
    if (data.description !== undefined && data.description !== null && data.description.trim() !== '') {
      isDurationManuallyEdited = true;
    }
    
    if (data.displayNumber !== undefined && hasDisplay) { updates.push('display_number = ?'); params.push(data.displayNumber); }

    if (updates.length === 0) return new Response(JSON.stringify({ error: 'No fields to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    params.push(data.id);
    await db.prepare(`UPDATE episodes SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

    return new Response(JSON.stringify({ success: true, manuallyEdited: isDurationManuallyEdited }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[admin episodes update] error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Update failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleBulkUpdate(db, request, corsHeaders) {
  try {
    const data = await request.json();
    console.log('[admin/episodes] BULK update payload: episodes count=', (data.episodes && data.episodes.length) ? data.episodes.length : 0);
    const { episodes } = data;
    if (!Array.isArray(episodes)) return new Response(JSON.stringify({ error: 'episodes array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const hasDisplay = await hasEpisodesDisplayColumn(db);
    
    let manuallyEditedCount = 0;
    
    for (const ep of episodes) {
      const updates = [];
      const params = [];
      if (ep.title !== undefined) { updates.push('title = ?'); params.push(ep.title); }
      if (ep.description !== undefined) { updates.push('description = ?'); params.push(ep.description); }
      if (ep.airDate !== undefined) { updates.push('air_date = ?'); params.push(ep.airDate || null); }
      
      if (ep.duration !== undefined) {
        const parsedDuration = Number(ep.duration);
        const finalDuration = Number.isNaN(parsedDuration) ? null : parsedDuration;
        
        // Sprawdź czy czas trwania różni się od avg serialu
        try {
          const seriesInfo = await db.prepare(`
            SELECT m.duration as series_avg
            FROM episodes e
            JOIN seasons s ON e.season_id = s.id
            JOIN movies m ON s.series_id = m.id
            WHERE e.id = ?
          `).bind(ep.id).first();
          
          if (seriesInfo && seriesInfo.series_avg !== finalDuration) {
            manuallyEditedCount++;
          }
        } catch (e) {
          console.warn('[admin/episodes] Could not check series avg for episode:', ep.id);
        }
        
        updates.push('duration = ?');
        params.push(finalDuration);
      }
      
      // Jeśli edytowano description, również liczymy jako ręcznie edytowany
      if (ep.description !== undefined && ep.description !== null && ep.description.trim() !== '') {
        manuallyEditedCount++;
      }
      
      if (ep.displayNumber !== undefined && hasDisplay) { updates.push('display_number = ?'); params.push(ep.displayNumber); }
      if (updates.length > 0) {
        params.push(ep.id);
        await db.prepare(`UPDATE episodes SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
      }
    }
    
    console.log(`[admin/episodes] Bulk update complete. ${manuallyEditedCount} episodes manually edited.`);
    return new Response(JSON.stringify({ success: true, manuallyEditedCount }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[admin episodes bulk update] error:', e);
    return new Response(JSON.stringify({ error: e.message || 'Bulk update failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
