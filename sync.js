/* TheraChart sync layer.
   When the app is served by the clinic server (server.js), this keeps every
   device on the shared clinic database: logins authenticate server-side,
   changes push automatically, and other devices' changes pull in within a
   few seconds. Without a server (file://, static hosting, the hosted demo)
   everything silently stays in on-device mode. */

(() => {
  "use strict";

  const S = window.TheraStore;
  const sync = { mode: "local", rev: 0, token: null, lastError: null };
  window.TheraSync = sync;

  const badge = document.createElement("div");
  badge.id = "syncBadge";
  badge.style.cssText =
    "position:fixed; right:12px; bottom:10px; z-index:50; font-size:11px; font-weight:600;" +
    "padding:4px 10px; border-radius:999px; box-shadow:0 1px 4px rgba(0,0,0,.18);" +
    "background:var(--panel); color:var(--muted); border:1px solid var(--border); pointer-events:none;";
  document.body.appendChild(badge);
  function setBadge() {
    badge.textContent = sync.mode === "server"
      ? "● Synced with clinic server"
      : "● On-device only (no clinic server)";
    badge.style.color = sync.mode === "server" ? "var(--good)" : "var(--muted)";
  }
  setBadge();

  async function api(pathname, opts = {}) {
    const headers = { "content-type": "application/json" };
    if (sync.token) headers.authorization = `Bearer ${sync.token}`;
    const res = await fetch(pathname, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  /* ---- push local changes (debounced full-state sync with rev check) ---- */
  let pushTimer = null;
  function schedulePush() {
    if (sync.mode !== "server" || !sync.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 600);
  }
  async function push() {
    try {
      const state = JSON.parse(S.exportAll());
      state.sessionUserId = null;
      const res = await api("/api/state", { method: "PUT", body: { baseRev: sync.rev, state } });
      if (res.ok) {
        sync.rev = res.data.rev;
      } else if (res.status === 409) {
        // Someone else saved first — their copy wins; re-apply on top if needed.
        console.warn("[sync] conflict: refreshing from clinic server");
        adopt(res.data);
        rerender();
      }
    } catch (e) {
      sync.lastError = e.message;
    }
  }

  /* ---- pull remote changes ---- */
  function adopt(payload) {
    sync.rev = payload.rev;
    S.importAll(payload.state, { preserveSession: true });
  }
  async function poll() {
    if (sync.mode !== "server" || !sync.token) return;
    try {
      const r = await api("/api/rev");
      if (r.ok && r.data.rev !== sync.rev) {
        const st = await api("/api/state");
        if (st.ok) {
          adopt(st.data);
          rerender();
        }
      }
    } catch (e) { sync.lastError = e.message; }
  }
  function rerender() {
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if (!typing && window.TheraRender) window.TheraRender();
  }
  setInterval(poll, 6000);

  /* ---- server-side login ---- */
  const localLogin = S.login;
  S.login = async (userId, pin) => {
    if (sync.mode !== "server") return localLogin(userId, pin);
    try {
      const res = await api("/api/login", { method: "POST", body: { userId, pin } });
      if (!res.ok) return res.data.error || "Login failed.";
      sync.token = res.data.token;
      adopt(res.data);
      const st = S.load();
      st.sessionUserId = userId;
      S.save();
      return null;
    } catch (e) {
      console.warn("[sync] server unreachable during login; using on-device mode");
      sync.mode = "local";
      setBadge();
      return localLogin(userId, pin);
    }
  };

  /* ---- boot: detect the clinic server ---- */
  (async () => {
    try {
      const res = await fetch("/api/ping", { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (data && data.server === "therachart") {
        sync.mode = "server";
        sync.rev = data.rev;
        // Refresh the login screen's user list / facility name from the server
        const boot = await fetch("/api/bootstrap").then((r) => r.json());
        const st = S.load();
        st.settings.facilityName = boot.facilityName || st.settings.facilityName;
        for (const bu of boot.users) {
          const local = st.users.find((u) => u.id === bu.id);
          if (local) {
            local.name = bu.name; local.role = bu.role; local.active = bu.active;
            if (bu.license) local.license = Object.assign(local.license || {}, bu.license);
          } else {
            st.users.push(Object.assign({ pin: null, license: null }, bu));
          }
        }
        S.save();
        setBadge();
        S.setChangeHook(schedulePush);
        if (window.TheraRender) window.TheraRender();
      }
    } catch (_) {
      /* no server: on-device mode */
    }
    setBadge();
    if (sync.mode === "local") S.setChangeHook(null);
  })();
})();
