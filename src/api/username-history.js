// Roblox Tools - Username History API.
// GET /api/username-history?userId=<id>
// Returns {names: [...]}: the account's previous usernames, newest first,
// from the public username-history endpoint. Follows nextPageCursor for
// up to 5 pages. Never throws: failures degrade to an empty list.

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

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const userId = String((req.query && req.query.userId) || "").trim();
  if (!/^\d+$/.test(userId)) {
    res.status(400).json({ error: "Missing or invalid userId" });
    return;
  }

  const names = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const u = new URL(`https://users.roblox.com/v1/users/${userId}/username-history`);
    u.searchParams.set("limit", "100");
    u.searchParams.set("sortOrder", "Desc");
    if (cursor) u.searchParams.set("cursor", cursor);
    let data = await jfetch(u.toString());
    // The endpoint rate-limits easily; one brief retry on the first page
    // (same pattern as the RAP fetch in api/user.js).
    if ((!data || !Array.isArray(data.data)) && page === 0) {
      await sleep(800);
      data = await jfetch(u.toString());
    }
    if (!data || !Array.isArray(data.data)) break;
    for (const item of data.data) {
      // Live shape (verified): data entries are objects, {name: "..."}.
      const name =
        typeof item === "string" ? item : item && typeof item.name === "string" ? item.name : null;
      if (name) names.push(name);
    }
    cursor = data.nextPageCursor;
    if (!cursor) break;
  }

  res.status(200).json({ names });
};
