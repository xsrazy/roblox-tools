// Roblox Tools - Groups API.
// GET /api/groups?userId=<id>   -> the groups a user belongs to, with roles.
// GET /api/groups?groupId=<id>  -> details for one group.
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

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const q = req.query || {};
  const userRaw = String(q.userId || "").trim();
  const groupRaw = String(q.groupId || "").trim();

  // Mode 1: a user's groups and roles.
  if (/^\d+$/.test(userRaw)) {
    const userId = Number(userRaw);
    const data = await jfetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    if (!data || !Array.isArray(data.data)) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const groups = [];
    for (const item of data.data) {
      const g = (item && item.group) || {};
      const role = (item && item.role) || {};
      if (!g.id) continue;
      groups.push({
        groupId: num(g.id),
        name: g.name || null,
        memberCount: num(g.memberCount),
        roleName: role.name || null,
        rank: num(role.rank),
        isPrimary: typeof item.isPrimaryGroup === "boolean" ? item.isPrimaryGroup : null,
      });
    }
    res.status(200).json({ userId, groups, total: groups.length });
    return;
  }

  // Mode 2: one group's details.
  if (/^\d+$/.test(groupRaw)) {
    const groupId = Number(groupRaw);
    const g = await jfetch(`https://groups.roblox.com/v1/groups/${groupId}`);
    if (!g || !g.id) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const owner = g.owner || {};
    res.status(200).json({
      id: num(g.id),
      name: g.name || null,
      description: typeof g.description === "string" ? g.description : null,
      memberCount: num(g.memberCount),
      ownerName: owner.username || null,
      ownerId: num(owner.userId),
      isBuildersClubOnly: typeof g.isBuildersClubOnly === "boolean" ? g.isBuildersClubOnly : null,
      publicEntryAllowed: typeof g.publicEntryAllowed === "boolean" ? g.publicEntryAllowed : null,
      created: g.created || null,
    });
    return;
  }

  res.status(400).json({ error: "Missing userId or groupId" });
};
