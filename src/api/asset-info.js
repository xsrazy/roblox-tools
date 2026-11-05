// Roblox Tools - Asset Info API.
// GET /api/asset-info?assetId=<id>
// Proxies https://economy.roblox.com/v2/assets/{id}/details (not CORS-open,
// verified by VM curl: 200 with no Access-Control-Allow-Origin) and the
// public asset thumbnail endpoint. Returns name / creator / type plus the
// 420x420 thumbnail imageUrl. Asset size 768x768 was probed and returns
// 400 (invalid size), so 420x420 is the largest size used. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Subset of the public Roblox AssetType enum (ids verified against live
// responses where possible: 2 = TShirt and 8 = Hat from avatar details,
// 41 = Hair Accessory from the Pal Hair thumbnail path). Unknown ids
// degrade to "Asset type <id>" rather than a guessed name.
const ASSET_TYPES = {
  1: "Image", 2: "T-Shirt", 3: "Audio", 4: "Mesh", 8: "Hat", 9: "Place",
  10: "Model", 11: "Shirt", 12: "Pants", 13: "Decal", 17: "Head",
  18: "Face", 19: "Gear", 21: "Badge", 22: "Animation", 32: "Package",
  41: "Hair Accessory", 42: "Face Accessory", 43: "Neck Accessory",
  44: "Shoulder Accessory", 45: "Front Accessory", 46: "Back Accessory",
  47: "Waist Accessory",
};

async function jfetch(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
    });
    if (!r.ok) return { status: r.status, data: null };
    return { status: r.status, data: await r.json() };
  } catch {
    return { status: 0, data: null };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const assetId = String((req.query && req.query.assetId) || "").trim();
  if (!/^\d+$/.test(assetId)) {
    res.status(400).json({ error: "Missing or invalid assetId" });
    return;
  }

  const [details, thumb] = await Promise.all([
    jfetch(`https://economy.roblox.com/v2/assets/${assetId}/details`),
    jfetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=420x420&format=Png&isCircular=false`
    ),
  ]);

  const d = details.data;
  const t = thumb.data && Array.isArray(thumb.data.data) ? thumb.data.data[0] : null;
  const imageUrl = t && t.state === "Completed" ? t.imageUrl || null : null;

  if (!d && !imageUrl) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  const typeId = d && typeof d.AssetTypeId === "number" ? d.AssetTypeId : null;
  res.status(200).json({
    assetId: Number(assetId),
    name: (d && d.Name) || null,
    description: d && typeof d.Description === "string" ? d.Description : null,
    creator: d && d.Creator ? d.Creator.Name || null : null,
    creatorType: d && d.Creator ? d.Creator.CreatorType || null : null,
    creatorId: d && d.Creator ? d.Creator.CreatorTargetId || d.Creator.Id || null : null,
    assetTypeId: typeId,
    assetType: typeId != null ? ASSET_TYPES[typeId] || "Asset type " + typeId : null,
    priceInRobux: d && typeof d.PriceInRobux === "number" ? d.PriceInRobux : null,
    isForSale: d && typeof d.IsForSale === "boolean" ? d.IsForSale : null,
    isLimited: d ? !!(d.IsLimited || d.IsLimitedUnique) : null,
    created: (d && d.Created) || null,
    imageUrl,
  });
};
