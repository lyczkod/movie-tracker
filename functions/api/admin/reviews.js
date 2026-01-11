export async function onRequest(context) {
    const { request, env } = context;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

        // GET - pobierz wszystkie recenzje
        if (method === 'GET') {
            try {
                const query = `
                    SELECT 
                        r.id,
                        r.movie_id,
                        r.user_id,
                        r.content as review_text,
                        r.rating,
                        r.created_at,
                        u.nickname as username,
                        m.title as movie_title
                    FROM reviews r
                    LEFT JOIN users u ON r.user_id = u.id
                    LEFT JOIN movies m ON r.movie_id = m.id
                    ORDER BY r.created_at DESC
                `;
                
                const reviewStmt = env.db.prepare(query);
                const result = await reviewStmt.all();
                
                return new Response(JSON.stringify(result.results || []), {
                    status: 200,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            } catch (queryError) {
                console.error('Error executing reviews query:', queryError);
                return new Response(JSON.stringify({ 
                    error: 'Błąd zapytania do bazy danych', 
                    details: queryError.message 
                }), {
                    status: 500,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response(JSON.stringify({ error: 'Metoda nieobsługiwana' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error in admin reviews API:', error);
        return new Response(JSON.stringify({ error: error.message || 'Wewnętrzny błąd serwera' }), {
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
