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


// Is this a link to an actual parts document, rather than a homepage or noise?
function isDocumentLink(r) {
  if (!r || !r.url || !/^https?:\/\//i.test(r.url)) return false;
  const url = r.url;
  let path = '';
  try { path = new URL(url).pathname || '/'; } catch (e) { return false; }

  // Obvious noise
  if (/wikipedia\.org|youtube\.com|youtu\.be|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|pinterest\.|amazon\.|ebay\.|alibaba\.|aliexpress\./i.test(url)) return false;
  if (/\/(search|find|results)\b|[?&]q=|[?&]query=/i.test(url)) return false;
  if (/\/(about|contact|news|blog|careers|privacy|terms|login|cart)\b/i.test(path)) return false;

  const isPdf = /\.pdf(\?|#|$)/i.test(url) || r.type === 'pdf';
  const isImage = /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(url) || r.type === 'image';
  if (isPdf || isImage) return true;

  // A bare homepage is useless to a technician
  const depth = path.split('/').filter(Boolean).length;
  if (depth === 0) return false;

  // Otherwise keep it only if it looks parts-related
  return /part|spare|ricambi|catalog|catalogue|manual|diagram|exploded|service|schema|ersatzteil|pieces/i.test(url + ' ' + (r.title || '') + ' ' + (r.description || ''));
}

// Rank: real PDFs first, then diagram images, then parts pages.
function scoreDoc(r) {
  let s = 0;
  const hay = (r.url + ' ' + (r.title || '') + ' ' + (r.description || '')).toLowerCase();
  if (r.type === 'pdf' || /\.pdf(\?|#|$)/i.test(r.url)) s += 100;
  if (r.type === 'image') s += 60;
  if (/exploded|spaccato|explosionszeichnung/.test(hay)) s += 40;
  if (/spare|ricambi|ersatzteil|part/.test(hay)) s += 25;
  if (/catalog|catalogue|manual/.test(hay)) s += 15;
  if (r.relevance === 'high') s += 20;
  else if (r.relevance === 'medium') s += 8;
  if (r.verified) s += 30;
  return s;
}

// Models sometimes cite URLs that 404. Check each one really loads, in
// parallel and with a tight timeout, and drop the dead ones.
async function verifyLinks(list, limit) {
  const subset = list.slice(0, limit || 10);
  const checked = await Promise.all(subset.map(async r => {
    try {
      let resp = await withTimeout(fetch(r.url, { method: 'HEAD', redirect: 'follow' }), 6000);
      // Some servers reject HEAD — retry with a tiny ranged GET
      if (resp.status === 405 || resp.status === 501) {
        resp = await withTimeout(fetch(r.url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-256' } }), 6000);
      }
      if (!resp.ok && resp.status !== 206) return null;
      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('pdf')) r.type = 'pdf';
      else if (ctype.startsWith('image/')) r.type = 'image';
      r.verified = true;
      return r;
    } catch (e) {
      return null;   // unreachable — don't show a dead link
    }
  }));
  return checked.filter(Boolean);
}


// Technicians often type the serial off the rating plate instead of the model.
// Serials are long and mix letters and digits without the spaces/dashes that
// model designations usually have.
function looksLikeSerial(v) {
  const s2 = String(v || '').trim();
  if (s2.length < 7) return false;
  if (/[\s-]/.test(s2)) return false;
  const digits = (s2.match(/\d/g) || []).length;
  const letters = (s2.match(/[A-Za-z]/g) || []).length;
  return digits >= 4 && letters >= 2;
}


// ── Real web search via Google Programmable Search ───────────────────────
// Relying on the model's own "grounding" proved unreliable — on a free key it
// often returns no citations at all, and we (correctly) forbid it from
// inventing URLs, so results came back empty. Google's Programmable Search
// JSON API gives us genuine search results, including PDFs.
//
// SETUP (free, 100 searches/day):
//   1. Create a search engine at https://programmablesearchengine.google.com/
//      — set it to "Search the entire web", then copy its "Search engine ID".
//   2. Get an API key at https://developers.google.com/custom-search/v1/introduction
//      (button "Get a Key").
//   3. In Vercel → Settings → Environment Variables add:
//        GOOGLE_CSE_CX   = the Search engine ID
//        GOOGLE_CSE_KEY  = the API key
//   4. Redeploy.
// Without these the endpoint still works, falling back to the model's own
// knowledge — but with them it finds real, current PDF catalogues.

function cseConfigured() {
  return !!(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX);
}

async function cseSearch(query, opts) {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_CSE_KEY,
    cx: (opts && opts.forceCx) || process.env.GOOGLE_CSE_CX,
    q: query,
    num: String((opts && opts.num) || 8),
    safe: 'off'
  });
  if (opts && opts.pdfOnly) params.set('fileType', 'pdf');
  const url = 'https://www.googleapis.com/customsearch/v1?' + params.toString();
  try {
    const resp = await withTimeout(fetch(url), 10000);
    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + resp.status);
      return { error: msg, items: [] };
    }
    const items = (data.items || []).map(it => ({
      title: it.title || it.link,
      url: it.link,
      type: /\.pdf(\?|#|$)/i.test(it.link) || (it.mime === 'application/pdf') ? 'pdf'
            : /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(it.link) ? 'image' : 'page',
      description: it.snippet || '',
      relevance: 'medium'
    }));
    return { items: items };
  } catch (e) {
    return { error: e.message, items: [] };
  }
}

// Search the web for real parts-diagram documents for this brand/model.
async function findPartsDocuments(brand, equipModel, family) {
  const queries = [
    { q: '"' + equipModel + '" ' + brand + ' spare parts catalogue', pdfOnly: true },
    { q: brand + ' ' + equipModel + ' exploded view spare parts diagram pdf' },
    { q: brand + ' ' + equipModel + ' parts manual diagram' }
  ];
  if (family && family !== equipModel) {
    queries.push({ q: brand + ' ' + family + ' service parts catalogue', pdfOnly: true });
  }
  queries.push({ q: brand + ' service parts catalogue exploded view', pdfOnly: true });

  const found = [];
  const seen = new Set();
  let lastError = null;

  for (const spec of queries) {
    const res = await cseSearch(spec.q, { pdfOnly: spec.pdfOnly, num: 8 });
    if (res.error) { lastError = res.error; continue; }
    res.items.forEach(item => {
      if (seen.has(item.url)) return;
      seen.add(item.url);
      if (!isDocumentLink(item)) return;
      found.push(item);
    });
    // A few solid PDFs is plenty — stop burning the daily quota
    if (found.filter(r => r.type === 'pdf').length >= 4) break;
  }
  return { found: found, error: lastError };
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

    let webSearch = null;
    if (cseConfigured()) {
      const probe = await cseSearch('Rational SCC61 spare parts catalogue', { pdfOnly: true, num: 5 });
      if (!probe.error) {
        webSearch = { configured: true, working: true, sample_hits: probe.items.length,
                      example: probe.items[0] ? probe.items[0].url : null };
      } else {
        // Google returns the same vague "no access" message for several very
        // different causes, so probe once more with a deliberately bogus engine
        // id: if the error CHANGES, the key itself is fine and the problem is
        // the engine id (cx); if it stays the same, the key/API is the problem.
        const cxProbe = await cseSearch('test', { num: 1, forceCx: 'definitely-not-a-real-cx' });
        const sameError = cxProbe.error === probe.error;
        webSearch = {
          configured: true, working: false, problem: probe.error,
          likely_cause: sameError
            ? 'The API KEY is the problem: either Custom Search API is not enabled on the same Google Cloud project this key belongs to, or the key is restricted. Re-create the key inside the project where Custom Search API shows "API Enabled".'
            : 'The SEARCH ENGINE ID (GOOGLE_CSE_CX) is the problem: the key works, but this engine id was rejected. Copy it again from programmablesearchengine.google.com and update GOOGLE_CSE_CX in Vercel, then redeploy.',
          key_looks_valid: !sameError
        };
      }
    } else {
      webSearch = { configured: false,
        note: 'Add GOOGLE_CSE_KEY and GOOGLE_CSE_CX to search the real web for PDF parts catalogues (free, 100/day). Setup steps are in the comments at the top of this file.' };
    }

    return res.status(200).json({
      ok: !!(plain && !plain.error),
      web_search: webSearch,
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
    // ── Preferred path: a real web search ────────────────────────────────
    if (cseConfigured()) {
      const fam = deriveFamily(equipModel);
      const web = await findPartsDocuments(brand, equipModel, fam);
      const verifiedWeb = await verifyLinks(web.found, 10);
      verifiedWeb.sort((a, b) => scoreDoc(b) - scoreDoc(a));
      if (verifiedWeb.length) {
        return res.status(200).json({
          found: true,
          equipment_name: brand + ' ' + equipModel,
          manufacturer_parts_url: null,
          direct_image_urls: verifiedWeb.filter(r => r.type === 'image').map(r => r.url),
          results: verifiedWeb,
          tips: verifiedWeb.some(r => r.type === 'pdf')
            ? 'These links were found by a live web search and checked to be reachable. Open the closest match, then add its diagram here with "Upload Manually".'
            : 'No downloadable PDF surfaced, but these pages show or lead to parts diagrams.',
          source: 'web-search'
        });
      }
      if (web.error) console.warn('web search problem:', web.error);
      // nothing usable — fall through to the model-knowledge path below
    }

    // Goal: DIRECT links to exploded-view / spare-parts PDF documents.
    // Generic homepages are useless to a technician, so they are filtered out
    // and every surviving link is checked to be actually reachable.
    const family = deriveFamily(equipModel);
    const stages = [
      { label: 'exact',
        ask: 'the exact model "' + equipModel + '"',
        hints: [
          brand + ' ' + equipModel + ' spare parts catalogue filetype:pdf',
          brand + ' ' + equipModel + ' exploded view parts list pdf',
          brand + ' ' + equipModel + ' parts manual site:partstown.com OR site:partstown.co.uk',
          '"' + equipModel + '" ricambi OR "spare parts" pdf'
        ] }
    ];
    if (family && family !== equipModel) {
      stages.push({ label: 'family',
        ask: 'the "' + family + '" model family (closest relative of ' + equipModel + ')',
        hints: [
          brand + ' ' + family + ' series spare parts catalogue filetype:pdf',
          brand + ' ' + family + ' exploded view parts manual pdf'
        ] });
    }
    stages.push({ label: 'brand',
      ask: 'any ' + brand + ' spare-parts catalogue PDF that covers this type of equipment',
      hints: [
        brand + ' spare parts catalogue filetype:pdf',
        brand + ' exploded view parts list pdf',
        brand + ' parts manual site:partstown.com OR site:partstown.co.uk',
        brand + ' service manual parts pdf'
      ] });

    let headline = null;
    let lastModel = null, lastApi = null;
    const candidates = [];

    for (const stage of stages) {
      const prompt =
        'You are a spare-parts researcher for commercial kitchen and refrigeration equipment.\n' +
        'TASK: find DIRECT DOWNLOAD LINKS to documents containing exploded-view spare parts diagrams for ' + stage.ask + '.\n' +
        'Brand: ' + brand + '\nModel: ' + equipModel + '\n\n' +
        'Use Google Search. Useful queries include:\n- ' + stage.hints.join('\n- ') + '\n\n' +
        'ALSO search the big foodservice parts distributors, which publish exploded-view parts manuals and diagrams ' +
        'for most brands — for example Parts Town (partstown.com / partstown.co.uk, which hosts a large manuals library), ' +
        'Gastroparts, Alliance Parts, Heritage Parts, 4Cooking, and the brand\'s own technical/service documentation area. ' +
        'A distributor-hosted parts manual PDF is a perfectly good result.\n\n' +
        'WHAT COUNTS AS A RESULT:\n' +
        '- A URL that points straight at a PDF parts catalogue, parts list or service manual (ideally ending in .pdf)\n' +
        '- A URL of a page that displays the exploded-view diagram itself\n' +
        'WHAT DOES NOT COUNT (never include these):\n' +
        '- Company homepages, "about us", contact or news pages\n' +
        '- Search-result pages, marketplaces, Wikipedia, forums, YouTube\n' +
        '- Any URL you did not actually see in the search results — never guess or construct one\n\n' +
        'Reply with ONLY this JSON (no prose, no markdown fences):\n' +
        '{"found": true, "equipment_name": "...", "manufacturer_parts_url": "url of the brand\'s spare-parts portal or null", ' +
        '"direct_image_urls": ["direct image URLs of the diagram, if any"], ' +
        '"results": [{"title": "...", "url": "https://...", "type": "pdf|image|page", "description": "what this document contains", "relevance": "high|medium|low"}], ' +
        '"tips": "how to obtain this specific diagram"}\n' +
        'If you found no qualifying documents, return "found": false with an empty "results" list.';

      let result;
      try {
        result = await callGemini(apiKey, {
          parts: [{ text: prompt }], json: false, search: true, maxTokens: 4096
        });
      } catch (e) {
        if (candidates.length) break;
        throw e;
      }

      lastModel = result.model; lastApi = result.api;

      const parsed = parseLoose(extractText(result.data));
      if (parsed) {
        const shaped = shapeResult(parsed, brand, equipModel, stage.label);
        if (!headline) headline = shaped;
        else if (!headline.manufacturer_parts_url && shaped.manufacturer_parts_url) {
          headline.manufacturer_parts_url = shaped.manufacturer_parts_url;
        }
        shaped.results.forEach(r => candidates.push(r));
        (shaped.direct_image_urls || []).forEach(u => candidates.push({
          title: 'Diagram image', url: u, type: 'image',
          description: 'Direct diagram image', relevance: 'high'
        }));
      }
      // Sources Google actually cited — these are real URLs, worth keeping
      extractSources(result.data).forEach(src => candidates.push(src));

      // Enough strong material? stop widening.
      if (candidates.filter(isDocumentLink).length >= 3) break;
    }

    if (!headline) {
      headline = {
        found: false, equipment_name: brand + ' ' + equipModel,
        manufacturer_parts_url: null, direct_image_urls: [], results: [], tips: ''
      };
    }

    // Keep only real documents, de-duplicate, then verify they actually load.
    const docs = [];
    const seenUrls = new Set();
    candidates.forEach(r => {
      if (!r || !r.url || seenUrls.has(r.url)) return;
      if (!isDocumentLink(r)) return;
      seenUrls.add(r.url);
      docs.push(r);
    });

    const verified = await verifyLinks(docs, 10);

    verified.sort((a, b) => scoreDoc(b) - scoreDoc(a));

    const out = {
      found: verified.length > 0,
      equipment_name: headline.equipment_name,
      manufacturer_parts_url: headline.manufacturer_parts_url || null,
      direct_image_urls: verified.filter(r => r.type === 'image').map(r => r.url),
      results: verified,
      tips: verified.length
        ? (verified.some(r => r.type === 'pdf')
            ? 'These PDF links were checked and are reachable. Open the closest match, then add its diagram here with "Upload Manually".'
            : 'No downloadable PDF catalogue surfaced, but these pages show or lead to parts diagrams.')
        : ('No downloadable parts diagram was found for ' + brand + ' ' + equipModel + '.' +
           (looksLikeSerial(equipModel)
             ? ' NOTE: "' + equipModel + '" looks like a SERIAL number rather than a model designation. Try the model shown on the rating plate instead (for example Rational uses SCC 61, CMP 101, iCombi Pro 6-1-1 — not the serial).'
             : '') +
           ' Otherwise request the parts catalogue from an authorised ' + brand +
           ' dealer with the unit\'s serial number, then add it here with "Upload Manually".'),
      model: lastModel, api: lastApi
    };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
