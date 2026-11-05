// Roblox Tools - Avatar Info API.
// GET /api/avatar-info?userId=<id>
// Returns {avatar, assets, emotes} from the public avatar endpoint.
// Verified live response keys for GET avatar.roblox.com/v1/users/{id}/avatar:
//   scales, playerAvatarType, bodyColors, assets, defaultShirtApplied,
//   defaultPantsApplied, emotes
// emotes is an array of {assetId, assetName, position} (empty when the user
// has no emotes equipped, e.g. builderman; ***** has 7).
// Never throws: failure degrades to {avatar: null, assets: [], emotes: []}.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function jfetch(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const userId = String((req.query && req.query.userId) || "").trim();
  if (!/^\d+$/.test(userId)) {
    res.status(400).json({ error: "Missing or invalid userId" });
    return;
  }

  const avatar = await jfetch(`https://avatar.roblox.com/v1/users/${userId}/avatar`);
  if (!avatar || typeof avatar !== "object") {
    res.status(200).json({ avatar: null, assets: [], emotes: [] });
    return;
  }

  const assets = (Array.isArray(avatar.assets) ? avatar.assets : []).map((a) => ({
    id: a && a.id != null ? a.id : null,
    name: (a && a.name) || "",
    assetTypeName: (a && a.assetType && a.assetType.name) || "",
  }));

  const emotes = (Array.isArray(avatar.emotes) ? avatar.emotes : []).map((e) => ({
    assetId: e && e.assetId != null ? e.assetId : null,
    assetName: (e && e.assetName) || "",
    position: e && typeof e.position === "number" ? e.position : null,
  }));

  res.status(200).json({ avatar, assets, emotes });
};
