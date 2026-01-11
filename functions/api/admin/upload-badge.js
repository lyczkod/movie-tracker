// Upload ikony odznaki do R2
export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
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

    // Parsuj FormData
    const formData = await request.formData();
    const file = formData.get('badge');

    if (!file) {
      return new Response(JSON.stringify({ error: 'Badge image is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Waliduj typ pliku
    if (!file.type.startsWith('image/')) {
      return new Response(JSON.stringify({ error: 'Invalid image format. Only images allowed.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Waliduj rozmiar pliku (max 1MB)
    if (file.size > 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'File size must be less than 1MB' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Wygeneruj unikalną nazwę pliku
    const extension = file.name.split('.').pop() || 'png';
    const filename = `badges/badge-${Date.now()}.${extension}`;

    // Prześlij do R2
    const arrayBuffer = await file.arrayBuffer();
    await env.BADGES.put(filename, arrayBuffer, {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // Publiczny URL
    const badgeUrl = `${env.R2_PUBLIC_URL_BADGES}/${filename}`;

    return new Response(JSON.stringify({ 
      success: true,
      url: badgeUrl,
      key: filename
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Badge upload error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
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
