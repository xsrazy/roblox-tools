// Roblox Tools - Avatar Render API.
// GET /api/avatar-render?userId=<id>&type=avatar|bust|headshot&size=420x420&isCircular=false
// Proxies the public thumbnails endpoints (not CORS-open from the browser):
//   avatar   -> /v1/users/avatar          (probed sizes: 720,420,352,150,100,48 all 200)
//   bust     -> /v1/users/avatar-bust     (720x720 probed 400 invalid; 420,352,150,100 = 200)
//   headshot -> /v1/users/avatar-headshot (420 max used per spec; 420,352,150,100,48 = 200)
// Returns {imageUrl, state}. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const TYPES = {
  avatar: { path: "avatar", sizes: ["720x720", "420x420", "352x352", "150x150", "100x100", "48x48"] },
  bust: { path: "avatar-bust", sizes: ["420x420", "352x352", "150x150", "100x100"] },
  headshot: { path: "avatar-headshot", sizes: ["420x420", "352x352", "150x150", "100x100", "48x48"] },
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const q = req.query || {};
  const userId = String(q.userId || "").trim();
  const type = String(q.type || "avatar").trim();
  const spec = TYPES[type];
  if (!/^\d+$/.test(userId) || !spec) {
    res.status(400).json({ error: "Missing or invalid userId or type" });
    return;
  }
  const size = spec.sizes.includes(String(q.size || "")) ? String(q.size) : spec.sizes[0] === "720x720" && type !== "avatar" ? "420x420" : type === "avatar" ? "720x720" : "420x420";
  const isCircular = String(q.isCircular || "false") === "true" ? "true" : "false";

  try {
    const r = await fetch(
      `https://thumbnails.roblox.com/v1/users/${spec.path}?userIds=${userId}&size=${size}&format=Png&isCircular=${isCircular}`,
      { headers: { "User-Agent": UA, Accept: "application/json" } }
    );
    if (!r.ok) {
      res.status(502).json({ error: "Render lookup failed" });
      return;
    }
    const data = await r.json();
    const entry = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!entry || !entry.imageUrl) {
      res.status(404).json({ error: "Render not available" });
      return;
    }
    res.status(200).json({ userId: Number(userId), type, size, isCircular: isCircular === "true", state: entry.state || null, imageUrl: entry.imageUrl });
  } catch {
    res.status(502).json({ error: "Render lookup failed" });
  }
};
