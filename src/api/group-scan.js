// Roblox Tools - Group Item Scan API.
// GET /api/group-scan?userId=<id>&groupId=<id>
// Finds a group's catalog assets (catalog search filtered by creator:
// creatorType=Group&creatorTargetId=<groupId>, verified live), then
// checks which of them the user owns:
//   1. Intersection with the user's public collectibles list (carries RAP).
//   2. GET inventory.roblox.com/v1/users/{id}/items/Asset/{assetId} for
//      the rest (covers non-limited group items).
// Coverage is bounded and reported honestly: at most 5 search pages of
// 30 (150 asset IDs). Private inventories return {private:true}.
// Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const MAX_PAGES = 5;
const MAX_IDS = 150;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCanView(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data } = await jfetch(
      `https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`
    );
    if (data && typeof data.canView === "boolean") return data.canView;
    if (attempt < 2) await sleep(500 * (attempt + 1));
  }
  return null;
}

async function scanCollectibles(userId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const u = new URL(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`);
    u.searchParams.set("assetType", "All");
    u.searchParams.set("sortOrder", "Asc");
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    let { status, data } = await jfetch(u.toString());
    if ((!data || !Array.isArray(data.data)) && page === 0) {
      if (status === 403) return null;
      await sleep(800);
      ({ status, data } = await jfetch(u.toString()));
    }
    if (!data || !Array.isArray(data.data)) break;
    for (const item of data.data) out.push(item);
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=60");
  const q = req.query || {};
  const userId = String(q.userId || "").trim();
  const groupId = String(q.groupId || "").trim();
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(groupId)) {
    res.status(400).json({ error: "Missing or invalid userId / groupId" });
    return;
  }

  // 1. The group's catalog assets via creator-filtered search.
  const groupIds = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let searchFailed = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL("https://catalog.roblox.com/v1/search/items");
    u.searchParams.set("creatorType", "Group");
    u.searchParams.set("creatorTargetId", groupId);
    u.searchParams.set("limit", "30");
    if (cursor) u.searchParams.set("cursor", cursor);
    const { data } = await jfetch(u.toString());
    if (!data || !Array.isArray(data.data)) {
      if (page === 0) searchFailed = true;
      break;
    }
    pages++;
    for (const item of data.data) {
      if (item && item.itemType === "Asset" && item.id != null && !seen.has(item.id)) {
        seen.add(item.id);
        if (groupIds.length < MAX_IDS) groupIds.push(item.id);
      }
    }
    cursor = data.nextPageCursor;
    if (!cursor || groupIds.length >= MAX_IDS) break;
  }
  if (searchFailed) {
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
    res.status(200).json({ groupId, groupItemCount: 0, scannedPages: 0, owned: [], searchFailed: true, private: false });
    return;
  }

  // 2. Ownership. Scan first (same design as api/inventory.js): a 403 from
  // the scan is itself proof of a private inventory, and a scan answering
  // with items proves it is public. canView is only the tiebreaker when
  // the scan comes back empty.
  let collectibles = await scanCollectibles(userId);
  let canView = null;
  if (collectibles === null) {
    // Explicit 403 on page 1: private, no canView call needed.
    res.status(200).json({ groupId, groupItemCount: groupIds.length, scannedPages: pages, owned: [], private: true, canView: false });
    return;
  }
  if (collectibles.length === 0) {
    canView = await fetchCanView(userId);
    if (canView === false) {
      res.status(200).json({ groupId, groupItemCount: groupIds.length, scannedPages: pages, owned: [], private: true, canView: false });
      return;
    }
  } else {
    canView = true; // items came back: inventory is provably public
  }
  const byId = new Map();
  for (const c of collectibles) byId.set(c.assetId, c);

  const owned = [];
  const ownedIds = new Set();
  const missing = [];
  for (const id of groupIds) {
    const c = byId.get(id);
    if (c) {
      owned.push({
        assetId: id,
        name: c.name || null,
        rap: typeof c.recentAveragePrice === "number" ? c.recentAveragePrice : null,
      });
      ownedIds.add(id);
    } else {
      missing.push(id);
    }
  }
  let cur = 0;
  async function worker() {
    while (cur < missing.length) {
      const id = missing[cur++];
      const { data } = await jfetch(`https://inventory.roblox.com/v1/users/${userId}/items/Asset/${id}`);
      const inst = data && Array.isArray(data.data) ? data.data[0] : null;
      if (inst) {
        owned.push({ assetId: id, name: inst.name || null, rap: null });
        ownedIds.add(id);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  res.status(200).json({
    groupId,
    groupItemCount: groupIds.length,
    scannedPages: pages,
    owned,
    private: false,
    canView,
    scannedCollectibles: collectibles.length,
  });
};
