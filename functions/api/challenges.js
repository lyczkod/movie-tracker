// Endpoint API do przeglądania wyzwań
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  // Nagłówki CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405,
      headers: corsHeaders 
    });
  }

  try {
    // Sprawdź uwierzytelnienie
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Pobierz wyzwania z informacją o uczestnictwie i postępie
    const result = await env.db.prepare(`
      SELECT 
        c.id,
        c.title,
        c.description,
        c.target_silver,
        c.target_gold,
        c.target_platinum,
        c.type as challenge_type,
        c.criteria_value,
        c.start_date,
        c.end_date,
        c.badge_silver_id,
        c.badge_gold_id,
        c.badge_platinum_id,
        cp.id as participant_id,
        cp.joined_at,
        cp.completed_silver_at,
        cp.completed_gold_at,
        cp.completed_platinum_at,
        CASE 
          WHEN date('now') < c.start_date THEN 'upcoming'
          WHEN date('now') > c.end_date THEN 'expired'
          ELSE 'active'
        END as status
      FROM challenges c
      LEFT JOIN challenge_participants cp ON c.id = cp.challenge_id AND cp.user_id = ?
      ORDER BY 
        CASE 
          WHEN cp.id IS NOT NULL AND cp.completed_platinum_at IS NULL THEN 0
          WHEN date('now') BETWEEN c.start_date AND c.end_date THEN 1
          WHEN date('now') < c.start_date THEN 2
          ELSE 3
        END,
        c.end_date ASC
    `).bind(userId).all();

    // Dla każdego wyzwania oblicz aktualny postęp użytkownika
    const challengesWithProgress = await Promise.all(result.results.map(async (row) => {
      let progress = 0;
      
      if (row.participant_id) {
        // Oblicz postęp na podstawie obejrzanych filmów
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
          row.start_date,
          row.end_date,
          row.challenge_type,
          row.challenge_type,
          row.challenge_type,
          row.criteria_value,
          row.challenge_type
        ).first();
        
        progress = progressResult ? progressResult.count : 0;
      }
      
      // Określ aktualny tier użytkownika
      let currentTier = 'none';
      let targetForDisplay = row.target_platinum || row.target_gold || row.target_silver || 0;
      
      // Ogranicz progress do maksymalnego targetu
      if (progress > targetForDisplay && targetForDisplay > 0) {
        progress = targetForDisplay;
      }
      
      if (row.completed_platinum_at) {
        currentTier = 'platinum';
      } else if (row.completed_gold_at) {
        currentTier = 'gold';
      } else if (row.completed_silver_at) {
        currentTier = 'silver';
      }
      
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        target_silver: row.target_silver,
        target_gold: row.target_gold,
        target_platinum: row.target_platinum,
        progress: progress,
        type: row.challenge_type,
        criteria_value: row.criteria_value,
        start_date: row.start_date,
        end_date: row.end_date,
        status: row.status,
        is_participant: !!row.participant_id,
        completed_silver_at: row.completed_silver_at,
        completed_gold_at: row.completed_gold_at,
        completed_platinum_at: row.completed_platinum_at,
        current_tier: currentTier,
        badge_silver_id: row.badge_silver_id,
        badge_gold_id: row.badge_gold_id,
        badge_platinum_id: row.badge_platinum_id,
        percentage: targetForDisplay > 0 ? Math.round((progress / targetForDisplay) * 100) : 0
      };
    }));

    return new Response(JSON.stringify(challengesWithProgress), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
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
      return null; // Token wygasł
    }
    
    return payload.userId;
  } catch {
    return null;
  }
}