// Roblox Tools - Account Checker API.
// GET /api/user?username=<name>
// Server-side proxy to the public Roblox APIs. Returns one clean JSON.
// Never throws: partial failures degrade to null fields.

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// can-view-inventory gates both the inventory badge and RAP; a single
// transient failure (429/timeout) used to blank both. Retry it briefly.
async function fetchCanView(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const inv = await jfetch(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`);
    if (inv && typeof inv.canView === "boolean") return inv.canView;
    if (attempt < 2) await sleep(500 * (attempt + 1));
  }
  return null;
}

async function computeRap(userId) {
  let total = 0;
  let cursor = null;
  let any = false;
  for (let page = 0; page < 10; page++) {
    const u = new URL(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`);
    u.searchParams.set("assetType", "All");
    u.searchParams.set("sortOrder", "Asc");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    let data = await jfetch(u.toString());
    if ((!data || !Array.isArray(data.data)) && page === 0 && !any) {
      await sleep(800);
      data = await jfetch(u.toString());
    }
    if (!data || !Array.isArray(data.data)) return any ? total : null;
    for (const item of data.data) {
      if (typeof item.recentAveragePrice === "number") {
        total += item.recentAveragePrice;
        any = true;
      }
    }
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return any ? total : 0;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const username = String((req.query && req.query.username) || "").trim();
  if (!username) {
    res.status(400).json({ error: "Missing username" });
    return;
  }

  // 1. Resolve username -> ID. Numeric input is a user ID directly (the
  // same rule the tool pages use), so a pasted profile link, which the
  // homepage converts to its ID, lands on the right account.
  let entry = null;
  if (/^\d+$/.test(username)) {
    const byId = await jfetch(`https://users.roblox.com/v1/users/${username}`);
    if (byId && byId.id) entry = { id: byId.id, name: byId.name };
  } else {
    const resolved = await jfetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    entry = resolved && Array.isArray(resolved.data) ? resolved.data[0] : null;
  }
  if (!entry || !entry.id) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const id = entry.id;

  // 2-6. Fetch everything else in parallel; each degrades to null.
  const [user, friendsCount, followersCount, followingsCount, presence, canView, headshot] =
    await Promise.all([
      jfetch(`https://users.roblox.com/v1/users/${id}`),
      jfetch(`https://friends.roblox.com/v1/users/${id}/friends/count`),
      jfetch(`https://friends.roblox.com/v1/users/${id}/followers/count`),
      jfetch(`https://friends.roblox.com/v1/users/${id}/followings/count`),
      jfetch("https://presence.roblox.com/v1/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [id] }),
      }),
      fetchCanView(id),
      jfetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=420x420&format=Png&isCircular=true`
      ),
    ]);

  const p = presence && Array.isArray(presence.userPresences) ? presence.userPresences[0] : null;

  // 7. RAP only for public inventories.
  let rap = null;
  if (canView === true) rap = await computeRap(id);

  // A degraded response (inventory check rate limited to null) must not sit
  // in the edge cache for 5 minutes hiding the Private/Public badge; cache
  // it only briefly so the next lookup heals itself.
  if (canView === null) {
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
  }

  res.status(200).json({
    id,
    username: (user && user.name) || entry.name || username,
    displayName: (user && user.displayName) || null,
    description: user && typeof user.description === "string" ? user.description : null,
    created: (user && user.created) || null,
    isBanned: !!(user && user.isBanned),
    friends: friendsCount && typeof friendsCount.count === "number" ? friendsCount.count : null,
    followers:
      followersCount && typeof followersCount.count === "number" ? followersCount.count : null,
    followings:
      followingsCount && typeof followingsCount.count === "number" ? followingsCount.count : null,
    presenceType: p && typeof p.userPresenceType === "number" ? p.userPresenceType : null,
    canViewInventory: canView,
    headshot:
      headshot && Array.isArray(headshot.data) && headshot.data[0]
        ? headshot.data[0].imageUrl || null
        : null,
    rap,
    value: null,
  });
};
