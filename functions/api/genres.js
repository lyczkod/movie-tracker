// Endpoint zwracający unikalne gatunki filmów
function normalizeGenre(genre) {
  if (!genre || typeof genre !== 'string') return '';
  return genre.split(/[,;|]+/)
    .map(s => s.trim())
    .map(s => s.replace(/_/g, ' '))
    .map(s => {
      const key = s.toLowerCase().trim().replace(/_/g, ' ');
      if (key === 'science fiction' || key === 'science_fiction' || key === 'science-fiction' || key === 'sci fi') return 'Sci-Fi';
      if (key === 'drama' || key === 'dramat') return 'Dramat';
      // Dodaj więcej reguł normalizacji według potrzeb
      return s.replace(/_/g, ' ');
    })
    .filter(Boolean)
    .join(', ');
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (method !== 'GET') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    // Pobierz wszystkie niepuste ciągi gatunków
    const result = await env.db.prepare(`SELECT genre FROM movies WHERE genre IS NOT NULL AND genre != ''`).all();
    const unique = new Set();

    if (result && Array.isArray(result.results)) {
      result.results.forEach(r => {
        const normalized = normalizeGenre(r.genre || '');
        normalized.split(/,\s*/).map(s => s.trim()).filter(Boolean).forEach(s => unique.add(s));
      });
    }

    const arr = Array.from(unique).sort((a,b) => a.localeCompare(b, 'pl'));
    return new Response(JSON.stringify(arr), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('genres API error', error);
    return new Response(JSON.stringify({ error: 'Failed to load genres' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
