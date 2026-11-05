// Roblox Tools - Inventory API.
// GET /api/inventory?userId=<id>&mode=<mode>[&assetId=<n>]
// Modes: rap | recent | cheapest | check | uaid
// Server-side proxy to the public Roblox inventory APIs. Returns clean JSON.
// Never throws: failures degrade to null fields / error messages.
// Scan-first visibility: the collectibles scan is the proof (private = 403/empty);
// canView only breaks ties when the scan is empty or failed. Private -> {private:true}.

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

// Same retry pattern as api/user.js fetchCanView: a single transient
// failure must not blank the whole inventory. Backoff runs a little longer
// here because every mode depends on this gate and the endpoint 429s in
// bursts.
async function fetchCanView(userId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const inv = await jfetch(`https://inventory.roblox.com/v1/users/${userId}/can-view-inventory`);
    if (inv && typeof inv.canView === "boolean") return inv.canView;
    if (attempt < 3) await sleep(600 * Math.pow(2, attempt));
  }
  return null;
}

function collectiblesUrl(userId, sortOrder, cursor) {
  const u = new URL(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`);
  u.searchParams.set("assetType", "All");
  u.searchParams.set("sortOrder", sortOrder);
  u.searchParams.set("limit", "100");
  if (cursor) u.searchParams.set("cursor", cursor);
  return u.toString();
}

// Full collectibles scan (Asc), paginated, hard cap of 10 pages like api/user.js.
// Returns an array (possibly partial if a later page fails), or null when the
// first page could not be loaded at all.
async function scanCollectibles(userId) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const url = collectiblesUrl(userId, "Asc", cursor);
    let data = await jfetch(url);
    if ((!data || !Array.isArray(data.data)) && page === 0) {
      await sleep(800);
      data = await jfetch(url);
    }
    if (!data || !Array.isArray(data.data)) return items.length ? items : null;
    for (const item of data.data) items.push(item);
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }
  return items;
}

// Direct ownership probe, verified live 2026-11-05:
//   GET /v1/users/156/items/Asset/1285307 (owned)
//     -> 200 {"data":[{"id":1285307,"name":"Sparkle Time Fedora","type":"Asset","instanceId":628164}]}
//   GET /v1/users/156/items/Asset/12345678 (not owned)
//     -> 200 {"data":[]}
// instanceId is the userAssetId of the owned copy. Works for any asset type.
// Returns the data array, or null when the endpoint did not answer cleanly.
async function fetchOwnership(userId, assetId) {
  const data = await jfetch(`https://inventory.roblox.com/v1/users/${userId}/items/Asset/${assetId}`);
  if (data && Array.isArray(data.data)) return data.data;
  return null;
}

function slim(item) {
  return {
    assetId: item.assetId,
    name: item.name || null,
    rap: typeof item.recentAveragePrice === "number" ? item.recentAveragePrice : null,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const q = req.query || {};
  const userIdRaw = String(q.userId || "").trim();
  const mode = String(q.mode || "").trim().toLowerCase();
  const assetIdRaw = String(q.assetId || "").trim();

  if (!/^\d+$/.test(userIdRaw)) {
    res.status(400).json({ error: "Missing or invalid userId" });
    return;
  }
  const userId = Number(userIdRaw);
  const MODES = ["rap", "recent", "cheapest", "check", "uaid"];
  if (!MODES.includes(mode)) {
    res.status(400).json({ error: "Unknown mode" });
    return;
  }
  let assetId = null;
  if (mode === "check" || mode === "uaid") {
    if (!/^\d+$/.test(assetIdRaw)) {
      res.status(400).json({ error: "Missing or invalid assetId" });
      return;
    }
    assetId = Number(assetIdRaw);
  }

  // Visibility design (changed 2026-11-05, user order "usahain jangan
  // limit"): canView is NO longer a single up-front gate. The collectibles
  // scan is itself the proof - a private inventory 403s the scan, a public
  // one answers it. canView (with its retry loop) is only consulted as a
  // tiebreaker when the scan cannot prove anything (empty or failed), to
  // tell "private" apart from "public but empty / not found".
  // Degraded answers get a very short edge cache (same pattern as
  // api/user.js) so a rate-limited minute cannot poison the cache.
  const SHORT_CACHE = "s-maxage=20, stale-while-revalidate=20";
  let scanPromise = null;
  const getScan = () => {
    if (!scanPromise) scanPromise = scanCollectibles(userId);
    return scanPromise;
  };
  let canViewPromise = null;
  const getCanView = () => {
    if (!canViewPromise) canViewPromise = fetchCanView(userId);
    return canViewPromise;
  };
  const sendPrivate = () => {
    res.status(200).json({ private: true });
  };
  const sendGateError = () => {
    res.setHeader("Cache-Control", SHORT_CACHE);
    res.status(200).json({
      private: null,
      error: "Could not verify whether this inventory is public. Please try again.",
    });
  };
  const sendLoadError = () => {
    res.setHeader("Cache-Control", SHORT_CACHE);
    res.status(200).json({ private: false, error: "Could not load this inventory right now." });
  };

  // mode=recent: its own Desc fetch (most recently acquired first).
  if (mode === "recent") {
    const fetchRecent = async () => {
      let data = await jfetch(collectiblesUrl(userId, "Desc", null));
      if (!data || !Array.isArray(data.data)) {
        await sleep(800);
        data = await jfetch(collectiblesUrl(userId, "Desc", null));
      }
      return data && Array.isArray(data.data) ? data : null;
    };
    let data = await fetchRecent();
    if (!data) {
      // The fetch failed: private (403) or a transient error. Only the
      // canView tiebreaker can tell them apart.
      const canView = await getCanView();
      if (canView === false) {
        sendPrivate();
        return;
      }
      if (canView === true) data = await fetchRecent(); // public: one more try
      if (!data) {
        res.setHeader("Cache-Control", SHORT_CACHE);
        res.status(200).json({ private: false, items: null, error: "Could not load this inventory right now." });
        return;
      }
    }
    res.status(200).json({ private: false, items: data.data.slice(0, 30).map(slim) });
    return;
  }

  // mode=check: the direct ownership endpoint answers for any asset type;
  // its answer is itself proof the inventory is visible.
  if (mode === "check") {
    const ownedList = await fetchOwnership(userId, assetId);
    if (ownedList) {
      if (!ownedList.length) {
        res.status(200).json({
          private: false,
          owned: false,
          limitedOnly: false,
          userAssetId: null,
          serialNumber: null,
          rap: null,
        });
        return;
      }
      const first = ownedList[0];
      const out = {
        private: false,
        owned: true,
        limitedOnly: false,
        userAssetId: typeof first.instanceId === "number" ? first.instanceId : null,
        serialNumber: null,
        rap: null,
        name: first.name || null,
        copies: ownedList.length,
      };
      // Enrich with serial / RAP from the collectibles scan when possible.
      const items = await getScan();
      if (items) {
        const match = items.find(
          (it) => it.assetId === assetId && it.userAssetId === out.userAssetId
        ) || items.find((it) => it.assetId === assetId);
        if (match) {
          out.serialNumber = typeof match.serialNumber === "number" ? match.serialNumber : null;
          out.rap = typeof match.recentAveragePrice === "number" ? match.recentAveragePrice : null;
          if (!out.name) out.name = match.name || null;
        }
      }
      res.status(200).json(out);
      return;
    }
    // Ownership probe did not answer: fall back to the collectibles scan.
    const items = await getScan();
    if (!items) {
      const canView = await getCanView();
      if (canView === false) {
        sendPrivate();
        return;
      }
      res.setHeader("Cache-Control", SHORT_CACHE);
      res.status(200).json({
        private: false,
        owned: null,
        limitedOnly: true,
        userAssetId: null,
        serialNumber: null,
        rap: null,
      });
      return;
    }
    const match = items.find((it) => it.assetId === assetId);
    if (!match) {
      res.status(200).json({
        private: false,
        owned: false,
        limitedOnly: true,
        userAssetId: null,
        serialNumber: null,
        rap: null,
      });
      return;
    }
    res.status(200).json({
      private: false,
      owned: true,
      limitedOnly: true,
      userAssetId: typeof match.userAssetId === "number" ? match.userAssetId : null,
      serialNumber: typeof match.serialNumber === "number" ? match.serialNumber : null,
      rap: typeof match.recentAveragePrice === "number" ? match.recentAveragePrice : null,
      name: match.name || null,
    });
    return;
  }

  // Remaining modes (rap | cheapest | uaid) need the collectibles scan.
  let items = await getScan();
  if (items && items.length === 0) {
    // Scan answered but empty: public with zero collectibles, or the one
    // case the scan cannot distinguish - ask the canView tiebreaker.
    const canView = await getCanView();
    if (canView === false) {
      sendPrivate();
      return;
    }
  }
  if (!items) {
    // Scan failed outright: private (403) or transient rate limit.
    const canView = await getCanView();
    if (canView === false) {
      sendPrivate();
      return;
    }
    if (canView === true) {
      items = await scanCollectibles(userId); // public: retry the scan once
      if (!items) {
        sendLoadError();
        return;
      }
    } else {
      sendGateError();
      return;
    }
  }

  if (mode === "rap") {
    let total = 0;
    for (const it of items) {
      if (typeof it.recentAveragePrice === "number") total += it.recentAveragePrice;
    }
    const topItems = items
      .slice()
      .sort((a, b) => (b.recentAveragePrice || 0) - (a.recentAveragePrice || 0))
      .slice(0, 10)
      .map(slim);
    res.status(200).json({
      private: false,
      rapTotal: total,
      itemCount: items.length,
      topItems,
      averageRap: items.length ? Math.round(total / items.length) : null,
    });
    return;
  }

  if (mode === "cheapest") {
    const cheapest = items
      .filter((it) => typeof it.recentAveragePrice === "number" && it.recentAveragePrice > 0)
      .sort((a, b) => a.recentAveragePrice - b.recentAveragePrice)
      .slice(0, 10)
      .map(slim);
    res.status(200).json({ private: false, items: cheapest });
    return;
  }

  // mode === "uaid"
  const matches = items
    .filter((it) => it.assetId === assetId)
    .map((it) => ({
      userAssetId: typeof it.userAssetId === "number" ? it.userAssetId : null,
      serialNumber: typeof it.serialNumber === "number" ? it.serialNumber : null,
      rap: typeof it.recentAveragePrice === "number" ? it.recentAveragePrice : null,
      originalPrice: typeof it.originalPrice === "number" ? it.originalPrice : null,
      name: it.name || null,
    }));
  if (!matches.length) {
    res.status(200).json({ private: false, found: false, matches: [] });
    return;
  }
  res.status(200).json({ private: false, found: true, matches });
};
