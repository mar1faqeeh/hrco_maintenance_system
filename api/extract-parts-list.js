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

  const { images } = req.body || {}; // array of data URLs (base64 images)
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
    // Build one image content block per page, converting data URLs to the
    // {type:'image', source:{type:'base64', media_type, data}} format Claude expects.
    const content = [];
    for (const dataUrl of images) {
      const match = /^data:(image\/[a-zA-Z]+);base64,(.+)$/.exec(dataUrl);
      if (!match) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] }
      });
    }
    content.push({
      type: 'text',
      text: 'These are page(s) from a spare-parts list table (position/pos number, part code, description columns). Extract EVERY row into a JSON array. Each item: {"num": "<position number as shown>", "code": "<part code, or empty string if none>", "desc": "<part description>"}. Return ONLY the JSON array, no other text, no markdown fences.'
    });

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

    var text = (data.content && data.content[0] && data.content[0].text) || '[]';
    text = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    let parts;
    try { parts = JSON.parse(text); }
    catch (e) { return res.status(200).json({ parts: [], raw: text, warning: 'Could not parse a clean JSON list' }); }

    return res.status(200).json({ parts: parts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
