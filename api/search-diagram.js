// Vercel Serverless Function — proxies the parts-diagram AI search to the
// Anthropic API. This MUST run server-side: browsers cannot call
// api.anthropic.com directly (no CORS support, and it would expose your API
// key to anyone who views the page source). This file fixes that by moving
// the call here, where the key stays secret in an environment variable.
//
// SETUP (one-time):
// 1. In your Vercel project, go to Settings -> Environment Variables.
// 2. Add a variable named ANTHROPIC_API_KEY with your key from
//    https://console.anthropic.com/settings/keys
// 3. Add this file to your project at:  api/search-diagram.js
//    (Vercel auto-detects anything under /api as a serverless function —
//    no extra config needed.)
// 4. Redeploy. The frontend already calls /api/search-diagram (relative
//    path, same domain), so no other setup is needed.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { brand, model } = req.body || {};
  if (!brand || !model) {
    return res.status(400).json({ error: 'brand and model are required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server not configured: ANTHROPIC_API_KEY environment variable is missing. Add it in Vercel project settings.'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: 'You are a commercial kitchen and refrigeration equipment parts expert. Search for exploded view parts diagrams for the given equipment. Return ONLY valid JSON with this structure: {"found":true/false,"equipment_name":"string","manufacturer_parts_url":"url or null","direct_image_urls":["url1","url2"],"results":[{"title":"","url":"","type":"pdf/image/page","description":"","relevance":"high/medium/low"}],"tips":"string"}. Search official manufacturer sites, parts portals, and service manuals. Be thorough.',
        messages: [{
          role: 'user',
          content: 'Find exploded view parts diagram for: Brand: ' + brand + ', Model: ' + model + '. Search manufacturer parts portal, service manual PDFs, and diagram images. Return JSON only.'
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error', details: data });
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
