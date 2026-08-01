// Vercel Serverless Function — AI Diagram Search.
// Searches the web for manufacturer exploded-view parts diagrams using
// GOOGLE GEMINI with Google Search grounding.
//
// Drop-in replacement: same URL, same request ({brand, model}) and response
// shape, so no changes are needed in maintenance_system.html.
//
// ── SETUP ─────────────────────────────────────────────────────────────────
// Uses the SAME GEMINI_API_KEY as extract-parts-list.js — nothing new to
// configure. Save at api/search-diagram.js and redeploy.
//
// ── SELF-TEST ─────────────────────────────────────────────────────────────
// Open in a browser after deploying:
//     https://YOUR-SITE.vercel.app/api/search-diagram
// It reports whether the key works, which model answers, and whether Google
// Search grounding is available on your plan.

// ── Gemini transport ─────────────────────────────────────────────────────
// Google is mid-migration from the legacy `:generateContent` endpoint to the
// new `/interactions` endpoint, and support varies per model and changes over
// time. So we describe the job abstractly and probe: every model, over both
// API styles, and — because optional fields like a forced JSON response
// format or a search tool can make the server reject an otherwise fine
// request — from the richest request body down to the barest one.

let cachedRoute = null;   // { model, api, variant } that last worked
let cachedRouteAt = 0;
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;
const API_REVISION = '2026-05-20';

// Hard limits so a request can never hang: stop probing new routes once the
// time budget is spent, and never walk more than a handful of models.
const TIME_BUDGET_MS = 40000;
const MAX_MODELS_TO_TRY = 4;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request to Google timed out')), ms); })
  ]).finally(() => clearTimeout(timer));
}


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
    !/embedding|aqa|tts|image|audio|video|robotics|learnlm|gemma|lyria|nano-banana|computer-use|deep-research|antigravity|omni/i.test(m.name)
  );
  if (!usable.length) throw new Error('No Gemini models available to this API key.');

  const versionOf = name => {
    const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
    return m ? parseFloat(m[1]) : 0;
  };
  // Cheap, free-tier-friendly models first; newest is usually paid-only, so
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
// opts: { json:bool, tools:bool } — which optional features to include
function buildInteractionsBody(model, spec, opts) {
  const input = spec.parts.map(p =>
    p.image ? { type: 'image', mime_type: p.image.mime, data: p.image.data }
            : { type: 'text', text: p.text }
  );
  const body = { model: model, input: input };
  if (opts.json) body.response_format = { type: 'text', mime_type: 'application/json' };
  if (opts.tools) body.tools = [{ type: 'google_search' }];
  return body;
}

function buildGenerateContentBody(spec, opts) {
  const parts = spec.parts.map(p =>
    p.image ? { inline_data: { mime_type: p.image.mime, data: p.image.data } }
            : { text: p.text }
  );
  const body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { maxOutputTokens: spec.maxTokens || 4096 }
  };
  if (opts.json) body.generationConfig.responseMimeType = 'application/json';
  if (opts.tools) body.tools = [{ google_search: {} }];
  return body;
}

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

function extractSources(data) {
  const out = [];
  const push = (uri, title) => {
    if (uri && typeof uri === 'string' && /^https?:/i.test(uri) && !out.some(o => o.url === uri)) {
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
    const scan = obj => {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.uri === 'string') push(obj.uri, obj.title);
      if (typeof obj.url === 'string') push(obj.url, obj.title);
      Object.keys(obj).forEach(k => scan(obj[k]));
    };
    (data.steps || []).forEach(scan);
  } catch (e) {}
  return out;
}

// A failure worth trying somewhere else, rather than reporting to the user.
// Google returns 500 "Internal error encountered" for request shapes a model
// dislikes, so that counts too.
function isRetryable(message, status) {
  if ([400, 404, 429, 500, 503].indexOf(status) !== -1) return true;
  return /Interactions API|generateContent|no longer available|not supported|not found|quota|unsupported|invalid|internal/i.test(message || '');
}

