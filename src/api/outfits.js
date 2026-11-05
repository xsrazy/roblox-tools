// Roblox Tools - Outfits API.
// GET /api/outfits?userId=<id>
// Lists the user's outfits. For the first 24 outfits it also returns the
// items each outfit is made of (asset id, name, thumbnail image URL),
// resolved from the public outfit-details endpoint and the public asset
// thumbnails endpoint. Degrades gracefully: any failed step just yields
// fewer items, never an error. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// The details endpoint allows only a handful of calls per IP per window
// (shared Vercel egress IPs included), so detail just the first outfits:
// fewer calls that mostly succeed beats many calls that mostly 429.
const MAX_DETAILED_OUTFITS = 8;
const MAX_ITEMS_PER_OUTFIT = 12;

async function jfetch(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pfetch(url, body) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Outfit preview renders: every GET route for outfit thumbnails 404s, but
// the thumbnails BATCH endpoint with type "Outfit" returns a real rendered
// avatar image of the outfit (verified live 5 Nov 2026, 420x420 PNG).
// One POST covers up to 100 outfits, so this is cheap and not rate limited
// the way the outfit-details endpoint is.
async function resolveOutfitThumbs(outfits) {
  for (let i = 0; i < outfits.length; i += 100) {
    const chunk = outfits.slice(i, i + 100);
    const r = await pfetch(
      "https://thumbnails.roblox.com/v1/batch",
      chunk.map((o) => ({
        requestId: "o" + o.id,
        type: "Outfit",
        targetId: Number(o.id),
        format: "Png",
        size: "420x420",
        isCircular: false,
      }))
    );
    const data = r && Array.isArray(r.data) ? r.data : [];
    const byId = {};
    data.forEach((d) => {
      if (d && d.targetId != null && d.state === "Completed" && d.imageUrl)
        byId[d.targetId] = d.imageUrl;
    });
    chunk.forEach((o) => {
      o.imageUrl = byId[o.id] || null;
    });
  }
}

// The outfit-details endpoint rate-limits hard per IP (429 after a small
// burst, verified live). Fetch gently (small pool) and retry 429s with
// backoff; whatever still fails degrades to an outfit with no items.
async function fetchDetailsAssets(outfitId) {
  const backoff = [500];
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const r = await fetch(`https://avatar.roblox.com/v1/outfits/${outfitId}/details`, {
        signal: AbortSignal.timeout(4500),
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (r.ok) {
        const det = await r.json();
        return Array.isArray(det && det.assets) ? det.assets : [];
      }
      if (r.status !== 429) return [];
    } catch {
      return [];
    }
    if (attempt < backoff.length) await sleep(backoff[attempt]);
  }
  return [];
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const userId = String((req.query && req.query.userId) || "").trim();
  if (!/^\d+$/.test(userId)) {
    res.status(400).json({ error: "Missing or invalid userId" });
    return;
  }

  // The upstream list endpoint intermittently answers 200 with an empty
  // data array under throttle (seen live: builderman returning 0 outfits,
  // then 35 on the next call). Retry empty or failed list responses a few
  // times before believing them; a genuine zero survives all retries.
  let list = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 500 : 1500));
    list = await jfetch(
      `https://avatar.roblox.com/v1/users/${userId}/outfits?itemsPerPage=100`
    );
    if (list && Array.isArray(list.data) && list.data.length > 0) break;
  }
  const items = list && Array.isArray(list.data) ? list.data : [];
  if (!items.length) {
    // A failed list fetch (rate limited upstream) must not be edge cached
    // as "this user has no outfits"; only cache a genuinely empty list.
    if (!list) res.setHeader("Cache-Control", "no-store");
    else res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
    res.status(200).json({ outfits: [] });
    return;
  }

  const outfits = items.map((o) => ({
    id: o.id,
    name: o.name || "",
    imageUrl: null,
    items: [],
  }));

  // Outfit preview renders via the batch endpoint (runs concurrently with
  // the details workers below so total latency stays low).
  const thumbsPromise = resolveOutfitThumbs(outfits);

  // 1) Outfit details for the first N outfits: the assets each outfit uses.
  //    Small worker pool (4) so we do not trip the details rate limiter.
  const detailed = outfits.slice(0, MAX_DETAILED_OUTFITS);
  let cursor = 0;
  async function worker() {
    while (cursor < detailed.length) {
      const o = detailed[cursor++];
      const assets = await fetchDetailsAssets(o.id);
      o.items = assets.slice(0, MAX_ITEMS_PER_OUTFIT).map((a) => ({
        assetId: a.id,
        name: a.name || "",
        imageUrl: null,
      }));
    }
  }
  await Promise.all([worker(), worker(), worker(), thumbsPromise]);

  // 2) Batch-resolve asset thumbnails for every collected asset id.
  const allIds = [];
  detailed.forEach((o) => o.items.forEach((it) => allIds.push(it.assetId)));
  const thumbById = {};
  for (let i = 0; i < allIds.length; i += 100) {
    const chunk = allIds.slice(i, i + 100);
    const th = await jfetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${chunk.join(",")}&size=150x150&format=Png&isCircular=false`
    );
    const data = th && Array.isArray(th.data) ? th.data : [];
    data.forEach((d) => {
      if (d && d.targetId != null && d.imageUrl) thumbById[d.targetId] = d.imageUrl;
    });
  }
  detailed.forEach((o) =>
    o.items.forEach((it) => {
      it.imageUrl = thumbById[it.assetId] || null;
    })
  );

  // If every outfit thumbnail failed (upstream throttling), keep the edge
  // cache short so the page heals quickly instead of serving blank tiles.
  if (outfits.length && outfits.some((o) => !o.imageUrl)) {
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
  }

  res.status(200).json({ outfits });
};
