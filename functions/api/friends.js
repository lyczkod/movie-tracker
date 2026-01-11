// Endpoint API dla systemu znajomych
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
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
    const userId = await getUserIdFromRequest(request);
    
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    switch (method) {
      case 'GET':
        return handleGetFriends(env.db, userId, url, corsHeaders);
      case 'POST':
        return handleSendRequest(env.db, userId, request, corsHeaders);
      case 'PUT':
        return handleRespondToRequest(env.db, userId, request, corsHeaders);
      case 'DELETE':
        return handleRemoveFriend(env.db, userId, request, corsHeaders);
      default:
        return new Response('Method not allowed', { 
          status: 405,
          headers: corsHeaders 
        });
    }
  } catch (error) {
    console.error('Error in friends API:', error);
    return new Response(JSON.stringify({ 
      error: error.message,
      stack: error.stack 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Pobierz listę znajomych
async function handleGetFriends(db, userId, url, corsHeaders) {
  const status = url.searchParams.get('status') || 'accepted';
  const search = url.searchParams.get('search') || '';

    let query = `
    SELECT 
      f.id as friendship_id,
      f.status,
      f.requested_at,
      f.responded_at,
      u.id as user_id,
      u.nickname,
      u.avatar_url,
      u.description,
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
      CASE 
        WHEN f.user1_id = ? THEN f.user2_id 
        ELSE f.user1_id 
      END as friend_id,
      CASE 
        WHEN f.user1_id = ? THEN 'sent' 
        ELSE 'received' 
      END as request_direction
    FROM friends f
    JOIN users u ON (
      CASE 
        WHEN f.user1_id = ? THEN u.id = f.user2_id 
        ELSE u.id = f.user1_id 
      END
    )
    WHERE (f.user1_id = ? OR f.user2_id = ?)
    AND f.status = ?
  `;

  const params = [userId, userId, userId, userId, userId, status];

  if (search) {
    query += ' AND u.nickname LIKE ?';
    params.push(`%${search}%`);
  }

  query += ' ORDER BY f.requested_at DESC';

  const result = await db.prepare(query).bind(...params).all();

  const friends = result.results.map(row => ({
    friendship_id: row.friendship_id,
    status: row.status,
    requested_at: row.requested_at,
    responded_at: row.responded_at,
    request_direction: row.request_direction,
    user_id: row.friend_id,
    nickname: row.nickname,
    avatar_url: row.avatar_url,
    description: row.description
  , total_movies: row.total_movies || 0,
  total_series: row.total_series || 0
  }));

  return new Response(JSON.stringify(friends), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Wyślij zaproszenie do znajomych
async function handleSendRequest(db, userId, request, corsHeaders) {
  const data = await request.json();
  const { friendId } = data;

  if (!friendId) {
    return new Response(JSON.stringify({ error: 'Friend ID is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Sprawdź czy użytkownik istnieje
  const friend = await db.prepare('SELECT id FROM users WHERE id = ?').bind(friendId).first();
  if (!friend) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Sprawdź czy już istnieje relacja znajomości (dowolne porządkowanie user1/user2)
  const existing = await db.prepare(`
    SELECT * FROM friends 
    WHERE (user1_id = ? AND user2_id = ?) 
    OR (user1_id = ? AND user2_id = ?)
  `).bind(userId, friendId, friendId, userId).first();

  if (existing) {
    // Obsłuż różne stany istniejącej relacji
    switch (existing.status) {
      case 'accepted':
        return new Response(JSON.stringify({ error: 'Users are already friends' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      case 'pending':
        return new Response(JSON.stringify({ error: 'Friend request already exists' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      case 'blocked':
        return new Response(JSON.stringify({ error: 'Cannot send request. User is blocked' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      case 'rejected': {
        // Usuń stary rekord i utwórz nowy, aby zachować chronologię przy ponownym wysłaniu
        await db.prepare('DELETE FROM friends WHERE id = ?').bind(existing.id).run();
        const insert = await db.prepare(`
          INSERT INTO friends (user1_id, user2_id, status, requested_at)
          VALUES (?, ?, 'pending', ?)
        `).bind(userId, friendId, new Date().toISOString()).run();

        return new Response(JSON.stringify({ success: true, resent: true, created: insert.lastInsertRowId || null }), {
          status: 201,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      default:
        return new Response(JSON.stringify({ error: 'Cannot send request' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
  }

  // Utwórz zaproszenie
  await db.prepare(`
    INSERT INTO friends (user1_id, user2_id, status)
    VALUES (?, ?, 'pending')
  `).bind(userId, friendId).run();

  return new Response(JSON.stringify({ success: true }), {
    status: 201,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Odpowiedz na zaproszenie (zaakceptuj/odrzuć)
async function handleRespondToRequest(db, userId, request, corsHeaders) {
  const data = await request.json();
  const { friendshipId, action } = data; // action: 'accept' lub 'reject'

  if (!friendshipId || !action) {
    return new Response(JSON.stringify({ error: 'Friendship ID and action are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Sprawdź czy zaproszenie istnieje i użytkownik jest odbiorcą
  const friendship = await db.prepare(`
    SELECT * FROM friends 
    WHERE id = ? AND user2_id = ? AND status = 'pending'
  `).bind(friendshipId, userId).first();

  if (!friendship) {
    return new Response(JSON.stringify({ error: 'Friend request not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const newStatus = action === 'accept' ? 'accepted' : 'rejected';
  const respondedAt = new Date().toISOString();

  await db.prepare(`
    UPDATE friends 
    SET status = ?, responded_at = ?
    WHERE id = ?
  `).bind(newStatus, respondedAt, friendshipId).run();

  return new Response(JSON.stringify({ success: true, status: newStatus }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Usuń znajomego lub anuluj zaproszenie
async function handleRemoveFriend(db, userId, request, corsHeaders) {
  const data = await request.json();
  const { friendshipId } = data;

  if (!friendshipId) {
    return new Response(JSON.stringify({ error: 'Friendship ID is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Sprawdź czy użytkownik ma prawo usunąć tę relację
  const friendship = await db.prepare(`
    SELECT * FROM friends 
    WHERE id = ? AND (user1_id = ? OR user2_id = ?)
  `).bind(friendshipId, userId, userId).first();

  if (!friendship) {
    return new Response(JSON.stringify({ error: 'Friendship not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  await db.prepare('DELETE FROM friends WHERE id = ?').bind(friendshipId).run();

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
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
