// Endpoint API do wyszukiwania filmów w bazie danych D1

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
      .map(s => {
        const key = s.toLowerCase().replace(/_/g, ' ');
        if (key === 'science fiction' || key === 'science_fiction' || key === 'science-fiction') return 'Sci-Fi';
            if (key === 'drama' || key === 'dramat') return 'Dramat';
        return s.replace(/_/g, ' ');
      })
      .filter(Boolean)
      .join(', ');
  }

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;
  
  // Nagłówki CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405,
      headers: corsHeaders 
    });
  }

  const query = url.searchParams.get('query');
  if (query === null) {
    return new Response(JSON.stringify({ error: 'Query parameter required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Sprawdź uwierzytelnienie
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    // Wyszukaj w naszej bazie danych D1 - jeśli query jest puste, zwróć wszystko
    const searchQuery = query ? `%${query.toLowerCase()}%` : '%';
    // Dla pustego query (kalendarz) zwróć wszystko, dla wyszukiwania ogranicz do 20
    const limitClause = query ? 'LIMIT 20' : '';
    console.log('[search] query:', query, 'limitClause:', limitClause);
    const result = await env.db.prepare(`
      SELECT 
        id,
        title,
        media_type as type,
        release_date,
        strftime('%Y', release_date) as year,
        genre,
        poster_url as poster,
        trailer_url,
        description,
        duration,
        COALESCE(total_seasons, 1) as total_seasons,
        COALESCE(total_episodes, 1) as total_episodes,
        0 as rating,
        'planning' as status,
        date('now') as watchedDate
      FROM movies 
      WHERE LOWER(title) LIKE ? OR LOWER(genre) LIKE ? OR LOWER(description) LIKE ?
      ORDER BY title ${limitClause}
    `).bind(searchQuery, searchQuery, searchQuery).all();

    // Przekształć do formatu zgodnego z frontendem
    const transformedResults = await Promise.all(result.results.map(async row => {
      if (row.title && row.title.includes('Avatar') && row.title.includes('Ogień')) {
        console.log('[search] Avatar 3 raw data:', JSON.stringify(row));
      }
      const rawYear = parseInt(row.year);
      const currentYear = new Date().getFullYear();
      const year = (Number.isFinite(rawYear) && rawYear >= 1800 && rawYear <= currentYear + 5) ? rawYear : null;
      const duration = (row.duration !== undefined && row.duration !== null) ? Number(row.duration) : null;
      
      // For series, calculate average episode duration
      let avgEpisodeLength = null;
      if (row.type === 'series') {
        try {
          const avgRes = await env.db.prepare(`
            SELECT AVG(e.duration) as avg_duration
            FROM episodes e
            JOIN seasons s ON e.season_id = s.id
            WHERE s.series_id = ?
          `).bind(row.id).first();
          if (avgRes && avgRes.avg_duration !== null) {
            avgEpisodeLength = Math.round(avgRes.avg_duration);
          }
        } catch (e) {
          console.warn('Could not compute avg episode duration for search:', e);
        }
      }
      
      // Oblicz średnią ocenę z recenzji
      let avgRating = 0;
      try {
        const reviewsRes = await env.db.prepare(`
          SELECT AVG(rating) as avg_rating, COUNT(*) as review_count
          FROM reviews
          WHERE movie_id = ?
        `).bind(row.id).first();
        if (reviewsRes && reviewsRes.review_count > 0 && reviewsRes.avg_rating !== null) {
          avgRating = Math.round(reviewsRes.avg_rating * 10) / 10; // Zaokrąglij do 1 miejsca po przecinku
        }
      } catch (e) {
        console.warn('Could not compute avg rating for search:', e);
      }
      
      return {
        id: `db_${row.id}`,
        title: row.title,
        type: row.type,
        year: year,
        release_date: row.release_date || null,
        genre: normalizeGenre(row.genre) || 'Unknown',
        // Znormalizuj URL plakatu w różnych formatach kluczy
        poster_url: normalizePosterUrl(row.poster) || null,
        poster: normalizePosterUrl(row.poster) || `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(row.title)}`,
        trailer_url: row.trailer_url || null,
        description: row.description || '',
        duration: row.type === 'movie' ? duration : (avgEpisodeLength || null),
        avgEpisodeLength: avgEpisodeLength,
        totalSeasons: row.total_seasons || null,
        totalEpisodes: row.total_episodes || null,
        rating: avgRating,
        status: 'planning',
        watchedDate: new Date().toISOString().split('T')[0]
      };
    }));

    return new Response(JSON.stringify(transformedResults), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Search error:', error);
    return new Response(JSON.stringify({ error: 'Search failed' }), {
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