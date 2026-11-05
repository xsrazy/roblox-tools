// Roblox Tools - Outfit Value API.
// GET /api/outfit-value?userId=<id>&outfitId=<id>
// Prices one saved outfit item by item and totals it in Robux.
//
// Price sources (all verified live from Vercel egress, 5 Nov 2026):
// - POST https://catalog.roblox.com/v1/catalog/items/details with the XSRF
//   dance: the first POST is answered 403 with an x-csrf-token header;
//   repeating the POST with that header returns 200. Per item:
//     regular item  -> "price" (current price when on sale, 0 with
//                      priceStatus "Free" for free items, last listed price
//                      when priceStatus is "Off Sale")
//     limited item  -> "lowestResalePrice" when the item has resellers,
//                      otherwise the RAP fallback below
//     body parts / uncatalogued assets -> no price fields at all (or the
//                      item is absent from the response): no price data
// - RAP fallback for limiteds: the owner's collectibles scan (the same
//   scan-first pattern as api/inventory.js), matched by assetId; an item
//   found there takes its recentAveragePrice and is marked limited.
// Cache discipline (same lessons as outfits.js / inventory.js): full
// success caches s-maxage=300; a degraded answer (the catalog call itself
// failed) caches only 20s so it heals; hard errors are never cached as
// success. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const SHORT_CACHE = "s-maxage=20, stale-while-revalidate=20";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Outfit details, status aware (mirrors api/outfit-details.js): the
// endpoint rate-limits hard per IP, so 429s retry with backoff; a 404 is
// passed through so the caller can answer a real not-found.
async function fetchOutfitDetails(outfitId) {
  const backoff = [800, 2000];
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const r = await fetch(`https://avatar.roblox.com/v1/outfits/${outfitId}/details`, {
        signal: AbortSignal.timeout(6000),
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (r.ok) return { status: 200, data: await r.json() };
      if (r.status === 404) return { status: 404, data: null };
      if (r.status !== 429) return { status: r.status, data: null };
    } catch {
      return { status: 0, data: null };
    }
    if (attempt < backoff.length) await sleep(backoff[attempt]);
  }
  return { status: 429, data: null };
}

// One catalog POST attempt. Returns { status, csrf, data } where data is
// the parsed items array on a clean 200, otherwise null.
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

// Batch-resolve catalog entries for up to all outfit asset ids.
// Returns { byId: Map<assetId, catalogItem>, failed: boolean }. The CSRF
// token is cached for this invocation only and reused across chunks.
async function fetchCatalogItems(assetIds) {
  const byId = new Map();
  let token = null;
  let failed = false;
  for (let i = 0; i < assetIds.length; i += 100) {
    const chunk = assetIds.slice(i, i + 100);
    let r = await catalogPost(chunk, token);
    if (r.csrf) token = r.csrf;
    if (r.status === 403 && r.csrf) {
      r = await catalogPost(chunk, token);
      if (r.csrf) token = r.csrf;
    }
    if (r.status === 429) {
      await sleep(900);
      r = await catalogPost(chunk, token);
      if (r.csrf) token = r.csrf;
    }
    if (r.status === 200 && Array.isArray(r.data)) {
      r.data.forEach((d) => {
        if (d && d.id != null) byId.set(Number(d.id), d);
      });
    } else {
      failed = true;
    }
  }
  return { byId, failed };
}

