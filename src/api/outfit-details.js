// Roblox Tools - Outfit Details API (single outfit, by outfit ID).
// GET /api/outfit-details?outfitId=<id>
// Proxies GET https://avatar.roblox.com/v1/outfits/{id}/details and resolves
// each item's thumbnail through the public asset thumbnails batch endpoint.
// The details endpoint rate-limits hard per IP (verified live), so 429s are
// retried with the same backoff as api/outfits.js: [800, 2000].
// A 404 from Roblox is passed through as a clean not-found. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDetails(outfitId) {
  const backoff = [800, 2000];
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const r = await fetch(`https://avatar.roblox.com/v1/outfits/${outfitId}/details`, {
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

async function jfetch(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const outfitId = String((req.query && req.query.outfitId) || "").trim();
  if (!/^\d+$/.test(outfitId)) {
    res.status(400).json({ error: "Missing or invalid outfitId" });
    return;
  }

  const det = await fetchDetails(outfitId);
  if (det.status === 404 || !det.data) {
    res.status(404).json({ error: "Outfit not found" });
    return;
  }
  const d = det.data;
  const assets = Array.isArray(d.assets) ? d.assets : [];
  const items = assets.map((a) => ({
    assetId: a.id,
    name: a.name || "",
    assetType: a.assetType && a.assetType.name ? a.assetType.name : null,
    imageUrl: null,
  }));

  const thumbById = {};
  const ids = items.map((it) => it.assetId).filter((v) => v != null);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const th = await jfetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${chunk.join(",")}&size=150x150&format=Png&isCircular=false`
    );
    const data = th && Array.isArray(th.data) ? th.data : [];
    data.forEach((e) => {
      if (e && e.targetId != null && e.imageUrl) thumbById[e.targetId] = e.imageUrl;
    });
  }
  items.forEach((it) => {
    it.imageUrl = thumbById[it.assetId] || null;
  });

  res.status(200).json({
    outfitId: Number(outfitId),
    name: d.name || null,
    playerAvatarType: d.playerAvatarType || null,
    outfitType: d.outfitType || null,
    isEditable: typeof d.isEditable === "boolean" ? d.isEditable : null,
    items,
  });
};
