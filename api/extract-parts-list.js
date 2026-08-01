// Vercel Serverless Function — reads a parts-list table image and locates the
// numbered callouts on an exploded-view diagram, using GOOGLE GEMINI.
//
// This is a drop-in replacement: it keeps the exact same URL and the same
// request/response shape as before, so NO changes are needed in
// maintenance_system.html.
//
// ── SETUP (one time) ──────────────────────────────────────────────────────
// 1. Get a free API key: https://aistudio.google.com/app/apikey
// 2. In Vercel: your project → Settings → Environment Variables → add
//       Key:   GEMINI_API_KEY
//       Value: the key from step 1
//    (Optional) add GEMINI_MODEL to use a different model than the default
//    below — handy if Google renames or retires models later.
// 3. Save this file at:  api/extract-parts-list.js   then redeploy.
//
// ANTHROPIC_API_KEY is no longer used by this file. Leave it in place if
// search-diagram.js still uses it, or remove it.

const DEFAULT_MODEL = 'gemini-2.5-flash';

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
      error: 'Server not configured: the GEMINI_API_KEY environment variable is missing. Add it in your Vercel project settings (get a free key at aistudio.google.com/app/apikey).'
    });
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  try {
    // Convert a data URL into Gemini's inline_data format
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
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = (data && data.error && data.error.message) || ('Gemini API error (HTTP ' + response.status + ')');
      return res.status(response.status).json({ error: msg, details: data });
    }

    // Pull the text out of Gemini's response shape
    let text = '';
    try {
      const cand = data.candidates && data.candidates[0];
      const cparts = cand && cand.content && cand.content.parts;
      if (cparts) text = cparts.map(function (p) { return p.text || ''; }).join('');
    } catch (e) { /* handled by the empty-text check below */ }

    if (!text.trim()) {
      return res.status(200).json({
        parts: [], positions: {},
        warning: 'The model returned an empty response.',
        details: data
      });
    }

    // Strip any stray code fences just in case
    text = text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(200).json({
        parts: [], positions: {}, raw: text,
        warning: 'Could not parse a clean JSON response from the model.'
      });
    }

    // Accept either {parts, positions} or a bare array of parts
    const outParts = Array.isArray(parsed) ? parsed : (parsed.parts || []);
    const outPositions = (parsed && parsed.positions) || {};

    return res.status(200).json({ parts: outParts, positions: outPositions });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
