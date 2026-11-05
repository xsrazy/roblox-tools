// Roblox Tools - username / userId resolver shared by tool pages.
// GET /api/resolve?username=<name>  OR  /api/resolve?userId=<id>
// Returns {id, username, displayName, description, created, isBanned}. Never throws.

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
  const q = req.query || {};
  const username = String(q.username || "").trim();
  const userId = String(q.userId || "").trim();

  let id = null;
  if (/^\d+$/.test(userId)) {
    id = Number(userId);
  } else if (username) {
    const resolved = await jfetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const entry = resolved && Array.isArray(resolved.data) ? resolved.data[0] : null;
    if (!entry || !entry.id) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    id = entry.id;
  } else {
    res.status(400).json({ error: "Missing username or userId" });
    return;
  }

  const user = await jfetch(`https://users.roblox.com/v1/users/${id}`);
  if (!user || !user.name) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(200).json({
    id,
    username: user.name,
    displayName: user.displayName || null,
    description: typeof user.description === "string" ? user.description : null,
    created: user.created || null,
    isBanned: !!user.isBanned,
  });
};
