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
//       GOOGLE_CSE_CX   = the Search engine ID from step 1
//                         (GOOGLE_CSE_ID is accepted too — the diagram search
//                          set this up first under the name GOOGLE_CSE_CX)
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

// Parts-catalogue sites are full of exploded DIAGRAMS, and a plain image
// search returns those first. Two things push it towards real photographs:
// imgType=photo (below), and telling the query what we do NOT want.
const NOT_A_PHOTO = '-diagram -drawing -schematic -exploded -blueprint -"parts list" -manual';

// A refrigeration part searches far better with its trade context attached.
// "501069" alone is noise; "501069 compressor product photo" is not.
function buildQueries(code, name) {
  const out = [];
  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const c = clean(code);
  const n = clean(name);

  // Most specific first — the code with the name usually finds the exact item
  if (c && n) out.push(`${c} ${n} ${NOT_A_PHOTO}`);
  if (n) out.push(`${n} refrigeration part product photo ${NOT_A_PHOTO}`);
  if (c) out.push(`${c} spare part ${NOT_A_PHOTO}`);
  if (n) out.push(`${n} ${NOT_A_PHOTO}`);
  return out.filter(Boolean).slice(0, 4);
}

// A last guard: even with imgType=photo, a line-art result sometimes slips in
// under a filename that gives it away.
function looksLikeDrawing(item) {
  const hay = ((item.title || '') + ' ' + (item.snippet || '') + ' ' + (item.link || '')).toLowerCase();
  return /diagram|schematic|exploded|blueprint|drawing|lineart|line-art|parts[-_ ]?list/.test(hay);
}

async function searchImages(query, key, cx, photoOnly) {
  // imgType=photo tells Google to return photographs and leave line art,
  // clipart and diagrams out — which is exactly what was coming back before.
  const url = `${ENDPOINT}?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}`
    + `&searchType=image&num=8&safe=active&imgSize=medium`
    + (photoOnly === false ? '' : '&imgType=photo')
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

  // The search-engine id was already set up for the diagram search under the
  // name GOOGLE_CSE_CX, so accept either spelling rather than making anyone
  // rename a working variable.
  const key = process.env.GOOGLE_CSE_KEY || process.env.GOOGLE_API_KEY;
  const cx  = process.env.GOOGLE_CSE_CX  || process.env.GOOGLE_CSE_ID;

  // ── Self-test ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const report = {
      ok: Boolean(key && cx),
      search_key: key ? 'set' : 'MISSING  (GOOGLE_CSE_KEY)',
      search_engine_id: cx ? 'set' : 'MISSING  (GOOGLE_CSE_CX or GOOGLE_CSE_ID)'
    };
    if (!report.ok) {
      report.next = 'Add the missing one in Vercel → Settings → Environment Variables, then redeploy. Either GOOGLE_CSE_CX or GOOGLE_CSE_ID works for the search engine id.';
      return res.status(200).json(report);
    }
    const q = 'danfoss compressor ' + NOT_A_PHOTO;
    const sample = await searchImages(q, key, cx, true);
    report.sample_query = q;
    report.results_found = (sample.items || []).length;
    report.sample_titles = (sample.items || []).slice(0, 5).map(i => i.title);
    report.drawings_filtered_out = (sample.items || []).filter(looksLikeDrawing).length;
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
      message: 'Image search is not set up yet. Vercel needs GOOGLE_CSE_KEY and either GOOGLE_CSE_CX or GOOGLE_CSE_ID, then a redeploy.'
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

  // Pass 1 insists on photographs. Pass 2 only runs if that found nothing at
  // all, and drops the restriction rather than leaving him with no picture.
  for (const photoOnly of [true, false]) {
    for (const q of queries) {
      const r = await searchImages(q, key, cx, photoOnly);
      tried.push({ q, photoOnly, results: (r.items || []).length, error: r.error || null });

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
        // On the strict pass, refuse anything that reads like a drawing
        if (photoOnly && looksLikeDrawing(item)) continue;

        const dataUrl = await fetchAsDataUrl(src);
        if (dataUrl) {
          return res.status(200).json({
            found: true,
            image: dataUrl,
            source: (item.image && item.image.contextLink) || src,
            title: item.title || '',
            query: q,
            photoOnly,
            tried
          });
        }
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
