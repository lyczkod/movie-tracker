// Endpoint do wyszukiwania użytkowników
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

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

  try {
    const userId = await getUserIdFromRequest(request);
    
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const query = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit')) || 10;

    if (!query || query.length < 2) {
      return new Response(JSON.stringify({ users: [] }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Wyszukaj użytkowników (z wyłączeniem siebie)
    const result = await env.db.prepare(`
      SELECT 
        u.id,
        f.id as friendship_id,
        (
          SELECT COUNT(1)
          FROM watched w
          JOIN movies m ON w.movie_id = m.id
          WHERE w.user_id = u.id AND w.status = 'watched' AND m.media_type = 'movie'
        ) AS total_movies,
        (
          SELECT COUNT(1)
          FROM watched w2
          JOIN movies m2 ON w2.movie_id = m2.id
          WHERE w2.user_id = u.id AND w2.status = 'watched' AND m2.media_type = 'series'
        ) AS total_series,
        u.nickname,
        u.avatar_url,
        u.description,
        CASE 
          WHEN f.id IS NOT NULL THEN f.status
          ELSE NULL
        END as friendship_status,
        CASE WHEN f.id IS NOT NULL THEN (CASE WHEN f.user1_id = ? THEN 'sent' ELSE 'received' END) ELSE NULL END as friendship_direction
      FROM users u
      LEFT JOIN friends f ON (
        (f.user1_id = ? AND f.user2_id = u.id) OR 
        (f.user2_id = ? AND f.user1_id = u.id)
      )
      WHERE u.id != ? 
      AND u.nickname LIKE ?
      ORDER BY u.nickname
      LIMIT ?
    `).bind(userId, userId, userId, userId, `%${query}%`, limit).all();

    // Normalizuj wyniki, aby zawierały zarówno pola w snake_case, jak i camelCase
    const users = result.results.map(row => {
      // Upewnij się, że avatar używa https, jeśli to możliwe
      let avatar = (row.avatar_url && String(row.avatar_url).trim()) ? String(row.avatar_url).trim() : null;
      if (avatar && avatar.startsWith('http://')) avatar = avatar.replace('http://', 'https://');

      // Jeśli nie podano avatara, użyj domyślnego avatara
      if (!avatar) {
        avatar = '/images/default-avatar.png';
      }

      return {
        id: row.id,
        total_movies: row.total_movies || 0,
        total_series: row.total_series || 0,
        friendship_id: row.friendship_id,
        nickname: row.nickname,
        description: row.description,
        // Udostępnij avatar w różnych formatach kluczy
        avatar_url: avatar,
        avatarUrl: avatar,
        avatar: avatar,
        friendship_status: row.friendship_status,
        friendshipStatus: row.friendship_status,
        friendship_direction: row.friendship_direction,
        friendshipDirection: row.friendship_direction
      };
    });

    return new Response(JSON.stringify({ users }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error searching users:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack 
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
      return null;
    }
    
    return payload.userId;
  } catch {
    return null;
  }
}
