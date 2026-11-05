// Roblox Tools - Game Info API.
// GET /api/game?placeId=<id>   (also accepts ?universeId=<id>)
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

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

// Resolve a place ID to its universe ID.
// Primary: games multiget-place-details. Verified 2026-11-05 from the VM:
// that endpoint currently answers {"errors":[{"code":0,"message":""}]}
// with no universe data, so the fallback below is the working path.
// Fallback: apis.roblox.com/universes/v1/places/{placeId}/universe
// -> { universeId } (verified working).
async function resolveUniverseId(placeId) {
  const multi = await jfetch("https://games.roblox.com/v1/games/multiget-place-details", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([placeId]),
  });
  const entry = Array.isArray(multi)
    ? multi[0]
    : multi && Array.isArray(multi.data)
      ? multi.data[0]
      : null;
  if (entry && entry.universeId) return entry.universeId;

  const uni = await jfetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
  if (uni && uni.universeId) return uni.universeId;
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const q = req.query || {};
  const placeRaw = String(q.placeId || "").trim();
  const universeRaw = String(q.universeId || "").trim();

  let universeId = null;
  let placeId = null;

  if (/^\d+$/.test(universeRaw)) {
    universeId = Number(universeRaw);
  } else if (/^\d+$/.test(placeRaw)) {
    placeId = Number(placeRaw);
    universeId = await resolveUniverseId(placeId);
    if (!universeId) {
      res.status(404).json({ error: "Game not found" });
      return;
    }
  } else {
    res.status(400).json({ error: "Missing placeId or universeId" });
    return;
  }

  const [games, votes, icons] = await Promise.all([
    jfetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
    jfetch(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`),
    jfetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png&isCircular=false`
    ),
  ]);

  const game = games && Array.isArray(games.data) ? games.data[0] : null;
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const vote = votes && Array.isArray(votes.data) ? votes.data[0] : null;
  const upVotes = vote ? num(vote.upVotes) : null;
  const downVotes = vote ? num(vote.downVotes) : null;
  let likeRatio = null;
  if (upVotes !== null && downVotes !== null && upVotes + downVotes > 0) {
    likeRatio = Math.round((upVotes / (upVotes + downVotes)) * 1000) / 10;
  }

  const icon =
    icons && Array.isArray(icons.data) && icons.data[0] ? icons.data[0].imageUrl || null : null;
  const creator = game.creator || {};

  res.status(200).json({
    universeId,
    placeId: num(game.rootPlaceId) || placeId,
    name: game.name || null,
    description: typeof game.description === "string" ? game.description : null,
    playing: num(game.playing),
    visits: num(game.visits),
    favoritedCount: num(game.favoritedCount),
    maxPlayers: num(game.maxPlayers),
    created: game.created || null,
    updated: game.updated || null,
    genre: game.genre || null,
    creatorName: creator.name || null,
    creatorType: creator.type || null,
    creatorId: num(creator.id),
    iconUrl: icon,
    upVotes,
    downVotes,
    likeRatio,
  });
};
