// Vercel Serverless Function — AI Diagram Search.
// Searches the web for manufacturer exploded-view parts diagrams, using
// GOOGLE GEMINI with Google Search grounding.
//
// Drop-in replacement for the old Anthropic version: same URL, same request
// ({brand, model}) and same response shape.
//
// ── SETUP ─────────────────────────────────────────────────────────────────
// Uses the SAME GEMINI_API_KEY you already added for extract-parts-list.js.
// Nothing new to configure — just save this file at api/search-diagram.js
// and redeploy. ANTHROPIC_API_KEY is no longer needed anywhere.
//
// You do NOT need to pick a model. This asks Google which models your key can
// use, then tries them cheapest-first until one answers — so it keeps working
// when Google renames models, retires them, or makes the newest one paid-only.
// To pin one anyway, set the optional GEMINI_MODEL environment variable.

// ── Model selection with automatic fallback ──────────────────────────────
// Google keeps renaming/retiring models, and the newest model is usually
// PAID-ONLY while older "flash"/"lite" ones stay on the free tier. So instead
// of betting on one name, we rank every model the key can see and try them in
// order until one actually answers — then remember that one.

let cachedModel = null;
let cachedModelAt = 0;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

async function listCandidateModels(apiKey) {
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
  // Cheap, widely free-tier-eligible models first: "lite" and "flash" beat
  // "pro", and we do NOT chase the newest version — brand-new releases are
  // typically paid-only, which is exactly what blows the free quota.
  const score = m => {
    const n = m.name;
    let s = 0;
    if (/flash/i.test(n)) s += 100;
    if (/lite/i.test(n)) s += 40;
    if (/pro/i.test(n)) s -= 60;
    if (/preview|exp/i.test(n)) s -= 30;
    s += versionOf(n); // mild tie-breaker only
    return s;
  };
  usable.sort((a, b) => score(b) - score(a));
  return usable.map(m => m.name.replace(/^models\//, ''));
}

// Calls generateContent, walking down the candidate list whenever a model is
// missing (404) or out of quota on this plan (429), so a paid-only or retired
// model never becomes a dead end.
async function callGemini(apiKey, buildBody) {
  if (process.env.GEMINI_MODEL) {
    const forced = process.env.GEMINI_MODEL;
    const r = await tryModel(apiKey, forced, buildBody);
    if (r.ok) return { data: r.data, model: forced };
    throw new Error(r.message + ' [model: ' + forced + ']');
  }

  let candidates;
  if (cachedModel && (Date.now() - cachedModelAt) < MODEL_TTL_MS) {
    candidates = [cachedModel];
  } else {
    candidates = await listCandidateModels(apiKey);
  }

  let lastMessage = '';
  let lastStatus = 500;
  const tried = [];
  for (const name of candidates) {
    const r = await tryModel(apiKey, name, buildBody);
    if (r.ok) {
      cachedModel = name;
      cachedModelAt = Date.now();
      return { data: r.data, model: name };
    }
    lastMessage = r.message;
    lastStatus = r.status;
    tried.push(name);
    if (isRetryable(r)) {
      if (cachedModel === name) { cachedModel = null; cachedModelAt = 0; }
      continue;
    }
    break; // auth errors etc. — trying another model won't help
  }

  // Every candidate failed. If we'd been using a cached model, retry once with
  // the full freshly-listed set before giving up.
  if (candidates.length === 1 && cachedModel === null) {
    const fresh = await listCandidateModels(apiKey);
    for (const name of fresh) {
      const r = await tryModel(apiKey, name, buildBody);
      if (r.ok) {
        cachedModel = name;
        cachedModelAt = Date.now();
        return { data: r.data, model: name };
      }
      lastMessage = r.message;
      lastStatus = r.status;
      tried.push(name);
    }
  }

  const err = new Error(
    (lastMessage || 'All available Gemini models failed.') +
    (tried.length ? ' [tried: ' + tried.join(', ') + ']' : '')
  );
  err.status = lastStatus;
  throw err;
}


// Some models are retired, some are paid-only on this plan, and some only
// work through Google's newer Interactions API. None of those are fatal —
// they just mean "try the next model".
function isRetryable(r) {
  if (r.status === 404 || r.status === 429 || r.status === 400) return true;
  return /Interactions API|no longer available|not supported|not found|quota|unsupported/i.test(r.message || '');
}

async function tryModel(apiKey, modelName, buildBody) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(modelName) + ':generateContent';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(buildBody())
  });
  const data = await response.json();
  if (response.ok) return { ok: true, data: data };
  const message = (data && data.error && data.error.message) ||
                  ('Gemini API error (HTTP ' + response.status + ')');
  return { ok: false, status: response.status, message: message };
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

    const result = await callGemini(apiKey, () => ({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Google Search grounding — the Gemini equivalent of a web search tool
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 4096 }
    }));
    const data = result.data;
    const geminiModel = result.model;

    let text = '';
    try {
      const cand = data.candidates && data.candidates[0];
      const cparts = cand && cand.content && cand.content.parts;
      if (cparts) text = cparts.map(p => p.text || '').join('');
    } catch (e) { /* handled below */ }

    // Collect the real source links Google Search returned, so there's still
    // something useful even if the JSON comes back malformed.
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
      if (clean[0] !== '{') {
        const first = clean.indexOf('{');
        const last = clean.lastIndexOf('}');
        if (first !== -1 && last > first) clean = clean.slice(first, last + 1);
      }
      try { parsed = JSON.parse(clean); } catch (e) { parsed = null; }
    }

    if (!parsed) {
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
    return res.status(e.status || 500).json({ error: e.message });
  }
}
