// Roblox Tools - Catalog Candidates API.
// GET /api/catalog-candidates?kind=necklaces|pacifiers
// Returns the well-known catalog items of one kind that the inventory
// scan tools check ownership against.
//
// History / why it looks like this (5 Nov 2026 fix): the first version
// enriched search hits with one GET details call per item. From the
// Vercel egress those GETs fail intermittently (rate limiting), every
// failed item was silently dropped, and a fully degraded empty answer
// was then edge-cached for an hour (s-maxage=3600) - so the tools
// reported "0 owned" from a candidate list of zero, which proves
// nothing. Search itself was never the problem (it reliably returns 30
// hits); the enrichment was.
//
// Now:
//   1. Live catalog search (GET) for candidate IDs, one retry.
//   2. Names/prices via ONE batch POST to catalog items/details with
//      the XSRF retry dance (the pattern proven in api/outfit-value.js)
//      instead of 30 individual GETs.
//   3. If that still yields zero candidates, fall back to a hardcoded
//      list of asset IDs verified against the live catalog (names
//      checked item by item on 5 Nov 2026), enriched the same way.
//   4. If even the fallback cannot be enriched, answer
//      { candidates: [], unavailable: true } with a short cache so the
//      pages can say "could not verify" instead of "none found".
// Cache discipline: a full search success caches 1h; a fallback answer
// 10 min; an unavailable answer only 20s so it heals.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const SHORT_CACHE = "s-maxage=20, stale-while-revalidate=20";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KINDS = {
  pacifiers: {
    keyword: "pacifier",
    match: /pacifier/i,
    // Verified live 5 Nov 2026 (catalog details, name + price read back):
    // all named "pacifier" / "Pacifier", prices 55-95 Robux.
    fallbackIds: [
      128753382258116, 110728422719946, 109710318404693, 15948292828,
      86273006074637, 130386670890019, 122947695994145, 90613320498629,
      79398403195928, 16051831302,
    ],
  },
  necklaces: {
    keyword: "initial necklace",
    match: /necklace/i,
    // Verified live 5 Nov 2026 (catalog details, name + price read back):
    // "BB initial necklace: E", "Initial Necklace T", "3.0 Cyber Sigil
    // Initial necklace - E", "Initial Necklace V", "Beaded M Initial
    // Necklace (1.0)", "Initial Necklace: P (Silver)", "TW initial
    // necklace: x", "Kitty Initial Necklaces: V (1.0)", "LB initial
    // necklace: f", "3.0 Initial Necklace Y (Silver)".
    fallbackIds: [
      105268520018751, 100255905493459, 17550945519, 100035927534334,
      90355615211230, 114047563871770, 87604546075468, 17332888241,
      112720141774914, 104205589466749,
    ],
  },
};

async function jfetch(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// One catalog batch-details POST attempt (mirrors api/outfit-value.js).
async function catalogPost(ids, token) {
  try {
    const headers = {
      "User-Agent": UA,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (token) headers["x-csrf-token"] = token;
    const r = await fetch("https://catalog.roblox.com/v1/catalog/items/details", {
      method: "POST",
      headers,
      body: JSON.stringify({ items: ids.map((id) => ({ itemType: "Asset", id })) }),
      signal: AbortSignal.timeout(10000),
    });
    const csrf = r.headers.get("x-csrf-token");
    if (!r.ok) return { status: r.status, csrf, data: null };
    const j = await r.json();
    return { status: 200, csrf, data: j && Array.isArray(j.data) ? j.data : null };
  } catch {
    return { status: 0, csrf: null, data: null };
  }
}

// Batch-resolve catalog entries with the XSRF dance. Returns a Map or
// null when the catalog call itself failed.
async function fetchCatalogItems(ids) {
  let token = null;
  let r = await catalogPost(ids, token);
  if (r.csrf) token = r.csrf;
  if (r.status === 403 && r.csrf) {
    r = await catalogPost(ids, token);
    if (r.csrf) token = r.csrf;
  }
  if (r.status === 429) {
    await sleep(900);
    r = await catalogPost(ids, token);
  }
  if (r.status === 200 && Array.isArray(r.data)) {
    const byId = new Map();
    r.data.forEach((d) => {
      if (d && d.id != null) byId.set(Number(d.id), d);
    });
    return byId;
  }
  return null;
}

function toCandidates(ids, byId, match) {
  const out = [];
  for (const id of ids) {
    const d = byId.get(Number(id));
    if (d && d.name && match.test(d.name)) {
      out.push({
        assetId: Number(id),
        name: d.name,
        price: typeof d.price === "number" ? d.price : null,
      });
    }
  }
  return out;
}

module.exports = async (req, res) => {
  const kind = String((req.query && req.query.kind) || "").trim().toLowerCase();
  const cfg = KINDS[kind];
  if (!cfg) {
    res.status(400).json({ error: "Unknown kind" });
    return;
  }

  // 1. Live search for candidate IDs (one retry on a failed first call).
  let search = await jfetch(
    `https://catalog.roblox.com/v1/search/items?keyword=${encodeURIComponent(cfg.keyword)}&itemType=Asset&limit=30`
  );
  if (!search || !Array.isArray(search.data)) {
    await sleep(700);
    search = await jfetch(
      `https://catalog.roblox.com/v1/search/items?keyword=${encodeURIComponent(cfg.keyword)}&itemType=Asset&limit=30`
    );
  }
  const hits = (search && Array.isArray(search.data) ? search.data : [])
    .filter((d) => d && d.itemType === "Asset" && d.id != null)
    .map((d) => Number(d.id))
    .slice(0, 30);

  // 2. Enrich the search hits in one batch POST.
  if (hits.length) {
    const byId = await fetchCatalogItems(hits);
    if (byId) {
      const candidates = toCandidates(hits, byId, cfg.match);
      if (candidates.length) {
        res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
        res.status(200).json({ kind, keyword: cfg.keyword, candidates, searchCount: hits.length, source: "search" });
        return;
      }
    }
  }

  // 3. Deterministic fallback: verified asset IDs, same enrichment.
  const fb = await fetchCatalogItems(cfg.fallbackIds);
  if (fb) {
    const candidates = toCandidates(cfg.fallbackIds, fb, cfg.match);
    if (candidates.length) {
      res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=120");
      res.status(200).json({ kind, keyword: cfg.keyword, candidates, searchCount: hits.length, source: "fallback" });
      return;
    }
  }

  // 4. Nothing could be verified: say so honestly, cache briefly.
  res.setHeader("Cache-Control", SHORT_CACHE);
  res.status(200).json({ kind, keyword: cfg.keyword, candidates: [], searchCount: hits.length, unavailable: true });
};
