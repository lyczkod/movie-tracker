// Endpoint rejestracji użytkownika
export async function onRequestPost(context) {
  const { request, env } = context;

  // Nagłówki CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { nickname, email, password } = await request.json();

    if (!nickname || !email || !password) {
      return new Response(JSON.stringify({ error: 'All fields required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Walidacja formatu email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Sprawdź czy użytkownik istnieje
    const existingUser = await env.db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existingUser) {
      return new Response(JSON.stringify({ error: 'User already exists' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Zahaszuj hasło
    const passwordHash = await hashPassword(password);

    // Wstaw użytkownika
    const result = await env.db.prepare(`
      INSERT INTO users (nickname, email, password_hash)
      VALUES (?, ?, ?)
    `).bind(nickname, email, passwordHash).run();

    const userId = result.meta.last_row_id;
    const token = await generateSimpleToken(userId, email);

    return new Response(JSON.stringify({
      user: { id: userId, nickname, email, theme_preference: 'light' },
      token
    }), {
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

// Zahaszuj hasło używając PBKDF2 z solą
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    256
  );
  
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const saltArray = Array.from(salt);
  
  // Połącz sól i hasz
  return saltArray.concat(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generuj prosty token podobny do JWT
async function generateSimpleToken(userId, email) {
  const payload = { userId, email, exp: Date.now() + (12 * 60 * 60 * 1000) }; // 12 godzin
  return btoa(JSON.stringify(payload));
}