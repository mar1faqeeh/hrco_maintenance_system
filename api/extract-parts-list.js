// Vercel Serverless Function — reads a parts-list table image and locates the
// numbered callouts on an exploded-view diagram, using GOOGLE GEMINI.
//
// Drop-in replacement: same URL, same request/response shape, so NO changes
// are needed in maintenance_system.html.
//
// ── SETUP (one time) ──────────────────────────────────────────────────────
// 1. Free API key: https://aistudio.google.com/app/apikey
// 2. Vercel → project → Settings → Environment Variables → add
//       Key:   GEMINI_API_KEY
//       Value: the key from step 1
// 3. Save this file at:  api/extract-parts-list.js   then redeploy.
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

  const { images, diagramImage } = req.body || {};
  if (!images || !Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: 'images (array of data URLs) is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
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

    parts.push({ text: 'PARTS-LIST PAGE IMAGE(S) (a table with position/pos number, part code and description columns):' });
    for (const dataUrl of images) {
      const part = toImagePart(dataUrl);
      if (part) parts.push(part);
    }

    let instructions =
      'Extract EVERY row from the parts-list table image(s) into a JSON array called "parts". ' +
      'Each item must be: {"num": "<position number exactly as shown, e.g. 0002>", "code": "<part code, or empty string if none>", "desc": "<part description>"}.';

    if (hasDiagram) {
      instructions +=
        ' Then look at the DIAGRAM IMAGE. It contains small numbered circles (callout bubbles), each joined by a thin leader line to a component in the drawing. ' +
        'For EACH numbered circle, report the position of THE CIRCLE ITSELF as a percentage of the image width and height, where [0,0] is the top-left corner and [100,100] is the bottom-right. ' +
        'Return these in a JSON object called "positions", for example {"1": [45.2, 30.1], "2": [50.0, 28.4]}. ' +
        'Be as precise as you can and include every numbered circle you can see. ' +
        'Return ONLY one JSON object shaped exactly like {"parts": [...], "positions": {...}} — no explanations, no markdown code fences.';
    } else {
      instructions += ' Return ONLY {"parts": [...]} — no explanations, no markdown code fences.';
    }

    parts.push({ text: instructions });

    const result = await callGemini(apiKey, {
      parts: parts,
      json: true,
      search: false,
      maxTokens: 8192
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
      const lastObj = text.lastIndexOf('}');
      const lastArr = text.lastIndexOf(']');
      const last = Math.max(lastObj, lastArr);
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
    const outPositions = (parsed && parsed.positions) || {};

    return res.status(200).json({ parts: outParts, positions: outPositions, model: model, api: result.api });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
