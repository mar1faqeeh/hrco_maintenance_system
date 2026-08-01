// Vercel Serverless Function — AI Diagram Search.
// Searches the web for manufacturer exploded-view parts diagrams, using
// GOOGLE GEMINI with Google Search grounding.
//
// Drop-in replacement for the old Anthropic version: same URL, same request
// ({brand, model}) and same response shape.
//
// ── SETUP ─────────────────────────────────────────────────────────────────
// Uses the SAME GEMINI_API_KEY you already added for extract-parts-list.js.
// Nothing new to configure — save this file at api/search-diagram.js and
// redeploy. ANTHROPIC_API_KEY is no longer needed anywhere.
//
// You do NOT need to choose a model or an API version. This discovers the
// models your key can use and tries them over BOTH Google API styles (the new
// Interactions API and the legacy generateContent endpoint) until one answers.
// To pin a model anyway, set the optional GEMINI_MODEL environment variable.

// ── Gemini transport ─────────────────────────────────────────────────────
// Google is migrating from the legacy `:generateContent` endpoint to the new
// `/interactions` endpoint, and which one a given model accepts changes over
// time. So instead of committing to either, we describe the job abstractly
// and try BOTH shapes, across every model the key can see, until one answers.

let cachedRoute = null;   // { model, api } that last worked
let cachedRouteAt = 0;
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;

const API_REVISION = '2026-05-20';

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
    !/embedding|aqa|tts|image|audio|video|robotics|learnlm|gemma|lyria|nano-banana|computer-use|deep-research|antigravity/i.test(m.name)
  );
  if (!usable.length) throw new Error('No Gemini models available to this API key.');

  const versionOf = name => {
    const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
    return m ? parseFloat(m[1]) : 0;
  };
  // Cheap, free-tier-friendly models first. Newest is usually paid-only, so
  // version is only a mild tie-breaker.
  const score = m => {
    const n = m.name;
    let s = 0;
    if (/flash/i.test(n)) s += 100;
    if (/lite/i.test(n)) s += 40;
    if (/pro/i.test(n)) s -= 60;
    if (/preview|exp/i.test(n)) s -= 30;
    if (/latest/i.test(n)) s += 10;
    s += versionOf(n);
    return s;
  };
  usable.sort((a, b) => score(b) - score(a));
  return usable.map(m => m.name.replace(/^models\//, ''));
}

// spec: { parts:[{text}|{image:{mime,data}}], json:bool, search:bool, maxTokens:int }
function buildInteractionsBody(model, spec, withTools) {
  const input = spec.parts.map(p =>
    p.image ? { type: 'image', mime_type: p.image.mime, data: p.image.data }
            : { type: 'text', text: p.text }
  );
  const body = { model: model, input: input, store: false };
  if (spec.json) body.response_format = { type: 'text', mime_type: 'application/json' };
  if (spec.search && withTools) body.tools = [{ type: 'google_search' }];
  return body;
}

function buildGenerateContentBody(spec, withTools) {
  const parts = spec.parts.map(p =>
    p.image ? { inline_data: { mime_type: p.image.mime, data: p.image.data } }
            : { text: p.text }
  );
  const body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { maxOutputTokens: spec.maxTokens || 4096 }
  };
  if (spec.json) body.generationConfig.responseMimeType = 'application/json';
  if (spec.search && withTools) body.tools = [{ google_search: {} }];
  return body;
}

// Pulls the model's text out of either response shape.
function extractText(data) {
  let text = '';
  try {
    if (Array.isArray(data.steps)) {                 // Interactions API
      data.steps.forEach(step => {
        if (step && step.type === 'model_output' && Array.isArray(step.content)) {
          step.content.forEach(c => { if (c && c.type === 'text' && c.text) text += c.text; });
        }
      });
      if (!text && typeof data.output_text === 'string') text = data.output_text;
    }
    if (!text && data.candidates) {                  // generateContent API
      const cparts = data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      if (cparts) text = cparts.map(p => p.text || '').join('');
    }
  } catch (e) { /* caller handles empty text */ }
  return text;
}

// Pulls any web sources the search tool cited, from either shape.
function extractSources(data) {
  const out = [];
  const push = (uri, title) => {
    if (uri && !out.some(o => o.url === uri)) {
      out.push({
        title: title || uri,
        url: uri,
        type: /\.pdf(\?|$)/i.test(uri) ? 'pdf' : 'page',
        description: 'From Google Search results',
        relevance: 'medium'
      });
    }
  };
  try {
    const gm = data.candidates && data.candidates[0] && data.candidates[0].groundingMetadata;
    ((gm && gm.groundingChunks) || []).forEach(c => { if (c.web) push(c.web.uri, c.web.title); });
  } catch (e) {}
  try {
    (data.steps || []).forEach(step => {
      const scan = obj => {
        if (!obj || typeof obj !== 'object') return;
        if (typeof obj.uri === 'string') push(obj.uri, obj.title);
        if (typeof obj.url === 'string') push(obj.url, obj.title);
        Object.keys(obj).forEach(k => scan(obj[k]));
      };
      scan(step);
    });
  } catch (e) {}
  return out;
}

