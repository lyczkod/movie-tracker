// Endpoint dla pojedynczego wyzwania - dołączanie, opuszczanie, sprawdzanie statusu
export async function onRequest(context) {
  const { request, env, params } = context;
  const challengeId = params.id;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
        return handleGetChallengeDetails(env, challengeId, userId, corsHeaders);
      case 'POST':
        return handleJoinChallenge(env, challengeId, userId, corsHeaders);
      case 'DELETE':
        return handleLeaveChallenge(env, challengeId, userId, corsHeaders);
      default:
        return new Response('Method not allowed', { 
          status: 405,
          headers: corsHeaders 
        });
    }
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Pobierz szczegóły wyzwania z postępem użytkownika
async function handleGetChallengeDetails(env, challengeId, userId, corsHeaders) {
  const challenge = await env.db.prepare(`
    SELECT 
      c.*,
      cp.id as participant_id,
      cp.progress,
      cp.completed_silver_at,
      cp.completed_gold_at,
      cp.completed_platinum_at,
      cp.joined_at
    FROM challenges c
    LEFT JOIN challenge_participants cp ON c.id = cp.challenge_id AND cp.user_id = ?
    WHERE c.id = ?
  `).bind(userId, challengeId).first();

  if (!challenge) {
    return new Response(JSON.stringify({ error: 'Challenge not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Oblicz aktualny postęp na podstawie obejrzanych filmów
  const progressResult = await env.db.prepare(`
    SELECT COUNT(DISTINCT w.id) as count
    FROM watched w
    JOIN movies m ON w.movie_id = m.id
    WHERE w.user_id = ?
    AND w.watched_date BETWEEN ? AND COALESCE(?, date('now'))
    AND (
      (? = 'movies' AND m.media_type = 'movie') OR
      (? = 'series' AND m.media_type = 'series') OR
      (? = 'genre' AND m.genre = ?) OR
      ? = 'both'
    )
  `).bind(
    userId,
    challenge.start_date,
    challenge.end_date,
    challenge.type,
    challenge.type,
    challenge.type,
    challenge.criteria_value,
    challenge.type
  ).first();

  const actualProgress = progressResult ? progressResult.count : 0;
  
  // Określ najwyższy cel dla procentu
  const maxTarget = challenge.target_platinum || challenge.target_gold || challenge.target_silver || 0;

  return new Response(JSON.stringify({
    ...challenge,
    is_participant: !!challenge.participant_id,
    progress: actualProgress,
    percentage: maxTarget > 0 ? Math.round((actualProgress / maxTarget) * 100) : 0
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Dołącz do wyzwania
async function handleJoinChallenge(env, challengeId, userId, corsHeaders) {
  // Sprawdź czy wyzwanie istnieje
  const challenge = await env.db.prepare('SELECT * FROM challenges WHERE id = ?').bind(challengeId).first();
  
  if (!challenge) {
    return new Response(JSON.stringify({ error: 'Challenge not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Sprawdź czy użytkownik już uczestniczy
  const existing = await env.db.prepare(
    'SELECT id FROM challenge_participants WHERE challenge_id = ? AND user_id = ?'
  ).bind(challengeId, userId).first();

  if (existing) {
    return new Response(JSON.stringify({ error: 'Already participating' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Dodaj uczestnika
  await env.db.prepare(`
    INSERT INTO challenge_participants (challenge_id, user_id, progress)
    VALUES (?, ?, 0)
  `).bind(challengeId, userId).run();

  return new Response(JSON.stringify({ 
    success: true,
    message: 'Successfully joined challenge'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Opuść wyzwanie
async function handleLeaveChallenge(env, challengeId, userId, corsHeaders) {
  const result = await env.db.prepare(
    'DELETE FROM challenge_participants WHERE challenge_id = ? AND user_id = ?'
  ).bind(challengeId, userId).run();

  if (result.meta.changes === 0) {
    return new Response(JSON.stringify({ error: 'Not participating in this challenge' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ 
    success: true,
    message: 'Successfully left challenge'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
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
  } catch (e) {
    return null;
  }
}
