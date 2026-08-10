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

// Allow Vercel a longer window than the 10s default.
export const maxDuration = 60;


// ═══════════════════════════════════════════════════════════════════
//  READ A SERIAL NUMBER FROM A PHOTO OF THE RATING PLATE
//
//  The technician photographs the plate on the machine; this reads the
//  serial (and the model when it's legible) out of the picture.
//
//  Rating plates are hostile input: stamped metal, glare, dust, an
//  angle, and half a dozen numbers that are NOT the serial (voltage,
//  amps, refrigerant charge, year). So the prompt names what to look
//  for, and the reply is scored — a guess is returned with a low
//  confidence rather than presented as fact.
// ═══════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

const PROMPT = [
  'This photo shows the rating/data plate of a commercial refrigeration or',
  'kitchen machine. Read it and report ONLY these fields.',
  '',
  'SERIAL: the unit serial number. On these plates it is usually labelled',
  'Serial, Serial No, S/N, SN, Ser. No, Matricola, No. de serie, or الرقم التسلسلي.',
  'It is unique per machine — often long, often mixing letters and digits.',
  '',
  'MODEL: the model or type designation (Model, Mod., Type, Modello).',
  '',
  'BRAND: the manufacturer name if it is printed on the plate.',
  '',
  'Do NOT report voltage, frequency, current, power, pressure, refrigerant',
  'type or charge weight, production year, or a barcode number as the serial.',
  'If a field is not clearly readable, return an empty string for it.',
  '',
  'Answer with nothing but this JSON, no code fences and no commentary:',
  '{"serial":"...","model":"...","brand":"...","confidence":0.0}',
  '',
  'confidence is your own 0-1 judgement of how certain you are of the SERIAL.'
].join('\n');

function cleanField(v) {
  return String(v == null ? '' : v)
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 60);
}

// A plausible serial has some length and at least one digit. Anything that
// looks like a pure measurement ("220V", "50HZ") is rejected outright.
function plausibleSerial(s) {
  if (!s || s.length < 4) return false;
  if (!/\d/.test(s)) return false;
  if (/^\d{1,3}\s*(v|hz|a|w|kw|kg|g|mm|cm|bar|psi)$/i.test(s)) return false;
  if (/^(19|20)\d{2}$/.test(s)) return false;   // a bare year
  return true;
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;

  // Browser self-test: open /api/read-serial to check the key and route.
  if (req.method === 'GET') {
    if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY is not set' });
    try {
      const models = await listCandidateModels(apiKey);
      return res.status(200).json({ ok: true, models: models.slice(0, 8), cachedRoute });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server' });

  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'No image was sent' });

  try {
    const raw = await callGemini(apiKey, PROMPT, [image], { wantJson: true });
    const text = String(raw || '').replace(/```json|```/g, '').trim();

    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) { parsed = null; }

    if (!parsed) {
      // The model answered in prose — salvage a serial-looking token instead
      // of failing outright.
      const guess = (text.match(/[A-Z0-9][A-Z0-9\-\/]{5,}/i) || [])[0] || '';
      return res.status(200).json({
        serial: plausibleSerial(guess) ? guess : '',
        model: '', brand: '', confidence: guess ? 0.3 : 0,
        note: 'Unstructured reply', raw: text.slice(0, 300)
      });
    }

    const serial = cleanField(parsed.serial);
    const ok = plausibleSerial(serial);

    return res.status(200).json({
      serial: ok ? serial : '',
      model: cleanField(parsed.model),
      brand: cleanField(parsed.brand),
      confidence: ok ? Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)) : 0,
      rejected: (!ok && serial) ? serial : undefined
    });
  } catch (e) {
    console.error('read-serial failed:', e);
    return res.status(500).json({ error: e.message || 'Could not read the plate' });
  }
}
