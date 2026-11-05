// Roblox Tools - Thumbnail proxy API.
// GET /api/thumbs?kind=assets&ids=1,2,3&size=150x150&circular=false
// GET /api/thumbs?kind=users&endpoint=avatar|avatar-headshot|avatar-bust&ids=1,2&size=420x420&circular=true
//
// Why this exists: thumbnails.roblox.com sends NO Access-Control-Allow-Origin
// header, so browsers cannot read its JSON cross-origin (verified 5 Nov
// 2026). Pages used to call it directly from the browser and silently got
// nothing, rendering name-only tiles. This proxy resolves the same public
// endpoints server-side and returns a plain { "<id>": "<imageUrl>" } map.
// Kind "assets" uses the POST batch endpoint (type Asset), which proved
// reliable when the GET list endpoint throttles. Never throws.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const USER_ENDPOINTS = {
  avatar: "avatar",
  "avatar-headshot": "avatar-headshot",
  "avatar-bust": "avatar-bust",
};

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

function parseIds(raw) {
  const ids = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  return [...new Set(ids)].slice(0, 100);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const q = req.query || {};
  const kind = String(q.kind || "assets");
  const ids = parseIds(q.ids);
  const size = /^\d{1,4}x\d{1,4}$/.test(String(q.size || "")) ? String(q.size) : "150x150";
  const circular = String(q.circular || "false") === "true";
  if (!ids.length) {
    res.status(400).json({ error: "Missing or invalid ids" });
    return;
  }

  const map = {};
  // Set at the end: an empty map for valid ids means upstream failed;
  // finish() shortens the edge cache in that case so pages heal fast.
  const finish = (payload) => {
    if (!Object.keys(map).length) {
      res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=20");
    }
    res.status(200).json(payload);
  };

  if (kind === "users") {
    const endpoint = USER_ENDPOINTS[String(q.endpoint || "avatar-headshot")];
    if (!endpoint) {
      res.status(400).json({ error: "Unknown endpoint" });
      return;
    }
    const r = await jfetch(
      `https://thumbnails.roblox.com/v1/users/${endpoint}?userIds=${ids.join(",")}&size=${size}&format=Png&isCircular=${circular}`
    );
    const data = r && Array.isArray(r.data) ? r.data : [];
    data.forEach((d) => {
      if (d && d.targetId != null && d.state === "Completed" && d.imageUrl)
        map[d.targetId] = d.imageUrl;
    });
    finish({ thumbs: map });
    return;
  }

  if (kind === "groups") {
    const r = await jfetch(
      `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${ids.join(",")}&size=${size}&format=Png&isCircular=${circular}`
    );
    const data = r && Array.isArray(r.data) ? r.data : [];
    data.forEach((d) => {
      if (d && d.targetId != null && d.state === "Completed" && d.imageUrl)
        map[d.targetId] = d.imageUrl;
    });
    finish({ thumbs: map });
    return;
  }

  // kind=assets: POST batch, type Asset, chunks of 100.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await jfetch("https://thumbnails.roblox.com/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        chunk.map((id) => ({
          requestId: "a" + id,
          type: "Asset",
          targetId: Number(id),
          format: "Png",
          size,
          isCircular: circular,
        }))
      ),
    });
    const data = r && Array.isArray(r.data) ? r.data : [];
    data.forEach((d) => {
      if (d && d.targetId != null && d.state === "Completed" && d.imageUrl)
        map[d.targetId] = d.imageUrl;
    });
  }
  finish({ thumbs: map });
};
