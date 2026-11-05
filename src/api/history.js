// Roblox Tools - public recent-lookups feed.
// GET  /api/history -> latest 12 lookups { username, user_id, tool, ts }
// POST /api/history { username, userId, tool } -> record one lookup
// Storage: Cloudflare D1 database "roblox-lookups" (table: lookups),
// reached through the D1 REST API. Credentials live in Vercel env vars.

const ACC = process.env.CF_ACCOUNT_ID;
const DB = process.env.CF_D1_ID;
const TOK = process.env.CF_API_TOKEN;

async function d1(sql, params = []) {
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      }
    );
    const j = await r.json();
    if (!j || !j.success) return null;
    return j.result[0];
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (!ACC || !DB || !TOK) {
    return res.status(503).json({ error: "history not configured" });
  }
  if (req.method === "GET") {
    const out = await d1(
      "SELECT username, user_id, tool, ts FROM lookups ORDER BY id DESC LIMIT 12"
    );
    if (!out) return res.status(502).json({ items: [] });
    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=10");
    return res.status(200).json({ items: out.results || [] });
  }
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    const username = String((body && body.username) || "").trim();
    const userId = Number(body && body.userId);
    const tool = String((body && body.tool) || "Account Checker").slice(0, 60);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username) || !Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ ok: false });
    }
    const last = await d1("SELECT user_id, tool FROM lookups ORDER BY id DESC LIMIT 1");
    const lr = last && last.results && last.results[0];
    if (lr && lr.user_id === userId && lr.tool === tool) {
      return res.status(200).json({ ok: true, deduped: true });
    }
    const ins = await d1(
      "INSERT INTO lookups (username, user_id, tool, ts) VALUES (?, ?, ?, ?)",
      [username, userId, tool, Date.now()]
    );
    return res.status(200).json({ ok: !!ins });
  }
  return res.status(405).json({ error: "method not allowed" });
};
