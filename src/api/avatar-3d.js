// Roblox Tools - Avatar 3D API (session-backed).
// GET /api/avatar-3d?userId=<id>
// Resolves the 3D avatar manifest via the thumbnails API using a
// signed-in session (env ROBLOSECURITY). Cookie is read only from
// process.env and sent only to roblox.com; never logged or returned.
// The manifest itself is a public CDN JSON, fetched without the cookie.
// Degradation contract: always HTTP 200 JSON.
//   {unavailable: true} - no session, upstream 401, or auth-style 403.
//   {notVisible: true}  - target-specific error (privacy 403, 404, ...).
//   success             - {state, manifest} ; state may be Pending etc.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const COOKIE = process.env.ROBLOSECURITY || "";

async function afetch(url) {
  if (!COOKIE) return null;
  const baseHeaders = {
    "User-Agent": UA,
    Accept: "application/json",
    Cookie: ".ROBLOSECURITY=" + COOKIE,
  };
  let r;
  try {
    r = await fetch(url, { headers: baseHeaders });
  } catch {
    return { __fetchError: true };
  }
  if (r && r.status === 403) {
    let csrf = null;
    try {
      csrf = r.headers && typeof r.headers.get === "function" ? r.headers.get("x-csrf-token") : null;
    } catch {
      csrf = null;
    }
    if (csrf) {
      try {
        r = await fetch(url, { headers: { ...baseHeaders, "x-csrf-token": csrf } });
      } catch {
        return { __fetchError: true };
      }
    }
  }
  return r;
}

function isAuthStyle(status, data, rawText) {
  if (status === 401) return true;
  if (status !== 403) return false;
  const hay = (rawText || (data ? JSON.stringify(data) : "") || "").toLowerCase();
  return (
    hay.includes("unauthorized") ||
    hay.includes("authentication") ||
    hay.includes("not authenticated") ||
    hay.includes("token validation") ||
    hay.includes("invalid token") ||
    hay.includes("logged out") ||
    hay.includes("401")
  );
}

function sendUnavailable(res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ unavailable: true });
}
function sendNotVisible(res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  res.status(200).json({ notVisible: true });
}
function sendOk(res, payload) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  res.status(200).json(payload);
}

// Manifest asset values arrive as bare CDN hashes (e.g. "30DAY-<hex>"),
// not URLs, so as relative links they 404. Verified from the VM with
// curl: https://t0.rbxcdn.com/<hash> returns 200 for the obj, mtl and
// texture hashes (real OBJ / MTL / PNG bodies, CORS *), while the
// -Obj / -Mtl / -Png suffixed forms return 403 and the t1-t7 subdomains
// return 403 for the bare hash. So bare values expand onto t0 with no
// suffix; values that are already absolute URLs pass through untouched.
const CDN_BASE = "https://t0.rbxcdn.com/";
function expandAssetUrl(v) {
  if (typeof v !== "string" || !v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return CDN_BASE + v.replace(/^\/+/, "");
}

// Keep only string / string-array fields that look like manifest assets,
// so unexpected upstream shapes degrade instead of breaking the page.
function slimManifest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const manifest = {};
  if (typeof raw.obj === "string" && raw.obj) manifest.obj = expandAssetUrl(raw.obj);
  if (typeof raw.mtl === "string" && raw.mtl) manifest.mtl = expandAssetUrl(raw.mtl);
  if (Array.isArray(raw.textures)) {
    manifest.textures = raw.textures
      .filter((t) => typeof t === "string" && t)
      .map(expandAssetUrl);
  } else if (typeof raw.textures === "string" && raw.textures) {
    manifest.textures = [expandAssetUrl(raw.textures)];
  } else {
    manifest.textures = [];
  }
  // Pass through any other top-level string fields defensively (some
  // manifest revisions nest differently); do not invent fields.
  for (const k of Object.keys(raw)) {
    if (k === "obj" || k === "mtl" || k === "textures") continue;
    if (typeof raw[k] === "string" && raw[k]) manifest[k] = raw[k];
  }
  if (!manifest.obj && !manifest.mtl && !(manifest.textures && manifest.textures.length)) {
    return null;
  }
  if (!manifest.textures) manifest.textures = [];
  return manifest;
}

module.exports = async (req, res) => {
  const userId = String((req.query && req.query.userId) || "").trim();
  if (!/^\d+$/.test(userId)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Missing or invalid userId" });
    return;
  }
  if (!COOKIE) {
    sendUnavailable(res);
    return;
  }

  try {
    const url = `https://thumbnails.roblox.com/v1/users/avatar-3d?userId=${encodeURIComponent(userId)}`;
    const r = await afetch(url);
    if (!r || r.__fetchError) {
      sendUnavailable(res);
      return;
    }
    let rawText = "";
    let data = null;
    try {
      rawText = await r.text();
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }
    } catch {
      sendUnavailable(res);
      return;
    }

    if (r.status === 401) {
      sendUnavailable(res);
      return;
    }
    if (r.status === 403) {
      if (isAuthStyle(r.status, data, rawText)) sendUnavailable(res);
      else sendNotVisible(res);
      return;
    }
    if (r.status === 404) {
      sendNotVisible(res);
      return;
    }
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500) sendNotVisible(res);
      else sendUnavailable(res);
      return;
    }

    // Thumbnails API shape: {targetId, state, imageUrl} at top level, or
    // wrapped as {data: [{targetId, state, imageUrl}]} on some routes.
    let entry = data;
    if (data && Array.isArray(data.data) && data.data[0]) entry = data.data[0];
    const state = entry && typeof entry.state === "string" ? entry.state : null;
    const imageUrl = entry && typeof entry.imageUrl === "string" ? entry.imageUrl : null;

    if (!state) {
      // No usable state: treat as not visible rather than fabricating one.
      sendNotVisible(res);
      return;
    }

    if (state !== "Completed" || !imageUrl) {
      // Pending / TemporarilyUnavailable / Blocked etc: pass state through.
      sendOk(res, { state, manifest: null });
      return;
    }

    // Completed: imageUrl points at a CDN manifest JSON (no cookie needed).
    let manifestRaw = null;
    try {
      const mr = await fetch(imageUrl, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (mr.ok) {
        try {
          manifestRaw = await mr.json();
        } catch {
          manifestRaw = null;
        }
      }
    } catch {
      manifestRaw = null;
    }
    const manifest = slimManifest(manifestRaw);
    if (!manifest) {
      // Manifest fetch/parse failed: report the state honestly, no data.
      sendOk(res, { state, manifest: null });
      return;
    }
    sendOk(res, { state, manifest });
  } catch {
    sendUnavailable(res);
  }
};
