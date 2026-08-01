// Vercel Serverless Function — reads a parts-list table image and locates the
// numbered callouts on an exploded-view diagram, using GOOGLE GEMINI.
//
// Drop-in replacement: same URL and response shape, so NO changes are needed
// in maintenance_system.html.
//
// ── SETUP (one time) ──────────────────────────────────────────────────────
// 1. Free API key: https://aistudio.google.com/app/apikey
// 2. Vercel → project → Settings → Environment Variables → add
//       Key:   GEMINI_API_KEY
//       Value: the key from step 1
// 3. Save this file at:  api/extract-parts-list.js   then redeploy.
//
// ── SELF-TEST ─────────────────────────────────────────────────────────────
// Open this URL in your browser after deploying:
//     https://YOUR-SITE.vercel.app/api/extract-parts-list
// It reports whether the key works, which models your key can see, and which
// model + API style actually answered — no upload needed.

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
    response = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
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
    const models = await listCandidateModels(apiKey);
    // New API first — the legacy endpoint is being retired model by model.
    models.forEach(m => attempts.push({ model: m, api: 'interactions' }));
    models.forEach(m => attempts.push({ model: m, api: 'generateContent' }));
  }

  for (const attempt of attempts) {
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


// Models are inconsistent about coordinate scales: some answer in a 0-1000
// normalised grid (Gemini's native convention), some in percent, some in
// 0-1 fractions, and some in raw pixels. Convert everything to percentages,
// and drop anything that still can't be made sense of.
function normalisePositions(raw) {
  const pairs = [];
  Object.keys(raw || {}).forEach(key => {
    const v = raw[key];
    let x, y;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      x = Number(v.x); y = Number(v.y);
    } else if (Array.isArray(v) && v.length >= 2) {
      // Ambiguous order — Gemini documents [y, x], so assume that, but the
      // scale check below is what actually matters most.
      y = Number(v[0]); x = Number(v[1]);
    } else {
      return;
    }
    if (!isFinite(x) || !isFinite(y)) return;
    pairs.push({ key: key, x: x, y: y });
  });
  if (!pairs.length) return {};

  const maxVal = pairs.reduce((m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y)), 0);
  let divisor = 1;                 // already a percentage
  if (maxVal <= 1.5) divisor = 0.01;      // 0-1 fractions
  else if (maxVal > 100 && maxVal <= 1000) divisor = 10;   // 0-1000 grid
  else if (maxVal > 1000) divisor = maxVal / 100;          // raw pixels

  const out = {};
  pairs.forEach(p => {
    const xPct = p.x / divisor;
    const yPct = p.y / divisor;
    if (xPct < -1 || xPct > 101 || yPct < -1 || yPct > 101) return;
    out[p.key] = [Math.min(100, Math.max(0, xPct)), Math.min(100, Math.max(0, yPct))];
  });
  return out;
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  // ── Self-test: plain GET in a browser ──────────────────────────────────
  if (req.method === 'GET') {
    if (!apiKey) {
      return res.status(200).json({
        ok: false,
        step: 'api key',
        problem: 'GEMINI_API_KEY is not set in this project\'s environment variables.',
        fix: 'Vercel → your project → Settings → Environment Variables → add GEMINI_API_KEY, then redeploy.'
      });
    }
    let models = [];
    try {
      models = await listCandidateModels(apiKey);
    } catch (e) {
      return res.status(200).json({
        ok: false, step: 'list models', problem: e.message,
        fix: 'The API key was rejected by Google. Check it was pasted in full, then redeploy.'
      });
    }
    try {
      const probe = await callGemini(apiKey, {
        parts: [{ text: 'Reply with exactly: OK' }],
        json: false, search: false, maxTokens: 32
      });
      return res.status(200).json({
        ok: true,
        working_model: probe.model,
        working_api: probe.api,
        reply: extractText(probe.data).trim().slice(0, 100),
        models_visible: models.length,
        first_models: models.slice(0, 8)
      });
    } catch (e) {
      return res.status(200).json({
        ok: false, step: 'model call', problem: e.message,
        models_visible: models.length,
        first_models: models.slice(0, 8),
        fix: 'Google rejected every model. If it mentions quota, the free tier is exhausted for today — try again after it resets.'
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { images, diagramImage, numbers, positionsOnly } = req.body || {};
  const hasList = images && Array.isArray(images) && images.length;
  if (!hasList && !diagramImage) {
    return res.status(400).json({ error: 'images (array of data URLs) or diagramImage is required' });
  }
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server not configured: the GEMINI_API_KEY environment variable is missing. Add it in your Vercel project settings (free key at aistudio.google.com/app/apikey).'
    });
  }

  try {
    function toImagePart(dataUrl) {
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
      if (!match) return null;
      return { image: { mime: match[1], data: match[2] } };
    }

    const parts = [];
    let hasDiagram = false;

    if (diagramImage) {
      const diagPart = toImagePart(diagramImage);
      if (diagPart) {
        parts.push({ text: 'DIAGRAM IMAGE (the numbered exploded-view drawing):' });
        parts.push(diagPart);
        hasDiagram = true;
      }
    }

    // Positions-only mode: the caller already read the parts table itself
    // (for free, from the PDF text layer) and just needs the callout
    // coordinates. Giving the model the exact list of numbers to find is far
    // more reliable than asking it to infer everything.
    if (positionsOnly && hasDiagram) {
      const wanted = Array.isArray(numbers) && numbers.length
        ? numbers.map(n => String(n)).join(', ')
        : '';
      parts.push({ text:
        'This drawing has small numbered circles (callout bubbles), each joined by a thin leader line to a component.' +
        (wanted ? ' The numbers used on it are: ' + wanted + '.' : '') +
        ' Find the CENTRE OF EACH NUMBERED CIRCLE and report it on a 0-1000 grid, where y=0 is the top edge, y=1000 the bottom edge, x=0 the left edge and x=1000 the right edge.' +
        ' Answer with ONLY a JSON object mapping each number to its centre, using explicit x and y keys, like:' +
        ' {"1": {"y": 301, "x": 452}, "2": {"y": 284, "x": 500}}' +
        ' No explanations, no markdown code fences, no other keys.'
      });

      const posResult = await callGemini(apiKey, {
        parts: parts, json: true, search: false, maxTokens: 2048
      });
      let posText = extractText(posResult.data).trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
      const pf = posText.indexOf('{');
      const pl = posText.lastIndexOf('}');
      if (pf !== -1 && pl > pf) posText = posText.slice(pf, pl + 1);
      let posParsed = null;
      try { posParsed = JSON.parse(posText); } catch (e) { posParsed = null; }
      if (!posParsed) {
        return res.status(200).json({
          parts: [], positions: {},
          warning: 'The model did not return readable coordinates.',
          raw: extractText(posResult.data).slice(0, 400),
          model: posResult.model, api: posResult.api
        });
      }
      const posOut = normalisePositions(posParsed.positions || posParsed);
      return res.status(200).json({
        parts: [], positions: posOut,
        model: posResult.model, api: posResult.api,
        raw: Object.keys(posOut).length ? undefined : extractText(posResult.data).slice(0, 400),
        warning: Object.keys(posOut).length ? undefined : 'The model answered, but no usable coordinates were found in its reply.'
      });
    }

    if (hasList) {
      parts.push({ text: 'PARTS-LIST PAGE IMAGE(S) (a table with position/pos number, part code and description columns):' });
      for (const dataUrl of images) {
        const part = toImagePart(dataUrl);
        if (part) parts.push(part);
      }
    }

    let instructions =
      'Extract EVERY row from the parts-list table image(s) into a JSON array called "parts". ' +
      'Each item must be: {"num": "<position number exactly as shown, e.g. 0002>", "code": "<part code, or empty string if none>", "desc": "<part description>"}.';

    if (hasDiagram) {
      instructions +=
        ' Then look at the DIAGRAM IMAGE. It contains small numbered circles (callout bubbles), each joined by a thin leader line to a component in the drawing. ' +
        'Locate the CENTRE OF EACH NUMBERED CIRCLE and report it using normalised coordinates on a 0-1000 grid, where y=0 is the top edge, y=1000 the bottom edge, x=0 the left edge and x=1000 the right edge. ' +
        'Put them in a JSON object called "positions", keyed by the number, each value an object with explicit x and y keys, like: ' +
        '{"1": {"y": 301, "x": 452}, "2": {"y": 284, "x": 500}}. ' +
        'Always use the "x" and "y" key names — never a bare array. Include every numbered circle you can see and be as precise as possible. ' +
        'Return ONLY one JSON object shaped exactly like {"parts": [...], "positions": {...}} — no explanations, no markdown code fences.';
    } else {
      instructions += ' Return ONLY {"parts": [...]} — no explanations, no markdown code fences.';
    }

    parts.push({ text: instructions });

    const result = await callGemini(apiKey, {
      parts: parts, json: true, search: false, maxTokens: 8192
    });

    const model = result.model;
    let text = extractText(result.data);

    if (!text.trim()) {
      return res.status(200).json({
        parts: [], positions: {},
        warning: 'The model returned an empty response.',
        model: model, api: result.api
      });
    }

    text = text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '');
    if (text[0] !== '{' && text[0] !== '[') {
      const first = text.search(/[{[]/);
      const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (first !== -1 && last > first) text = text.slice(first, last + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(200).json({
        parts: [], positions: {}, raw: text.slice(0, 500), model: model, api: result.api,
        warning: 'Could not parse a clean JSON response from the model.'
      });
    }

    const outParts = Array.isArray(parsed) ? parsed : (parsed.parts || []);
    const outPositions = normalisePositions((parsed && parsed.positions) || {});

    return res.status(200).json({ parts: outParts, positions: outPositions, model: model, api: result.api });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
