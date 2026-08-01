// Vercel Serverless Function — AI Diagram Search.
// Searches the web for manufacturer exploded-view parts diagrams, using
// GOOGLE GEMINI with Google Search grounding.
//
// Drop-in replacement for the old Anthropic version: same URL, same request
// ({brand, model}) and same response shape, so NO changes are needed in
// maintenance_system.html.
//
// ── SETUP ─────────────────────────────────────────────────────────────────
// Uses the SAME GEMINI_API_KEY you already added for extract-parts-list.js.
// Nothing new to configure — just save this file at api/search-diagram.js
// and redeploy. ANTHROPIC_API_KEY is no longer needed anywhere and can be
// removed from your Vercel environment variables.
//
// Model selection is automatic (same approach as extract-parts-list.js), so
// it keeps working when Google renames or retires models. Set the optional
// GEMINI_MODEL env var to pin a specific one.

let cachedModel = null;
let cachedModelAt = 0;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

async function pickModel(apiKey) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (cachedModel && (Date.now() - cachedModelAt) < MODEL_TTL_MS) return cachedModel;

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey }
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    throw new Error('Could not list available Gemini models: ' + msg);
  }

  const usable = (data.models || []).filter(m =>
    (m.supportedGenerationMethods || []).includes('generateContent') &&
    !/embedding|aqa|tts|image|audio|video|robotics|learnlm|gemma/i.test(m.name)
  );
  if (!usable.length) throw new Error('No Gemini models available to this API key.');

  const versionOf = name => {
    const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
    return m ? parseFloat(m[1]) : 0;
  };
  const score = m => {
    const n = m.name;
    let s = versionOf(n) * 100;
    if (/flash/i.test(n)) s += 50;
    if (/lite/i.test(n)) s -= 20;
    if (/preview|exp/i.test(n)) s -= 30;
    return s;
  };
  usable.sort((a, b) => score(b) - score(a));

  cachedModel = usable[0].name.replace(/^models\//, '');
  cachedModelAt = Date.now();
  return cachedModel;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { brand, model: equipModel } = req.body || {};
  if (!brand || !equipModel) {
    return res.status(400).json({ error: 'brand and model are required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server not configured: the GEMINI_API_KEY environment variable is missing. Add it in your Vercel project settings (free key at aistudio.google.com/app/apikey).'
    });
  }

  try {
    const geminiModel = await pickModel(apiKey);

    const prompt =
      'You are a commercial kitchen and refrigeration equipment parts expert. ' +
      'Using Google Search, find the official exploded-view spare parts diagram for this equipment:\n' +
      'Brand / Manufacturer: ' + brand + '\n' +
      'Model: ' + equipModel + '\n\n' +
      'Search the manufacturer\'s own spare-parts portal, service manual PDFs, and parts distributor sites. ' +
      'Prefer official manufacturer sources and direct links to PDF parts catalogues.\n\n' +
      'Reply with ONLY a JSON object (no explanations, no markdown fences) shaped exactly like this:\n' +
      '{"found": true, "equipment_name": "...", "manufacturer_parts_url": "https://... or null", ' +
      '"direct_image_urls": ["https://...", "..."], ' +
      '"results": [{"title": "...", "url": "https://...", "type": "pdf|image|page", "description": "...", "relevance": "high|medium|low"}], ' +
      '"tips": "short practical advice for finding this specific parts diagram"}\n' +
      'Set "found" to false and still return the same shape if nothing relevant exists. ' +
      'Only include URLs you actually saw in the search results — never invent one.';

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                encodeURIComponent(geminiModel) + ':generateContent';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Google Search grounding — the Gemini equivalent of a web search tool
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 4096 }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 404) { cachedModel = null; cachedModelAt = 0; }
      const msg = (data && data.error && data.error.message) || ('Gemini API error (HTTP ' + response.status + ')');
      return res.status(response.status).json({ error: msg + ' [model: ' + geminiModel + ']', details: data });
    }

    // Collect the model's text output
    let text = '';
    try {
      const cand = data.candidates && data.candidates[0];
      const cparts = cand && cand.content && cand.content.parts;
      if (cparts) text = cparts.map(p => p.text || '').join('');
    } catch (e) { /* handled below */ }

    // Also collect the real source links Google Search actually returned, so
    // there's something useful to show even if the JSON comes back malformed.
    const grounded = [];
    try {
      const gm = data.candidates && data.candidates[0] && data.candidates[0].groundingMetadata;
      const chunks = (gm && gm.groundingChunks) || [];
      chunks.forEach(c => {
        const w = c.web;
        if (w && w.uri) {
          grounded.push({
            title: w.title || w.uri,
            url: w.uri,
            type: /\.pdf(\?|$)/i.test(w.uri) ? 'pdf' : 'page',
            description: 'From Google Search results',
            relevance: 'medium'
          });
        }
      });
    } catch (e) { /* grounding metadata is optional */ }

    let parsed = null;
    if (text.trim()) {
      let clean = text.trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '');
      // Be forgiving: pull out the outermost JSON object if there's stray prose
      if (clean[0] !== '{') {
        const first = clean.indexOf('{');
        const last = clean.lastIndexOf('}');
        if (first !== -1 && last > first) clean = clean.slice(first, last + 1);
      }
      try { parsed = JSON.parse(clean); } catch (e) { parsed = null; }
    }

    if (!parsed) {
      // Couldn't parse structured output — fall back to the grounded links
      return res.status(200).json({
        found: grounded.length > 0,
        equipment_name: brand + ' ' + equipModel,
        manufacturer_parts_url: null,
        direct_image_urls: [],
        results: grounded,
        tips: grounded.length
          ? 'These are the web sources found for this model. Open them to locate the parts diagram.'
          : 'No parts diagram was found automatically. Try the manufacturer\'s own spare-parts portal, or upload the diagram manually.',
        model: geminiModel
      });
    }

    // Merge in any grounded sources the model didn't already list
    const out = {
      found: parsed.found !== undefined ? parsed.found : true,
      equipment_name: parsed.equipment_name || (brand + ' ' + equipModel),
      manufacturer_parts_url: parsed.manufacturer_parts_url || null,
      direct_image_urls: Array.isArray(parsed.direct_image_urls) ? parsed.direct_image_urls : [],
      results: Array.isArray(parsed.results) ? parsed.results : [],
      tips: parsed.tips || '',
      model: geminiModel
    };
    const seen = new Set(out.results.map(r => r && r.url));
    grounded.forEach(g => { if (!seen.has(g.url)) { out.results.push(g); seen.add(g.url); } });
    if (out.results.length) out.found = true;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
