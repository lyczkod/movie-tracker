export async function onRequest(context) {
    const { request, env, params } = context;
    const method = request.method;
    const reviewId = params.id;

    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
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

        // DELETE - usuń recenzję
        if (method === 'DELETE') {
            // Usuń recenzję całkowicie
            const deleteStmt = env.db.prepare(`
                DELETE FROM reviews
                WHERE id = ?
            `).bind(reviewId);
            
            await deleteStmt.run();
            
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        return new Response(JSON.stringify({ error: 'Metoda nieobsługiwana' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error in admin review by ID API:', error);
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
