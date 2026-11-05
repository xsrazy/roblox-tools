// Roblox Tools - shared helpers for tool pages.
(function () {
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) {
    if (n === null || n === undefined || n === "") return "-";
    var v = Number(n);
    return isNaN(v) ? String(n) : v.toLocaleString("en-US");
  }
  function fmtDate(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Jakarta",
    });
  }
  function param(name) {
    return new URLSearchParams(location.search).get(name) || "";
  }
  function setStatus(el, msg, isError) {
    if (!el) return;
    el.className = "status" + (isError ? " error" : "");
    el.textContent = msg || "";
  }
  // Resolve a username OR numeric user ID to {id, username, displayName, created, isBanned, description}.
  // Throws Error("User not found") / Error("Lookup failed").
  async function resolveUser(input) {
    var v = String(input || "").trim();
    if (!v) throw new Error("Empty input");
    var url = /^\d+$/.test(v)
      ? "/api/resolve?userId=" + encodeURIComponent(v)
      : "/api/resolve?username=" + encodeURIComponent(v);
    var r = await fetch(url);
    var data = null;
    try {
      data = await r.json();
    } catch (e) {
      /* ignore */
    }
    if (!r.ok || !data || data.error) {
      throw new Error(data && data.error === "User not found" ? "User not found" : "Lookup failed");
    }
    return data;
  }
  function fetchJson(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (d) {
        return { ok: r.ok, status: r.status, data: d };
      });
    });
  }
  // Paste-a-link support: a Roblox link pasted or typed into any text
  // input is replaced by the numeric ID it points to (catalog item, library
  // item, bundle, user profile, group, community, game). Inputs can opt
  // out with a data-nolink attribute.
  function extractRobloxId(v) {
    var s = String(v || "").trim();
    if (!/roblox\.com|https?:\/\//i.test(s)) return null;
    var m =
      s.match(/\/share\/g\/(\d+)/i) ||
      s.match(/\/(?:catalog|library|bundles|users|groups|communities|games)\/(\d+)/i) ||
      s.match(/[?&](?:id|assetId|bundleId|groupId|placeId|userId)=(\d+)/i);
    return m ? m[1] : null;
  }
  function convertLinkInput(t) {
    if (!t || t.tagName !== "INPUT") return;
    if (t.type !== "text" && t.type !== "search") return;
    if (t.hasAttribute("data-nolink")) return;
    var id = extractRobloxId(t.value);
    if (id && t.value.trim() !== id) t.value = id;
  }
  // Paste converts instantly; a typed-out link converts on change and
  // again on submit (capture phase, before the page's own handler runs).
  document.addEventListener(
    "input",
    function (e) {
      if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") convertLinkInput(e.target);
    },
    true
  );
  document.addEventListener("change", function (e) { convertLinkInput(e.target); }, true);
  document.addEventListener(
    "submit",
    function (e) {
      var f = e.target;
      if (!f || !f.querySelectorAll) return;
      var inputs = f.querySelectorAll('input[type="text"], input[type="search"]');
      for (var i = 0; i < inputs.length; i++) convertLinkInput(inputs[i]);
    },
    true
  );
  window.RT = { esc: esc, fmt: fmt, fmtDate: fmtDate, param: param, setStatus: setStatus, resolveUser: resolveUser, fetchJson: fetchJson, extractRobloxId: extractRobloxId };
})();

// Public recent-lookups feed: record which usernames get checked, and with which tool.
(function () {
  try {
    var h1 = document.querySelector("h1");
    var toolName = h1 ? h1.textContent.trim().replace(/\s+/g, " ").slice(0, 60) : "";
    if (!toolName) return;
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (!f || !f.querySelector) return;
      var inp = f.querySelector('input[type="text"], input[type="search"], input:not([type])');
      if (!inp) return;
      var v = (inp.value || "").trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(v) || /^\d+$/.test(v)) return;
      fetch("/api/user?username=" + encodeURIComponent(v))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (u) {
          if (!u || !u.id || !u.username) return;
          if (u.username.toLowerCase() !== v.toLowerCase()) return;
          fetch("/api/history", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: u.username, userId: u.id, tool: toolName }) }).catch(function () {});
        })
        .catch(function () {});
    }, true);
  } catch (e) {}
})();
