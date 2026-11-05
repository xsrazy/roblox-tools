// Roblox Tools - Inventory Scan API.
// GET /api/inventory-scan?userId=<id>&ids=<csv assetIds>&names=<csv keywords>
// Checks which of the given asset IDs a user owns, plus (optionally) which
// of their collectibles match a name keyword.
// Ownership sources, in order:
//   1. The public collectibles list (limiteds; carries RAP + names).
//   2. GET inventory.roblox.com/v1/users/{id}/items/Asset/{assetId} for
//      IDs not in the collectibles list (covers non-limited collectibles
//      such as modern UGC pacifiers / necklaces). Returns the instance
//      when owned, an empty list when not, 403 when private.
// Private inventories (can-view false, or a 403 from inventory) return
// {private:true}. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const MAX_IDS = 120;

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

// Full collectibles scan (max 10 pages). Returns null on a hard failure
// of page 1 (e.g. 403 for a private inventory).
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
  if (!/^\d+$/.test(userId)) {
    res.status(400).json({ error: "Missing or invalid userId" });
    return;
  }
  const ids = [...new Set(String(q.ids || "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number))].slice(0, MAX_IDS);
  const names = String(q.names || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 5);

  // Scan first (same design as api/inventory.js): a scan that answers with
  // items proves the inventory is public, so canView is no longer a gate.
  // canView is only the tiebreaker when the scan is empty or hard-fails.
  let collectibles = await scanCollectibles(userId);
  let canView = null;
  if (collectibles === null) {
    canView = await fetchCanView(userId);
    if (canView === false) {
      res.status(200).json({ private: true, canView: false, owned: [], nameMatches: [], scannedCollectibles: 0 });
      return;
    }
    if (canView === true) collectibles = await scanCollectibles(userId); // public: retry once
    if (collectibles === null) {
      res.status(200).json({ private: true, canView, owned: [], nameMatches: [], scannedCollectibles: 0 });
      return;
    }
  } else if (collectibles.length === 0) {
    canView = await fetchCanView(userId);
    if (canView === false) {
      res.status(200).json({ private: true, canView: false, owned: [], nameMatches: [], scannedCollectibles: 0 });
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
  for (const id of ids) {
    const c = byId.get(id);
    if (c) {
      owned.push({
        assetId: id,
        name: c.name || null,
        rap: typeof c.recentAveragePrice === "number" ? c.recentAveragePrice : null,
        userAssetId: c.userAssetId || null,
      });
      ownedIds.add(id);
    } else {
      missing.push(id);
    }
  }

  // Per-ID ownership checks for everything the collectibles list missed.
  let cursor = 0;
  async function worker() {
    while (cursor < missing.length) {
      const id = missing[cursor++];
      const { data } = await jfetch(`https://inventory.roblox.com/v1/users/${userId}/items/Asset/${id}`);
      const inst = data && Array.isArray(data.data) ? data.data[0] : null;
      if (inst) {
        owned.push({ assetId: id, name: inst.name || null, rap: null, userAssetId: inst.instanceId || null });
        ownedIds.add(id);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);

  const nameMatches = [];
  if (names.length) {
    for (const c of collectibles) {
      if (ownedIds.has(c.assetId)) continue;
      const n = String(c.name || "").toLowerCase();
      if (n && names.some((kw) => n.includes(kw))) {
        nameMatches.push({
          assetId: c.assetId,
          name: c.name || null,
          rap: typeof c.recentAveragePrice === "number" ? c.recentAveragePrice : null,
          userAssetId: c.userAssetId || null,
        });
      }
    }
  }

  res.status(200).json({
    private: false,
    canView,
    owned,
    nameMatches,
    scannedCollectibles: collectibles.length,
    checkedIds: ids.length,
  });
};
