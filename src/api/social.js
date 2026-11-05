// Roblox Tools - Social lists API (session-backed).
// GET /api/social?mode=friends|followers|following&userId=<id>&cursor=<optional>
// GET /api/social?mode=mutuals&userId=<a>&otherId=<b>
// Uses a signed-in session (env ROBLOSECURITY) because friends / follower
// lists are privacy-gated on the public API. Never exposes the cookie:
// it is read only from process.env and sent only to roblox.com.
// Degradation contract: always HTTP 200 JSON.
//   {unavailable: true} - no session, upstream 401, or auth-style 403.
//   {notVisible: true}  - target-specific error (privacy 403, 404, ...).
//   success             - data fields, Cache-Control s-maxage.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const COOKIE = process.env.ROBLOSECURITY || "";

// Authenticated fetch. Returns a Response, or null when there is no
// session cookie, or a sentinel object { __fetchError: true } on a
// network failure. On 403 it retries ONCE with the x-csrf-token header
// Roblox returns, when present.
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
  const hay = (
    rawText ||
    (data ? JSON.stringify(data) : "") ||
    ""
  ).toLowerCase();
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

// Runs afetch and classifies the result.
// Returns { kind: "ok", data } | { kind: "unavailable" } | { kind: "notVisible" }
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
    // Other 4xx are treated as target-specific; 5xx / 429 as unavailable-ish
    // but not auth: surface as notVisible so the page does not claim the
    // session is down for a transient upstream error. 429 specifically
    // degrades to notVisible as well (list exists, just rate limited).
    if (r.status >= 400 && r.status < 500) return { kind: "notVisible" };
    return { kind: "unavailable" };
  }
  return { kind: "ok", data };
}

function slimUser(u) {
  if (!u || u.id == null) return null;
  return {
    id: u.id,
    name: u.name || u.username || "",
    displayName: u.displayName || u.name || u.username || "",
  };
}

function slimList(data) {
  const arr = data && Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
  return arr.map(slimUser).filter(Boolean);
}

// Public (no-cookie) name enrichment. The session-backed friends /
// followers endpoints return id-only users (empty name / displayName),
// so names are filled in server-side from the public users API before
// responding. Verified from the VM: POST https://users.roblox.com/v1/users
// with {userIds:[...]} returns name + displayName for up to 100 ids per
// call (POST /v1/users/batch does not exist, it 404s), so ids are
// chunked by 100 and chunks are fetched in parallel. Best-effort only:
// a failed chunk or lookup leaves that user's empty strings in place
// and never fails the whole response.
async function enrichUsers(users) {
  if (!Array.isArray(users) || !users.length) return users;
  const ids = [
    ...new Set(
      users
        .filter((u) => u && (!u.name || !u.displayName))
        .map((u) => Number(u.id))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!ids.length) return users;
  const byId = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const r = await fetch("https://users.roblox.com/v1/users", {
          method: "POST",
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userIds: chunk, excludeBannedUsers: false }),
        });
        if (!r.ok) return;
        const data = await r.json().catch(() => null);
        const arr = data && Array.isArray(data.data) ? data.data : [];
        for (const d of arr) {
          if (d && d.id != null) byId.set(String(d.id), d);
        }
      } catch {
        // Best-effort: skip this chunk, keep empty names.
      }
    })
  );
  for (const u of users) {
    const d = byId.get(String(u.id));
    if (!d) continue;
    if (d.name) u.name = d.name;
    if (d.displayName) u.displayName = d.displayName;
    else if (d.name && !u.displayName) u.displayName = d.name;
  }
  return users;
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

module.exports = async (req, res) => {
  const q = req.query || {};
  const mode = String(q.mode || "friends").trim().toLowerCase();
  const userId = String(q.userId || "").trim();
  const otherId = String(q.otherId || "").trim();
  const cursor = String(q.cursor || "").trim();

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
    if (mode === "mutuals") {
      if (!/^\d+$/.test(otherId)) {
        res.setHeader("Cache-Control", "no-store");
        res.status(400).json({ error: "Missing or invalid otherId" });
        return;
      }
      const [a, b] = await Promise.all([
        fetchClassified(`https://friends.roblox.com/v1/users/${userId}/friends`),
        fetchClassified(`https://friends.roblox.com/v1/users/${otherId}/friends`),
      ]);
      if (a.kind === "unavailable" || b.kind === "unavailable") {
        sendUnavailable(res);
        return;
      }
      if (a.kind === "notVisible" || b.kind === "notVisible") {
        sendNotVisible(res);
        return;
      }
      const listA = slimList(a.data);
      const listB = slimList(b.data);
      const idsB = new Set(listB.map((u) => String(u.id)));
      const users = listA.filter((u) => idsB.has(String(u.id)));
      await enrichUsers(users);
      sendOk(res, { users, nextPageCursor: null });
      return;
    }

    if (mode === "friends") {
      const r = await fetchClassified(`https://friends.roblox.com/v1/users/${userId}/friends`);
      if (r.kind === "unavailable") {
        sendUnavailable(res);
        return;
      }
      if (r.kind === "notVisible") {
        sendNotVisible(res);
        return;
      }
      const users = slimList(r.data);
      await enrichUsers(users);
      sendOk(res, { users, nextPageCursor: null });
      return;
    }

    if (mode === "followers" || mode === "following") {
      const seg = mode === "followers" ? "followers" : "followings";
      const u = new URL(`https://friends.roblox.com/v1/users/${userId}/${seg}`);
      u.searchParams.set("limit", "100");
      u.searchParams.set("sortOrder", "Asc");
      if (cursor) u.searchParams.set("cursor", cursor);
      const r = await fetchClassified(u.toString());
      if (r.kind === "unavailable") {
        sendUnavailable(res);
        return;
      }
      if (r.kind === "notVisible") {
        sendNotVisible(res);
        return;
      }
      const nextPageCursor =
        r.data && typeof r.data.nextPageCursor === "string" ? r.data.nextPageCursor : null;
      const users = slimList(r.data);
      await enrichUsers(users);
      sendOk(res, { users, nextPageCursor });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Invalid mode" });
  } catch {
    // Never leak internals (and never the cookie) in an error.
    sendUnavailable(res);
  }
};
