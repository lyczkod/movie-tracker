// Pobierz informacje o bieżącym użytkowniku
export async function onRequestGet(context) {
  const { request, env } = context;

  // Nagłówki CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const user = await env.db.prepare('SELECT id, nickname, email, role, theme_preference, avatar_url, description, created_at FROM users WHERE id = ?').bind(userId).first();
    if (!user) {
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ user }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Zaktualizuj informacje o użytkowniku
export async function onRequestPut(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const data = await request.json();
    
    // Tylko opis może być aktualizowany przez ten endpoint
    if (data.description !== undefined) {
      const description = data.description ? String(data.description).substring(0, 500) : null;
      
      await env.db.prepare(
        'UPDATE users SET description = ? WHERE id = ?'
      ).bind(description, userId).run();
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Obsługa OPTIONS dla CORS
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

// Wyodrębnij ID użytkownika z tokenu autoryzacyjnego
async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7); // usuwa "Bearer"
    const payload = JSON.parse(atob(token)); // dekoduje Base64
    
    if (payload.exp < Date.now()) {
      return null; // Token wygasł
    }
    
    return payload.userId;
  } catch {
    return null;
  }
}