// Endpoint usuwania konta użytkownika
export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (method !== 'DELETE') {
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

    // Pobierz avatar_url użytkownika przed usunięciem
    const user = await env.db.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(userId).first();

    // Usuń avatar z R2 jeśli istnieje
    if (user && user.avatar_url && user.avatar_url.includes(env.R2_PUBLIC_URL)) {
      const avatarKey = user.avatar_url.replace(`${env.R2_PUBLIC_URL}/`, '');
      try {
        await env.AVATARS.delete(avatarKey);
      } catch (e) {
        console.warn('Failed to delete avatar from R2:', e);
      }
    }

    // Usuń wszystkie dane użytkownika (kaskadowo przez FOREIGN KEY)
    // Kolejność usuwania jest ważna ze względu na foreign keys
    await env.db.prepare('DELETE FROM user_badges WHERE user_id = ?').bind(userId).run();
    await env.db.prepare('DELETE FROM challenge_participants WHERE user_id = ?').bind(userId).run();
    await env.db.prepare('DELETE FROM friends WHERE user1_id = ? OR user2_id = ?').bind(userId, userId).run();
    await env.db.prepare('DELETE FROM reviews WHERE user_id = ?').bind(userId).run();
    await env.db.prepare('DELETE FROM user_episodes_watched WHERE user_id = ?').bind(userId).run();
    await env.db.prepare('DELETE FROM watched WHERE user_id = ?').bind(userId).run();
    await env.db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

    return new Response(JSON.stringify({ 
      success: true,
      message: 'Account deleted successfully'
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error deleting account:', error);
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
