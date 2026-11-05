// Roblox Tools - Game Servers API.
// GET /api/servers?placeId=<id>
// Lists live public servers for a place (up to 200: first page + one cursor).
// Never throws: failures degrade to an empty / partial list.
// NOTE: the upstream response has no region field, so none is returned.

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

function mapServer(s) {
  if (!s || !s.id) return null;
  return {
    id: String(s.id),
    playing: num(s.playing),
    maxPlayers: num(s.maxPlayers),
    ping: num(s.ping),
    fps: num(s.fps),
  };
}

async function fetchPage(placeId, cursor) {
  const u = new URL(`https://games.roblox.com/v1/games/${placeId}/servers/Public`);
  u.searchParams.set("sortOrder", "Desc");
  u.searchParams.set("limit", "100");
  if (cursor) u.searchParams.set("cursor", cursor);
  return jfetch(u.toString());
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const placeRaw = String(((req.query || {}).placeId) || "").trim();
  if (!/^\d+$/.test(placeRaw)) {
    res.status(400).json({ error: "Missing placeId" });
    return;
  }
  const placeId = Number(placeRaw);

  const servers = [];
  const first = await fetchPage(placeId, null);
  if (first && Array.isArray(first.data)) {
    for (const s of first.data) {
      const mapped = mapServer(s);
      if (mapped) servers.push(mapped);
    }
    if (first.nextPageCursor) {
      const second = await fetchPage(placeId, first.nextPageCursor);
      if (second && Array.isArray(second.data)) {
        for (const s of second.data) {
          const mapped = mapServer(s);
          if (mapped) servers.push(mapped);
        }
      }
    }
  }

  res.status(200).json({ placeId, servers });
};
