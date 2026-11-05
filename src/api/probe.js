// Vercel-egress probe for Roblox public APIs.
// Fetches each endpoint server-side and reports status + a short sample.
// Never throws: failures are reported as status 0 with an error message.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const ENDPOINTS = [
  {
    name: "friends list",
    method: "GET",
    url: "https://friends.roblox.com/v1/users/*****/friends",
  },
  {
    name: "followers list",
    method: "GET",
    url: "https://friends.roblox.com/v1/users/*****/followers?limit=10",
  },
  {
    name: "badges list",
    method: "GET",
    url: "https://badges.roblox.com/v1/users/*****/badges?limit=10",
  },
  {
    name: "avatar 3d",
    method: "GET",
    url: "https://thumbnails.roblox.com/v1/users/avatar-3d?userId=*****",
  },
  {
    name: "collectibles builderman",
    method: "GET",
    url: "https://inventory.roblox.com/v1/users/156/assets/collectibles?assetType=All&limit=10&sortOrder=Desc",
  },
  {
    name: "game servers",
    method: "GET",
    url: "https://games.roblox.com/v1/games/2753915549/servers/Public?limit=10",
  },
  {
    name: "username validate",
    method: "POST",
    url: "https://auth.roblox.com/v1/usernames/validate",
    body: {
      username: "*****",
      context: "Signup",
      birthday: "2000-01-01T00:00:00.000Z",
    },
  },
  {
    name: "rolimons playerinfo",
    method: "GET",
    url: "https://api.rolimons.com/players/v1/playerinfo/*****",
  },
  {
    name: "catalog item details",
    method: "POST",
    url: "https://catalog.roblox.com/v1/catalog/items/details",
    body: { items: [{ itemType: "Asset", id: 63690008 }] },
  },
];

function summarize(text) {
  try {
    const j = JSON.parse(text);
    if (j && Array.isArray(j.data)) {
      const first = j.data[0];
      const fact = first
        ? JSON.stringify(first).slice(0, 140)
        : "(empty data array)";
      return `data[${j.data.length}] first: ${fact}`.slice(0, 200);
    }
    if (j && j.errors) return JSON.stringify(j.errors).slice(0, 200);
    return JSON.stringify(j).slice(0, 200);
  } catch (e) {
    return text.slice(0, 200);
  }
}

async function probe(ep) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const opts = {
      method: ep.method,
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    };
    if (ep.body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(ep.body);
    }
    const res = await fetch(ep.url, opts);
    const text = await res.text();
    return {
      name: ep.name,
      status: res.status,
      ok: res.ok,
      sample: summarize(text),
    };
  } catch (err) {
    return {
      name: ep.name,
      status: 0,
      ok: false,
      sample: "",
      error: err && err.message ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  const results = await Promise.all(ENDPOINTS.map(probe));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    probe: "roblox-tools vercel egress",
    at: new Date().toISOString(),
    results,
  });
};
