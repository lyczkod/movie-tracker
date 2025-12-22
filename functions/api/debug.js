// Punkt końcowy debugowania do sprawdzania stanu uwierzytelnienia
export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'GET') {
    return new Response('Method not allowed - use GET', { status: 405 });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization'
  };

  const authHeader = request.headers.get('Authorization');
  
  const debug = {
    hasAuthHeader: !!authHeader,
    authHeader: authHeader,
    startsWithBearer: authHeader ? authHeader.startsWith('Bearer ') : false
  };

  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const payload = JSON.parse(atob(token));
      debug.tokenParsed = true;
      debug.payload = payload;
      debug.expired = payload.exp < Date.now();
      debug.userId = payload.userId;
    } catch (error) {
      debug.tokenParsed = false;
      debug.error = error.message;
    }
  }

  return new Response(JSON.stringify(debug, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}