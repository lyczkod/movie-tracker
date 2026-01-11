// Endpoint do pobierania profilu użytkownika
export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const targetUserId = params.id;

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

    // Pobierz podstawowe informacje o użytkowniku
    const user = await env.db.prepare(`
      SELECT id, nickname, avatar_url, description, created_at
      FROM users
      WHERE id = ?
    `).bind(targetUserId).first();

    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Pobierz statystyki użytkownika
    const stats = await env.db.prepare(`
      SELECT 
        COUNT(CASE WHEN w.status = 'watched' AND m.media_type = 'movie' THEN 1 END) as watched_movies,
        COUNT(CASE WHEN w.status = 'watched' AND m.media_type = 'series' THEN 1 END) as watched_series,
        COUNT(CASE WHEN w.status = 'watching' THEN 1 END) as watching,
        COUNT(CASE WHEN w.status = 'planning' THEN 1 END) as planning
      FROM watched w
      JOIN movies m ON w.movie_id = m.id
      WHERE w.user_id = ?
    `).bind(targetUserId).first();

    // Pobierz liczbę znajomych
    const friendsCount = await env.db.prepare(`
      SELECT COUNT(*) as count
      FROM friends
      WHERE (user1_id = ? OR user2_id = ?)
      AND status = 'accepted'
    `).bind(targetUserId, targetUserId).first();

    // Pobierz odznaki użytkownika
    const badges = await env.db.prepare(`
      SELECT b.id, b.name, b.description, b.image_url, ub.level, ub.earned_at
      FROM user_badges ub
      JOIN badges b ON ub.badge_id = b.id
      WHERE ub.user_id = ?
      ORDER BY ub.earned_at DESC
      LIMIT 10
    `).bind(targetUserId).all();

    // Pobierz ostatnią aktywność (ostatnie 5 obejrzanych)
    const recentActivity = await env.db.prepare(`
      SELECT 
        m.id,
        m.title,
        m.poster_url,
        m.genre,
        m.media_type,
        w.watched_date,
        r.rating
      FROM watched w
      JOIN movies m ON w.movie_id = m.id
      LEFT JOIN reviews r ON r.user_id = w.user_id AND r.movie_id = w.movie_id
      WHERE w.user_id = ? AND w.status = 'watched'
      ORDER BY w.watched_date DESC
      LIMIT 5
    `).bind(targetUserId).all();

    // Sprawdź status znajomości
    const friendship = await env.db.prepare(`
      SELECT f.id as friendship_id, f.status,
        CASE 
          WHEN f.user1_id = ? THEN 'sent'
          ELSE 'received'
        END as direction
      FROM friends f
      WHERE (f.user1_id = ? AND f.user2_id = ?) OR (f.user1_id = ? AND f.user2_id = ?)
    `).bind(userId, userId, targetUserId, targetUserId, userId).first();

    // Normalize avatar
    let avatar = user.avatar_url || '/images/default-avatar.png';
    if (avatar.startsWith('http://')) {
      avatar = avatar.replace('http://', 'https://');
    }

    const profile = {
      id: user.id,
      nickname: user.nickname,
      avatar_url: avatar,
      description: user.description,
      created_at: user.created_at,
      stats: {
        watchedMovies: stats?.watched_movies || 0,
        watchedSeries: stats?.watched_series || 0,
        watching: stats?.watching || 0,
        planning: stats?.planning || 0,
        friends: friendsCount?.count || 0
      },
      badges: badges.results || [],
      recentActivity: (recentActivity.results || []).map(a => ({
        ...a,
        poster_url: (a.poster_url && a.poster_url.startsWith('http://')) ? a.poster_url.replace('http://', 'https://') : a.poster_url,
        poster: (a.poster_url && a.poster_url.startsWith('http://')) ? a.poster_url.replace('http://', 'https://') : a.poster_url || `https://placehold.co/60x90/cccccc/666666/png?text=${encodeURIComponent(a.title)}`,
        genre: (function(g) {
          if (!g) return '';
          const key = g.toLowerCase().replace(/_/g, ' ').trim();
          if (key === 'drama' || key === 'dramat') return 'Dramat';
          if (key === 'science fiction' || key === 'science_fiction' || key === 'science-fiction') return 'Sci-Fi';
          return g.replace(/_/g, ' ');
        })(a.genre)
      })),
      friendship: friendship ? {
        id: friendship.friendship_id,
        status: friendship.status,
        direction: friendship.direction
      } : null
    };

    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
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