// Owner collectibles scan for the RAP fallback: same shape as
// api/inventory.js scanCollectibles (Asc, paginated, cap 10 pages, first
// page retried once). Returns an array or null when the first page fails
// (private inventory or a transient error).
async function scanCollectibles(userId) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const u = new URL(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`);
    u.searchParams.set("assetType", "All");
    u.searchParams.set("sortOrder", "Asc");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    let data = await jfetch(u.toString());
    if ((!data || !Array.isArray(data.data)) && page === 0) {
      await sleep(800);
      data = await jfetch(u.toString());
    }
    if (!data || !Array.isArray(data.data)) return items.length ? items : null;
    for (const item of data.data) items.push(item);
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return items;
}

// Item thumbnails via the thumbnails batch endpoint (type Asset) - the
// same Roblox endpoint api/thumbs.js proxies, resolved inline here.
async function resolveItemThumbs(items) {
  const ids = items.map((it) => it.assetId);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await jfetch("https://thumbnails.roblox.com/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        chunk.map((id) => ({
          requestId: "a" + id,
          type: "Asset",
          targetId: id,
          format: "Png",
          size: "150x150",
          isCircular: false,
        }))
      ),
    });
    const data = r && Array.isArray(r.data) ? r.data : [];
    const byId = {};
    data.forEach((d) => {
      if (d && d.targetId != null && d.state === "Completed" && d.imageUrl)
        byId[d.targetId] = d.imageUrl;
    });
    items.forEach((it) => {
      if (byId[it.assetId]) it.imageUrl = byId[it.assetId];
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const q = req.query || {};
  const userId = String(q.userId || "").trim();
  const outfitId = String(q.outfitId || "").trim();
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(outfitId)) {
    res.status(400).json({ error: "Missing or invalid userId or outfitId" });
    return;
  }

  const det = await fetchOutfitDetails(outfitId);
  if (det.status === 404) {
    res.setHeader("Cache-Control", SHORT_CACHE);
    res.status(404).json({ error: "Outfit not found" });
    return;
  }
  if (!det.data) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "Could not load this outfit right now. Please try again." });
    return;
  }
  const d = det.data;
  const assets = Array.isArray(d.assets) ? d.assets : [];
  const items = assets
    .filter((a) => a && a.id != null)
    .map((a) => ({
      assetId: Number(a.id),
      name: a.name || "",
      imageUrl: null,
      price: null,
      priceSource: "none",
      isLimited: false,
    }));

  // Catalog prices and thumbnails are independent; run them together.
  const uniqueIds = [...new Set(items.map((it) => it.assetId))];
  const [catalog] = await Promise.all([
    uniqueIds.length ? fetchCatalogItems(uniqueIds) : Promise.resolve({ byId: new Map(), failed: false }),
    resolveItemThumbs(items),
  ]);

  const needsRap = [];
  items.forEach((it) => {
    const c = catalog.byId.get(it.assetId);
    if (c) {
      const restrictions = Array.isArray(c.itemRestrictions) ? c.itemRestrictions : [];
      it.isLimited =
        restrictions.indexOf("Limited") !== -1 || restrictions.indexOf("LimitedUnique") !== -1;
      if (!it.isLimited) {
        if (typeof c.price === "number") {
          it.price = c.price;
          it.priceSource = "catalog";
        }
        return;
      }
      // Limited: the lowest current resale price from the catalog when the
      // item actually has resellers; otherwise the RAP fallback below.
      if (
        c.hasResellers &&
        typeof c.lowestResalePrice === "number" &&
        c.lowestResalePrice > 0
      ) {
        it.price = c.lowestResalePrice;
        it.priceSource = "catalog";
        return;
      }
      needsRap.push(it);
      return;
    }
    // No catalog entry at all: the item may still be a limited the owner
    // holds (some classic assets are not in the catalog index), so let the
    // RAP scan decide.
    needsRap.push(it);
  });

  if (needsRap.length) {
    const scan = await scanCollectibles(userId);
    if (scan) {
      const rapById = new Map();
      scan.forEach((s) => {
        if (s && s.assetId != null && typeof s.recentAveragePrice === "number" && !rapById.has(s.assetId))
          rapById.set(s.assetId, s.recentAveragePrice);
      });
      needsRap.forEach((it) => {
        if (rapById.has(it.assetId)) {
          it.price = rapById.get(it.assetId);
          it.priceSource = "rap";
          it.isLimited = true;
        }
      });
    }
  }

  let totalRobux = 0;
  let pricedCount = 0;
  items.forEach((it) => {
    if (typeof it.price === "number") {
      totalRobux += it.price;
      pricedCount += 1;
    }
  });

  // A failed catalog call means most prices were never really looked up:
  // keep the edge cache short so the answer heals on the next request.
  if (catalog.failed) res.setHeader("Cache-Control", SHORT_CACHE);

  res.status(200).json({
    outfitId: Number(outfitId),
    outfitName: d.name || null,
    items,
    totalRobux,
    pricedCount,
    unpricedCount: items.length - pricedCount,
  });
};
