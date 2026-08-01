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
// Model selection is AUTOMATIC: this asks Google which models the key can
// actually use and picks the best current one. That means it keeps working
// when Google renames or retires models. To pin a specific model instead,
// set the optional GEMINI_MODEL environment variable.

let cachedModel = null;      // remembered between warm invocations
let cachedModelAt = 0;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000; // re-check twice a day

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

  // Prefer stable "flash" models (fast + cheap + vision-capable), newest first.
  const versionOf = name => {
    const m = /gemini-(\d+(?:\.\d+)?)/.exec(name);
    return m ? parseFloat(m[1]) : 0;
  };
  const score = m => {
    const n = m.name;
    let s = versionOf(n) * 100;
    if (/flash/i.test(n)) s += 50;      // flash = ideal for this task
    if (/lite/i.test(n)) s -= 20;       // lite is weaker at vision
    if (/preview|exp/i.test(n)) s -= 30; // prefer stable releases
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
    const model = await pickModel(apiKey);

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

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                encodeURIComponent(model) + ':generateContent';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: parts }],
        // NOTE: temperature/top_p are deprecated on Gemini 3.x — defaults are best.
        generationConfig: {
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      // A stale cached model name is the most likely cause of a 404 — clear it
      // so the next attempt re-discovers a working model.
      if (response.status === 404) { cachedModel = null; cachedModelAt = 0; }
      const msg = (data && data.error && data.error.message) || ('Gemini API error (HTTP ' + response.status + ')');
      return res.status(response.status).json({ error: msg + ' [model: ' + model + ']', details: data });
    }

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
    return res.status(500).json({ error: e.message });
  }
}
