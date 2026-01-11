// Endpoint administracyjny do zarządzania pojedynczymi odznakami
export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;
  const badgeId = params.id;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Sprawdź czy użytkownik jest administratorem
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
        return handleGetBadge(env.db, badgeId, corsHeaders);
      case 'PUT':
        return handleUpdateBadge(env.db, request, badgeId, corsHeaders);
      case 'DELETE':
        return handleDeleteBadge(env.db, badgeId, corsHeaders);
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

// Pobierz konkretną odznakę
async function handleGetBadge(db, badgeId, corsHeaders) {
  const badge = await db.prepare('SELECT * FROM badges WHERE id = ?').bind(badgeId).first();
  
  if (!badge) {
    return new Response(JSON.stringify({ error: 'Badge not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify(badge), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Zaktualizuj odznakę
async function handleUpdateBadge(db, request, badgeId, corsHeaders) {
  const data = await request.json();
  
  const updates = [];
  const values = [];
  
  if (data.name !== undefined) {
    updates.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push('description = ?');
    values.push(data.description);
  }
  if (data.image_url !== undefined) {
    updates.push('image_url = ?');
    values.push(data.image_url);
  }
  
  if (updates.length === 0) {
    return new Response(JSON.stringify({ error: 'No fields to update' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  values.push(badgeId);
  
  await db.prepare(`
    UPDATE badges 
    SET ${updates.join(', ')}
    WHERE id = ?
  `).bind(...values).run();

  return new Response(JSON.stringify({ success: true, id: badgeId }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Usuń odznakę
async function handleDeleteBadge(db, badgeId, corsHeaders) {
  // Sprawdź czy odznaka jest używana w wyzwaniach
  const challenges = await db.prepare('SELECT COUNT(*) as count FROM challenges WHERE badge_silver_id = ? OR badge_gold_id = ? OR badge_platinum_id = ?').bind(badgeId, badgeId, badgeId).first();
  
  if (challenges.count > 0) {
    return new Response(JSON.stringify({ 
      error: 'Cannot delete badge that is used in challenges',
      challenges: challenges.count
    }), {
      status: 409,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  await db.prepare('DELETE FROM badges WHERE id = ?').bind(badgeId).run();

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
