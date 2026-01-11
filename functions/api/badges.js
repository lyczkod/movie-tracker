// Endpoint API dla odznak użytkownika
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

  try {
    const userId = await getUserIdFromRequest(request);
    
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const limit = parseInt(url.searchParams.get('limit')) || null;

    // Pobierz odznaki użytkownika z informacjami o odznace
    let query = `
      SELECT 
        b.id,
        b.name,
        b.description,
        b.image_url,
        ub.level,
        ub.earned_at,
        ub.challenge_participant_id
      FROM user_badges ub
      JOIN badges b ON ub.badge_id = b.id
      WHERE ub.user_id = ?
      ORDER BY ub.earned_at DESC
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    const result = await env.db.prepare(query).bind(userId).all();

    // Przekształć image_url na pełny URL R2 i earned_at do ISO formatu
    const badges = result.results.map(badge => ({
      id: badge.id,
      name: badge.name,
      description: badge.description,
      imageUrl: badge.image_url && badge.image_url.startsWith('http') 
        ? badge.image_url 
        : badge.image_url 
          ? `${env.R2_PUBLIC_URL_BADGES}/${badge.image_url}`
          : null,
      level: badge.level,
      earnedAt: badge.earned_at ? badge.earned_at.replace(' ', 'T') : null,
      challengeParticipantId: badge.challenge_participant_id
    }));

    return new Response(JSON.stringify(badges), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error fetching badges:', error);
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