function isRetryable(message, status) {
  if (status === 404 || status === 429 || status === 400) return true;
  return /Interactions API|generateContent|no longer available|not supported|not found|quota|unsupported|invalid/i.test(message || '');
}

async function postJson(url, apiKey, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const response = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, data: data };
  const message = (data && data.error && data.error.message) ||
                  ('Gemini API error (HTTP ' + response.status + ')');
  return { ok: false, status: response.status, message: message };
}

// Tries one model over one API style, dropping the search tool if the model
// accepts the call but rejects that specific tool.
async function tryRoute(apiKey, model, api, spec) {
  for (const withTools of (spec.search ? [true, false] : [false])) {
    let r;
    if (api === 'interactions') {
      r = await postJson('https://generativelanguage.googleapis.com/v1beta/interactions',
                         apiKey, buildInteractionsBody(model, spec, withTools),
                         { 'Api-Revision': API_REVISION });
    } else {
      r = await postJson('https://generativelanguage.googleapis.com/v1beta/models/' +
                         encodeURIComponent(model) + ':generateContent',
                         apiKey, buildGenerateContentBody(spec, withTools));
    }
    if (r.ok) return r;
    // Only worth retrying without tools if the tool itself was the problem
    if (withTools && /tool|search|grounding/i.test(r.message || '')) continue;
    return r;
  }
}

async function callGemini(apiKey, spec) {
  const attempts = [];
  const tried = [];
  let lastMessage = '', lastStatus = 500;

  if (process.env.GEMINI_MODEL) {
    for (const api of ['interactions', 'generateContent']) {
      attempts.push({ model: process.env.GEMINI_MODEL, api: api });
    }
  } else {
    if (cachedRoute && (Date.now() - cachedRouteAt) < ROUTE_TTL_MS) {
      attempts.push(cachedRoute);
    }
    const models = await listCandidateModels(apiKey);
    // New API first — the legacy endpoint is being retired model by model.
    models.forEach(m => attempts.push({ model: m, api: 'interactions' }));
    models.forEach(m => attempts.push({ model: m, api: 'generateContent' }));
  }

  for (const attempt of attempts) {
    const r = await tryRoute(apiKey, attempt.model, attempt.api, spec);
    if (r.ok) {
      cachedRoute = attempt;
      cachedRouteAt = Date.now();
      return { data: r.data, model: attempt.model, api: attempt.api };
    }
    lastMessage = r.message;
    lastStatus = r.status;
    tried.push(attempt.model + '/' + attempt.api);
    if (cachedRoute && cachedRoute.model === attempt.model && cachedRoute.api === attempt.api) {
      cachedRoute = null; cachedRouteAt = 0;
    }
    if (!isRetryable(r.message, r.status)) break;
  }

  const err = new Error(
    (lastMessage || 'All available Gemini models failed.') +
    (tried.length ? ' [tried ' + tried.length + ' routes, e.g. ' + tried.slice(0, 3).join(', ') + ']' : '')
  );
  err.status = lastStatus;
  throw err;
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

    const result = await callGemini(apiKey, {
      parts: [{ text: prompt }],
      json: false,      // grounded search + strict JSON mode can conflict; we parse leniently instead
      search: true,
      maxTokens: 4096
    });

    const geminiModel = result.model;
    const text = extractText(result.data);
    const grounded = extractSources(result.data);

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
        model: geminiModel, api: result.api
      });
    }

    const out = {
      found: parsed.found !== undefined ? parsed.found : true,
      equipment_name: parsed.equipment_name || (brand + ' ' + equipModel),
      manufacturer_parts_url: parsed.manufacturer_parts_url || null,
      direct_image_urls: Array.isArray(parsed.direct_image_urls) ? parsed.direct_image_urls : [],
      results: Array.isArray(parsed.results) ? parsed.results : [],
      tips: parsed.tips || '',
      model: geminiModel, api: result.api
    };
    const seen = new Set(out.results.map(r => r && r.url));
    grounded.forEach(g => { if (!seen.has(g.url)) { out.results.push(g); seen.add(g.url); } });
    if (out.results.length) out.found = true;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
