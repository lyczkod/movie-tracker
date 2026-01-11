// Punkt końcowy admina do zarządzania pojedynczymi wyzwaniami
export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const challengeId = params.id;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Sprawdź czy użytkownik jest adminem
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
        return handleGetChallenge(env.db, challengeId, corsHeaders);
      case 'PUT':
        return handleUpdateChallenge(env.db, request, challengeId, corsHeaders);
      case 'DELETE':
        return handleDeleteChallenge(env.db, challengeId, corsHeaders);
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

// Pobierz konkretne wyzwanie
async function handleGetChallenge(db, challengeId, corsHeaders) {
  const challenge = await db.prepare('SELECT * FROM challenges WHERE id = ?').bind(challengeId).first();
  
  if (!challenge) {
    return new Response(JSON.stringify({ error: 'Challenge not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify(challenge), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Zaktualizuj wyzwanie
async function handleUpdateChallenge(db, request, challengeId, corsHeaders) {
  const data = await request.json();
  
  const updates = [];
  const values = [];
  
  if (data.title !== undefined) {
    updates.push('title = ?');
    values.push(data.title);
  }
  if (data.description !== undefined) {
    updates.push('description = ?');
    values.push(data.description);
  }
  if (data.type !== undefined) {
    updates.push('type = ?');
    values.push(data.type);
  }
  if (data.criteria_value !== undefined) {
    updates.push('criteria_value = ?');
    values.push(data.criteria_value);
  }
  if (data.target_silver !== undefined) {
    updates.push('target_silver = ?');
    values.push(data.target_silver);
  }
  if (data.target_gold !== undefined) {
    updates.push('target_gold = ?');
    values.push(data.target_gold);
  }
  if (data.target_platinum !== undefined) {
    updates.push('target_platinum = ?');
    values.push(data.target_platinum);
  }
  if (data.start_date !== undefined) {
    updates.push('start_date = ?');
    values.push(data.start_date);
  }
  if (data.end_date !== undefined) {
    updates.push('end_date = ?');
    values.push(data.end_date);
  }
  if (data.badge_silver_id !== undefined) {
    updates.push('badge_silver_id = ?');
    values.push(data.badge_silver_id);
  }
  if (data.badge_gold_id !== undefined) {
    updates.push('badge_gold_id = ?');
    values.push(data.badge_gold_id);
  }
  if (data.badge_platinum_id !== undefined) {
    updates.push('badge_platinum_id = ?');
    values.push(data.badge_platinum_id);
  }
  
  if (updates.length === 0) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  values.push(challengeId);
  
  await db.prepare(`
    UPDATE challenges 
    SET ${updates.join(', ')}
    WHERE id = ?
  `).bind(...values).run();

  return new Response(JSON.stringify({ success: true, id: challengeId }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Usuń wyzwanie
async function handleDeleteChallenge(db, challengeId, corsHeaders) {
  // Sprawdź czy wyzwanie ma uczestników
  const participants = await db.prepare('SELECT COUNT(*) as count FROM challenge_participants WHERE challenge_id = ?').bind(challengeId).first();
  
  if (participants.count > 0) {
    return new Response(JSON.stringify({ 
      error: 'Cannot delete challenge with participants',
      participants: participants.count
    }), {
      status: 409,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  await db.prepare('DELETE FROM challenges WHERE id = ?').bind(challengeId).run();

  return new Response(JSON.stringify({ success: true }), {
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
  } catch (error) {
    return null;
  }
}
