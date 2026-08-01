// Vercel Serverless Function — reads a parts-list table image and locates the
// numbered callouts on an exploded-view diagram, using GOOGLE GEMINI.
//
// Drop-in replacement: same URL, same request/response shape, so NO changes
// are needed in maintenance_system.html.
//
// ── SETUP (one time) ──────────────────────────────────────────────────────
// 1. Get a free API key: https://aistudio.google.com/app/apikey
// 2. In Vercel: project → Settings → Environment Variables → add
//       Key:   GEMINI_API_KEY
//       Value: the key from step 1
// 3. Save this file at:  api/extract-parts-list.js   then redeploy.
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
  for (const name of candidates) {
    const r = await tryModel(apiKey, name, buildBody);
    if (r.ok) {
      cachedModel = name;
      cachedModelAt = Date.now();
      return { data: r.data, model: name };
    }
    lastMessage = r.message;
    lastStatus = r.status;
    // Retryable on another model: not found, no quota on this plan, or the
    // model rejected the request shape.
    if (r.status === 404 || r.status === 429 || r.status === 400) {
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
    }
  }

  const err = new Error(lastMessage || 'All available Gemini models failed.');
  err.status = lastStatus;
  throw err;
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
    function toPart(dataUrl) {
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
      if (!match) return null;
      return { inline_data: { mime_type: match[1], data: match[2] } };
    }

    const parts = [];
    let hasDiagram = false;

    if (diagramImage) {
      const diagPart = toPart(diagramImage);
      if (diagPart) {
        parts.push({ text: 'DIAGRAM IMAGE (the numbered exploded-view drawing):' });
        parts.push(diagPart);
        hasDiagram = true;
      }
    }

    parts.push({ text: 'PARTS-LIST PAGE IMAGE(S) (a table with position/pos number, part code and description columns):' });
    for (const dataUrl of images) {
      const part = toPart(dataUrl);
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

    const result = await callGemini(apiKey, () => ({
      contents: [{ role: 'user', parts: parts }],
      // NOTE: temperature/top_p are deprecated on Gemini 3.x — defaults are best.
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: 'application/json'
      }
    }));
    const data = result.data;
    const model = result.model;

    let text = '';
    try {
      const cand = data.candidates && data.candidates[0];
      const cparts = cand && cand.content && cand.content.parts;
      if (cparts) text = cparts.map(function (p) { return p.text || ''; }).join('');
    } catch (e) { /* handled below */ }

    if (!text.trim()) {
      return res.status(200).json({
        parts: [], positions: {},
        warning: 'The model returned an empty response.',
        model: model, details: data
      });
    }

    text = text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(200).json({
        parts: [], positions: {}, raw: text, model: model,
        warning: 'Could not parse a clean JSON response from the model.'
      });
    }

    const outParts = Array.isArray(parsed) ? parsed : (parsed.parts || []);
    const outPositions = (parsed && parsed.positions) || {};

    return res.status(200).json({ parts: outParts, positions: outPositions, model: model });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
