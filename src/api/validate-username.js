// Roblox Tools - Username Validation API.
// GET /api/validate-username?username=<name>
// Returns {code, message, valid} straight from Roblox's username validator.
// Verified live from this environment:
//   - https://users.roblox.com/v1/usernames/validate returns 404 with an
//     {errors:[...]} body (no top-level {code,message}), so it never wins.
//   - https://auth.roblox.com/v1/usernames/validate returns 403 with an
//     x-csrf-token response header; retrying once with that header returns
//     200 {code, message} (code 1 for "*****", code 0 for a free name).
// Never throws: total failure degrades to {code: null, message, valid:false}.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const HOSTS = [
  "https://users.roblox.com/v1/usernames/validate",
  "https://auth.roblox.com/v1/usernames/validate",
];

// One POST attempt. Returns {status, json, csrf} — json is null when the body
// is not JSON. Custom fetch (not jfetch) because the CSRF retry needs the
// x-csrf-token response header, which jfetch hides.
async function postValidate(url, username, csrf) {
  try {
    const headers = {
      "User-Agent": UA,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (csrf) headers["x-csrf-token"] = csrf;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username,
        context: "Signup",
        birthday: "2000-01-01T00:00:00.000Z",
      }),
    });
    let json = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { status: r.status, json, csrf: r.headers.get("x-csrf-token") };
  } catch {
    return { status: 0, json: null, csrf: null };
  }
}

function isVerdict(json) {
  return !!json && typeof json.code === "number" && typeof json.message === "string";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  const username = String((req.query && req.query.username) || "").trim();
  if (!username) {
    res.status(400).json({ error: "Missing username" });
    return;
  }

  for (const host of HOSTS) {
    let attempt = await postValidate(host, username, null);
    // CSRF pattern: a 403 carrying an x-csrf-token header gets one retry
    // with that token.
    if (attempt.status === 403 && attempt.csrf) {
      attempt = await postValidate(host, username, attempt.csrf);
    }
    if (isVerdict(attempt.json)) {
      res.status(200).json({
        code: attempt.json.code,
        message: attempt.json.message,
        valid: attempt.json.code === 0,
      });
      return;
    }
  }

  res.status(200).json({
    code: null,
    message: "Roblox did not return a verdict for this username. Please try again.",
    valid: false,
  });
};
