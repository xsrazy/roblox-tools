// Roblox Tools - User Badges API (session-backed).
// GET /api/badges?userId=<id>
// Lists player badges via the badges API using a signed-in session
// (env ROBLOSECURITY). Cookie is read only from process.env and sent
// only to roblox.com; never logged, never returned, never in errors.
// Degradation contract: always HTTP 200 JSON.
//   {unavailable: true} - no session, upstream 401, or auth-style 403.
//   {notVisible: true}  - target-specific error (privacy 403, 404, ...).
//   success             - {badges, total}, Cache-Control s-maxage.

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

async function fetchClassified(url) {
  if (!COOKIE) return { kind: "unavailable" };
  const r = await afetch(url);
  if (!r || r.__fetchError) return { kind: "unavailable" };
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
    return { kind: "unavailable" };
  }
  if (r.status === 401) return { kind: "unavailable" };
  if (r.status === 403) {
    if (isAuthStyle(r.status, data, rawText)) return { kind: "unavailable" };
    return { kind: "notVisible" };
  }
  if (r.status === 404) return { kind: "notVisible" };
  if (!r.ok) {
    if (r.status >= 400 && r.status < 500) return { kind: "notVisible" };
    return { kind: "unavailable" };
  }
  return { kind: "ok", data };
}

function sendUnavailable(res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ unavailable: true });
}
function sendNotVisible(res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  res.status(200).json({ notVisible: true });
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
    const badges = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const u = new URL(`https://badges.roblox.com/v1/users/${userId}/badges`);
      u.searchParams.set("limit", "100");
      u.searchParams.set("sortOrder", "Desc");
      if (cursor) u.searchParams.set("cursor", cursor);
      const r = await fetchClassified(u.toString());
      if (r.kind === "unavailable") {
        // If the first page fails auth-style, the whole tool is unavailable.
        // If a later page fails, return what we already collected.
        if (page === 0) {
          sendUnavailable(res);
          return;
        }
        break;
      }
      if (r.kind === "notVisible") {
        if (page === 0) {
          sendNotVisible(res);
          return;
        }
        break;
      }
      const items = r.data && Array.isArray(r.data.data) ? r.data.data : [];
      for (const item of items) {
        if (!item || item.id == null) continue;
        badges.push({
          id: item.id,
          name: item.name || "",
          description: typeof item.description === "string" ? item.description : "",
          iconImageId: item.iconImageId ?? item.displayImageId ?? item.imageId ?? null,
        });
      }
      cursor = r.data && typeof r.data.nextPageCursor === "string" ? r.data.nextPageCursor : null;
      if (!cursor) break;
    }
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json({ badges, total: badges.length, count: badges.length });
  } catch {
    sendUnavailable(res);
  }
};
