// Vercel Serverless Function — finds a product photo for a spare part.
//
// WHY THIS EXISTS
// A quotation reads far better with a picture beside each part, and typing
// them in one by one for a catalogue of hundreds is not realistic. This looks
// the part up by CODE first, then by name, and returns an image it can fetch.
//
// ── SETUP (one time, ~5 minutes) ──────────────────────────────────────────
// Google's image search needs two values. Both are free at this volume.
//
//  1. Create a search engine:  https://programmablesearchengine.google.com/
//       · "Search the entire web"  → ON
//       · "Image search"           → ON
//       · copy the  Search engine ID  (looks like  a12bc3de4fg5h6i7j )
//
//  2. Get an API key:  https://console.cloud.google.com/apis/credentials
//       · enable "Custom Search API" for the project
//       · create an API key
//
//  3. Vercel → project → Settings → Environment Variables → add BOTH:
//       GOOGLE_CSE_ID   = the Search engine ID from step 1
//       GOOGLE_CSE_KEY  = the API key from step 2
//
//  4. Save this file at  api/part-image.js  and redeploy.
//
// Free tier is 100 searches a day. Results are cached in the app, so each
// part costs one search ONCE — not once per quotation.
//
// ── SELF-TEST ─────────────────────────────────────────────────────────────
//     https://YOUR-SITE.vercel.app/api/part-image
// Reports whether both variables are set and runs a live sample search.

export const maxDuration = 30;

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

// A refrigeration part searches far better with its trade context attached.
// "501069" alone is noise; "501069 compressor refrigeration part" is not.
function buildQueries(code, name) {
  const out = [];
  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const c = clean(code);
  const n = clean(name);

  if (c && n) out.push(`${c} ${n}`);
  if (c) out.push(`${c} spare part`);
  if (n) out.push(`${n} refrigeration spare part`);
  if (n) out.push(n);
  return out.filter(Boolean).slice(0, 4);
}

async function searchImages(query, key, cx) {
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}`
    + `&searchType=image&num=6&safe=active&imgSize=medium`
    + `&q=${encodeURIComponent(query)}`;

  const t = withTimeout(12000);
  try {
    const r = await fetch(url, { signal: t.signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { error: (data.error && data.error.message) || `HTTP ${r.status}`, items: [] };
    }
    return { items: data.items || [] };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'Search timed out' : e.message, items: [] };
  } finally {
    t.done();
  }
}

// Fetch the picture itself and hand it back as a data URL, so the browser
// never has to reach a third-party host — that would be blocked by CORS, and
// the link would rot the moment the seller reorganised their site.
async function fetchAsDataUrl(url) {
  const t = withTimeout(12000);
  try {
    const r = await fetch(url, {
      signal: t.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HRCO-Maintenance/1.0)' }
    });
    if (!r.ok) return null;

    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) return null;

    const buf = Buffer.from(await r.arrayBuffer());
    // Anything huge is a banner or a hero shot, not a part photo
    if (buf.length > 3 * 1024 * 1024) return null;

    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  } finally {
    t.done();
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_ID;

  // ── Self-test ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const report = {
      ok: Boolean(key && cx),
      GOOGLE_CSE_KEY: key ? 'set' : 'MISSING',
      GOOGLE_CSE_ID: cx ? 'set' : 'MISSING'
    };
    if (!report.ok) {
      report.next = 'Add both variables in Vercel → Settings → Environment Variables, then redeploy. Setup steps are in the comments at the top of this file.';
      return res.status(200).json(report);
    }
    const sample = await searchImages('danfoss compressor spare part', key, cx);
    report.sample_query = 'danfoss compressor spare part';
    report.results_found = (sample.items || []).length;
    if (sample.error) report.error = sample.error;
    return res.status(200).json(report);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST with { code, name }' });
  }

  if (!key || !cx) {
    // A clear, actionable answer rather than a silent empty result
    return res.status(200).json({
      found: false,
      reason: 'not_configured',
      message: 'Image search is not set up yet. Add GOOGLE_CSE_ID and GOOGLE_CSE_KEY in Vercel, then redeploy. Steps are at the top of api/part-image.js.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const code = (body && body.code) || '';
  const name = (body && body.name) || '';

  if (!code && !name) {
    return res.status(400).json({ error: 'Send a code or a name' });
  }

  const queries = buildQueries(code, name);
  const tried = [];

  for (const q of queries) {
    const r = await searchImages(q, key, cx);
    tried.push({ q, results: (r.items || []).length, error: r.error || null });

    if (r.error && /quota|rate|limit/i.test(r.error)) {
      return res.status(200).json({
        found: false, reason: 'quota',
        message: 'The daily free search quota is used up. It resets tomorrow.',
        tried
      });
    }

    for (const item of r.items || []) {
      const src = item.link;
      if (!src) continue;
      const dataUrl = await fetchAsDataUrl(src);
      if (dataUrl) {
        return res.status(200).json({
          found: true,
          image: dataUrl,
          source: (item.image && item.image.contextLink) || src,
          title: item.title || '',
          query: q,
          tried
        });
      }
    }
  }

  return res.status(200).json({
    found: false,
    reason: 'no_usable_image',
    message: 'Nothing usable came back for this part. Try a fuller name, or attach a photo yourself.',
    tried
  });
}
