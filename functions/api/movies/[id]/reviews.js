// Endpoint do pobierania wszystkich recenzji dla danego filmu

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const movieId = params.id;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log(`[movies/${movieId}/reviews] Method: ${method}`);

  try {
    // Sprawdź uwierzytelnienie
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      console.error('[movies/[id]/reviews] No userId found');
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (method === 'GET') {
      return handleGetReviews(env.db, movieId, corsHeaders);
    } else {
      return new Response('Method not allowed', { 
        status: 405,
        headers: corsHeaders 
      });
    }
  } catch (error) {
    console.error('[movies/[id]/reviews] Error:', error);
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Pobierz wszystkie recenzje dla danego filmu
async function handleGetReviews(db, movieId, corsHeaders) {
  try {
    const query = `
      SELECT 
        r.id,
        r.user_id,
        r.rating,
        r.content as review_text,
        r.created_at,
        r.updated_at,
        u.nickname as username,
        u.avatar_url
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.movie_id = ?
      ORDER BY r.created_at DESC
    `;
    
    const result = await db.prepare(query).bind(movieId).all();
    
    if (!result.success) {
      console.error('Query failed:', result);
      return new Response(JSON.stringify({ error: 'Failed to fetch reviews' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const reviews = result.results || [];
    
    // Formatuj daty do czytelnego formatu
    const formattedReviews = reviews.map(review => ({
      id: review.id,
      userId: review.user_id,
      username: review.username || 'Użytkownik',
      avatarUrl: review.avatar_url,
      rating: review.rating || 0,
      reviewText: review.review_text || '',
      createdAt: review.created_at,
      updatedAt: review.updated_at
    }));

    return new Response(JSON.stringify(formattedReviews), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Funkcja pomocnicza do uzyskania ID użytkownika z tokenu
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
