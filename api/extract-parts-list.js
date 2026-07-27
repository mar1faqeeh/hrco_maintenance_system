// Vercel Serverless Function — reads a parts-list table image (like a
// manufacturer's spare-parts page) and returns a structured list of
// {num, code, desc} using Claude's vision. Uses the SAME ANTHROPIC_API_KEY
// environment variable already set up for /api/search-diagram.js — no
// extra setup needed if that's already configured.
//
// SETUP: none beyond what search-diagram.js already needs. Just add this
// file to your project at:  api/extract-parts-list.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { images, diagramImage } = req.body || {}; // images: array of data URLs (parts-list pages), diagramImage: optional data URL of the exploded-view photo
  if (!images || !Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: 'images (array of data URLs) is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server not configured: ANTHROPIC_API_KEY environment variable is missing.'
    });
  }

  try {
    function toBlock(dataUrl){
      const match = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(dataUrl);
      if (!match) return null;
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }

    const content = [];
    var hasDiagram = false;
    if (diagramImage) {
      var diagBlock = toBlock(diagramImage);
      if (diagBlock) { content.push({type:'text', text:'DIAGRAM IMAGE (the numbered exploded-view photo):'}); content.push(diagBlock); hasDiagram = true; }
    }
    content.push({type:'text', text:'PARTS-LIST PAGE IMAGE(S) (table of position/pos numbers with codes and descriptions):'});
    for (const dataUrl of images) {
      const block = toBlock(dataUrl);
      if (block) content.push(block);
    }

    var instructions = 'Extract EVERY row from the parts-list table image(s) into a JSON array called "parts". Each item: {"num": "<position number as shown>", "code": "<part code, or empty string if none>", "desc": "<part description>"}.';
    if (hasDiagram) {
      instructions += ' Also look at the DIAGRAM IMAGE: it has small numbered circles/tags, each connected by a thin leader line to a specific part in the drawing. For each numbered tag, determine where its leader line actually POINTS TO on the part (not the tag\'s own printed position) and return that as a percentage of the image width/height (0-100, 0,0 = top-left) in a JSON object called "positions", e.g. {"2": [45.2, 30.1], "3": [50.0, 28.4]}. Include every number you can find a leader line for.';
      instructions += ' Return ONLY one JSON object: {"parts": [...], "positions": {...}}. No other text, no markdown fences.';
    } else {
      instructions += ' Return ONLY {"parts": [...]}. No other text, no markdown fences.';
    }
    content.push({ type: 'text', text: instructions });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: content }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error', details: data });
    }

    var text = (data.content && data.content[0] && data.content[0].text) || '{}';
    text = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return res.status(200).json({ parts: [], positions: {}, raw: text, warning: 'Could not parse a clean JSON response' }); }

    return res.status(200).json({ parts: parsed.parts || [], positions: parsed.positions || {} });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
