// Roblox Tools - Bundle Info API.
// GET /api/bundle-info?bundleId=<id>
// Thumbnail: GET https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=<id>&size=420x420&format=Png
//   NOTE: the singular form /v1/bundles/thumbnail was probed by VM curl and
//   returns 404 for every id; the plural /thumbnails form returns 200 with
//   state Completed and a non-null imageUrl (verified bundleId 192,
//   Korblox Deathspeaker). This proxy uses the working plural form.
// Details: GET https://catalog.roblox.com/v1/bundles/{id}/details
//   (probed by VM curl: 200 without any CSRF token, e.g. ids 1, 2, 3, 158, 192).
// Neither endpoint sends CORS headers, so both are proxied here. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

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
  const bundleId = String((req.query && req.query.bundleId) || "").trim();
  if (!/^\d+$/.test(bundleId)) {
    res.status(400).json({ error: "Missing or invalid bundleId" });
    return;
  }

  const [thumb, details] = await Promise.all([
    jfetch(
      `https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${bundleId}&size=420x420&format=Png`
    ),
    jfetch(`https://catalog.roblox.com/v1/bundles/${bundleId}/details`),
  ]);

  const t = thumb && Array.isArray(thumb.data) ? thumb.data[0] : null;
  const imageUrl = t && t.state === "Completed" ? t.imageUrl || null : null;

  if (!details && !imageUrl) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }

  const items = details && Array.isArray(details.items) ? details.items : [];
  res.status(200).json({
    bundleId: Number(bundleId),
    name: (details && details.name) || null,
    description: details && typeof details.description === "string" ? details.description : null,
    bundleType: (details && details.bundleType) || null,
    creator: details && details.creator ? details.creator.name || null : null,
    creatorType: details && details.creator ? details.creator.type || null : null,
    priceInRobux:
      details && details.product && typeof details.product.priceInRobux === "number"
        ? details.product.priceInRobux
        : null,
    isForSale:
      details && details.product && typeof details.product.isForSale === "boolean"
        ? details.product.isForSale
        : null,
    itemsCount: items.length,
    items: items.slice(0, 30).map((it) => ({ id: it.id, name: it.name || "", type: it.type || null })),
    imageUrl,
  });
};