async function postJson(url, apiKey, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let response;
  try {
    response = await withTimeout(
      fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }), 20000);
  } catch (e) {
    return { ok: false, status: 0, message: 'Network error: ' + e.message };
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { ok: true, data: data };
  const message = (data && data.error && data.error.message) ||
                  ('Gemini API error (HTTP ' + response.status + ')');
  return { ok: false, status: response.status, message: message };
}

// Request-body variants, richest first. Anything optional gets dropped on the
// way down, because a plain request is the most widely accepted.
function variantsFor(spec) {
  const list = [];
  if (spec.json || spec.search) list.push({ json: !!spec.json, tools: !!spec.search });
  if (spec.search) list.push({ json: false, tools: true });
  if (spec.json) list.push({ json: true, tools: false });
  list.push({ json: false, tools: false });
  // de-duplicate
  const seen = {};
  return list.filter(v => {
    const k = v.json + '|' + v.tools;
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}

async function tryRoute(apiKey, model, api, spec, variantIndex) {
  const variants = variantsFor(spec);
  const start = (typeof variantIndex === 'number') ? variantIndex : 0;
  let last = { ok: false, status: 500, message: 'No variant attempted', variant: start };
  for (let i = start; i < variants.length; i++) {
    const opts = variants[i];
    let r;
    if (api === 'interactions') {
      r = await postJson('https://generativelanguage.googleapis.com/v1beta/interactions',
                         apiKey, buildInteractionsBody(model, spec, opts),
                         { 'Api-Revision': API_REVISION });
    } else {
      r = await postJson('https://generativelanguage.googleapis.com/v1beta/models/' +
                         encodeURIComponent(model) + ':generateContent',
                         apiKey, buildGenerateContentBody(spec, opts));
    }
    r.variant = i;
    if (r.ok) return r;
    last = r;
    if (!isRetryable(r.message, r.status)) break; // auth-type failure: stop here
  }
  return last;
}

async function callGemini(apiKey, spec) {
  const attempts = [];
  const tried = [];
  let lastMessage = '', lastStatus = 500;

  if (process.env.GEMINI_MODEL) {
    attempts.push({ model: process.env.GEMINI_MODEL, api: 'interactions' });
    attempts.push({ model: process.env.GEMINI_MODEL, api: 'generateContent' });
  } else {
    if (cachedRoute && (Date.now() - cachedRouteAt) < ROUTE_TTL_MS) attempts.push(cachedRoute);
    const all = await listCandidateModels(apiKey);
    const models = all.slice(0, MAX_MODELS_TO_TRY);
    // New API first — the legacy endpoint is being retired model by model.
    models.forEach(m => attempts.push({ model: m, api: 'interactions' }));
    models.forEach(m => attempts.push({ model: m, api: 'generateContent' }));
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  for (const attempt of attempts) {
    if (Date.now() > deadline) {
      lastMessage = lastMessage || 'Timed out while trying Gemini models.';
      break;
    }
    const r = await tryRoute(apiKey, attempt.model, attempt.api, spec, attempt.variant);
    if (r.ok) {
      cachedRoute = { model: attempt.model, api: attempt.api, variant: r.variant };
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




// "NECE94E" -> "NECE9" / "NECE": strip the trailing size/variant so a close
// relative of the model can be searched when the exact one draws a blank.
function deriveFamily(model) {
  if (!model) return '';
  const m = String(model).trim();
  // Prefer a natural break: "IM-200" -> "IM", "F-801MRJ3-C" -> "F-801MRJ3"
  if (m.indexOf('-') > 0) {
    const head = m.slice(0, m.lastIndexOf('-'));
    if (head.length >= 2 && head.length < m.length) return head;
  }
  if (m.indexOf(' ') > 0) {
    const head = m.slice(0, m.lastIndexOf(' ')).trim();
    if (head.length >= 2) return head;
  }
  // Otherwise the leading letters are the series: "NECE94E" -> "NECE"
  const letters = /^([A-Za-z]+)/.exec(m);
  const base = letters ? letters[1] : '';
  if (base && base.length >= 2 && base.length < m.length) return base;
  return '';
}

function parseLoose(text) {
  if (!text || !text.trim()) return null;
  let clean = text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  if (clean[0] !== '{') {
    const first = clean.indexOf('{');
    const last = clean.lastIndexOf('}');
    if (first !== -1 && last > first) clean = clean.slice(first, last + 1);
  }
  try { return JSON.parse(clean); } catch (e) { return null; }
}

function shapeResult(parsed, brand, equipModel, stageLabel) {
  const results = Array.isArray(parsed.results) ? parsed.results.filter(r => r && r.url) : [];
  if (stageLabel !== 'exact') {
    results.forEach(r => {
      r.description = (r.description ? r.description + ' ' : '') +
        (stageLabel === 'family' ? '(related model family)' : '(brand-level source)');
    });
  }
  return {
    found: parsed.found !== undefined ? !!parsed.found : true,
    equipment_name: parsed.equipment_name || (brand + ' ' + equipModel),
    manufacturer_parts_url: parsed.manufacturer_parts_url || null,
    direct_image_urls: Array.isArray(parsed.direct_image_urls) ? parsed.direct_image_urls : [],
    results: results,
    tips: parsed.tips || ''
  };
}

// Allow Vercel a longer window than the 10s default.
export const maxDuration = 60;

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  // ── Self-test: plain GET in a browser ──────────────────────────────────
  if (req.method === 'GET') {
    if (!apiKey) {
      return res.status(200).json({
        ok: false, step: 'api key',
        problem: 'GEMINI_API_KEY is not set in this project\'s environment variables.',
        fix: 'Vercel → your project → Settings → Environment Variables → add GEMINI_API_KEY, then redeploy.'
      });
    }
    let models = [];
    try { models = await listCandidateModels(apiKey); }
    catch (e) {
      return res.status(200).json({ ok: false, step: 'list models', problem: e.message });
    }
    let plain = null, grounded = null;
    try {
      const p = await callGemini(apiKey, { parts: [{ text: 'Reply with exactly: OK' }], maxTokens: 32 });
      plain = { model: p.model, api: p.api, reply: extractText(p.data).trim().slice(0, 60) };
    } catch (e) { plain = { error: e.message }; }
    try {
      const g = await callGemini(apiKey, {
        parts: [{ text: 'Using Google Search, name one official website of the SILKO kitchen equipment brand. Reply with just the URL.' }],
        search: true, maxTokens: 200
      });
      grounded = { model: g.model, api: g.api, reply: extractText(g.data).trim().slice(0, 120),
                   sources_found: extractSources(g.data).length };
    } catch (e) { grounded = { error: e.message }; }

    return res.status(200).json({
      ok: !!(plain && !plain.error),
      models_visible: models.length,
      plain_call: plain,
      grounded_search: grounded,
      note: (grounded && grounded.error)
        ? 'Google Search grounding is unavailable on this plan/model — search still works, but answers come from the model\'s own knowledge and may include fewer live links.'
        : undefined
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { brand, model: equipModel } = req.body || {};
  if (!brand || !equipModel) {
    return res.status(400).json({ error: 'brand and model are required' });
  }
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server not configured: the GEMINI_API_KEY environment variable is missing. Add it in your Vercel project settings (free key at aistudio.google.com/app/apikey).'
    });
  }

  try {
    // Progressive widening: exact model first, then the model family, then the
    // brand's parts catalogue in general. Stop as soon as something useful
    // turns up, so a common model costs one call and a rare one still ends
    // with something actionable rather than a dead end.
    const family = deriveFamily(equipModel);
    const stages = [
      { label: 'exact', query: brand + ' ' + equipModel,
        ask: 'the exact model "' + equipModel + '"' },
    ];
    if (family && family !== equipModel) {
      stages.push({ label: 'family', query: brand + ' ' + family,
        ask: 'the "' + family + '" model family (the closest relative of ' + equipModel + ')' });
    }
    stages.push({ label: 'brand', query: brand + ' spare parts catalogue',
      ask: 'the ' + brand + ' spare-parts catalogue in general (any entry point that leads to exploded-view diagrams)' });

    let best = null;
    let lastModel = null, lastApi = null;
    const allSources = [];

    for (const stage of stages) {
      const prompt =
        'You are a commercial kitchen and refrigeration equipment parts expert. ' +
        'Find official exploded-view spare parts diagrams for ' + stage.ask + '.\n' +
        'Brand / Manufacturer: ' + brand + '\n' +
        'Model: ' + equipModel + '\n\n' +
        'Prefer the manufacturer\'s own spare-parts portal, service manual PDFs, and reputable parts distributors.\n' +
        'Even if you cannot find the diagram itself, ALWAYS fill "results" with genuinely useful starting points: ' +
        'the brand\'s official website and spare-parts portal, distributor or dealer pages that stock this brand, ' +
        'and any service/technical documentation you are aware of. An empty "results" list is not acceptable ' +
        'unless you know nothing at all about this brand.\n\n' +
        'Reply with ONLY a JSON object (no explanations, no markdown fences) shaped exactly like this:\n' +
        '{"found": true, "equipment_name": "...", "manufacturer_parts_url": "https://... or null", ' +
        '"direct_image_urls": ["https://..."], ' +
        '"results": [{"title": "...", "url": "https://...", "type": "pdf|image|page", "description": "...", "relevance": "high|medium|low"}], ' +
        '"tips": "short practical advice for getting this exact parts diagram"}\n' +
        'Set "found" to false if you did not find the diagram itself — but still return useful "results". ' +
        'Never invent a URL you are not confident about.';

      let result;
      try {
        result = await callGemini(apiKey, {
          parts: [{ text: prompt }], json: false, search: true, maxTokens: 4096
        });
      } catch (e) {
        if (best) break;      // earlier stage already gave us something
        throw e;              // nothing at all yet — surface the real error
      }

      lastModel = result.model; lastApi = result.api;
      extractSources(result.data).forEach(src => {
        if (!allSources.some(s2 => s2.url === src.url)) allSources.push(src);
      });

      const parsed = parseLoose(extractText(result.data));
      if (parsed) {
        const stageOut = shapeResult(parsed, brand, equipModel, stage.label);
        if (!best) best = stageOut;
        else {
          // keep the first stage's headline, but absorb extra links
          stageOut.results.forEach(r => {
            if (r && r.url && !best.results.some(b => b.url === r.url)) best.results.push(r);
          });
          if (!best.manufacturer_parts_url && stageOut.manufacturer_parts_url) {
            best.manufacturer_parts_url = stageOut.manufacturer_parts_url;
          }
          if (stageOut.found && !best.found) {
            best.found = true;
            best.equipment_name = stageOut.equipment_name;
            best.tips = stageOut.tips || best.tips;
          }
        }
        // Good enough to stop widening
        if (best.found && best.results.length) break;
      }
    }

    if (!best) {
      best = {
        found: false,
        equipment_name: brand + ' ' + equipModel,
        manufacturer_parts_url: null,
        direct_image_urls: [],
        results: [],
        tips: ''
      };
    }

    // Fold in every real link the search tool cited across all stages
    allSources.forEach(src => {
      if (!best.results.some(r => r.url === src.url)) best.results.push(src);
    });

    if (best.results.length) {
      // We have somewhere useful to send them, even without the diagram itself
      best.found = true;
      if (!best.tips) {
        best.tips = 'The exact diagram was not found directly, but these sources are the best places to look. ' +
                    'If nothing here has it, request the parts catalogue from an authorised ' + brand + ' dealer with the unit\'s serial number.';
      }
    } else {
      best.tips = best.tips ||
        ('No public parts diagram was found for ' + brand + ' ' + equipModel + '. ' +
         'Manufacturers like this often keep parts catalogues behind a dealer portal — request it from an authorised dealer with the serial number, then add it here with "Upload Manually".');
    }

    best.model = lastModel;
    best.api = lastApi;
    const out = best;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
