/* TheraChart sync layer.

   Modes:
   - "server"  — the app is served by the clinic server: logins authenticate
     server-side, changes push automatically (merged, never clobbered), and
     other devices' changes pull in within seconds.
   - "offline" — this device belongs to a clinic server but can't reach it
     right now (home visit, brownout). Work continues against the last-synced
     copy: unlock with your PIN (allowed up to 72 h after the last sync),
     every change is counted as queued, and the moment the server is
     reachable again everything merges — entities created offline always
     survive; concurrent edits resolve newest-wins with the superseded
     version noted in the audit log.
   - "local"   — no clinic server has ever been seen (static hosting, the
     demo): records simply stay on this device. */

(() => {
  "use strict";

  const S = window.TheraStore;
  const LS_TOKEN = "therachart-token";
  const LS_SEEN = "therachart-server-seen";
  const LS_LASTSYNC = "therachart-lastsync";
  const LS_DIRTY = "therachart-dirty";
  const LS_WHISPER = "therachart-whisper-seen";
  const OFFLINE_UNLOCK_MS = 72 * 3600 * 1000;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };

  const sync = {
    mode: "local",
    rev: 0,
    token: lsGet(LS_TOKEN) || null,
    dirty: Number(lsGet(LS_DIRTY) || 0),
    lastSync: Number(lsGet(LS_LASTSYNC) || 0),
    whisper: lsGet(LS_WHISPER) === "1",
    lastError: null,
  };
  window.TheraSync = sync;

  /* ---- status badge ---- */
  const badge = document.createElement("div");
  badge.id = "syncBadge";
  badge.style.cssText =
    "position:fixed; right:12px; bottom:10px; z-index:50; font-size:11px; font-weight:600;" +
    "padding:4px 10px; border-radius:999px; box-shadow:0 1px 4px rgba(0,0,0,.18);" +
    "background:var(--panel); color:var(--muted); border:1px solid var(--border); pointer-events:none;";
  document.body.appendChild(badge);
  function setBadge() {
    if (sync.mode === "server") {
      badge.textContent = sync.dirty ? `● Syncing ${sync.dirty} change${sync.dirty > 1 ? "s" : ""}…` : "● Synced with clinic server";
      badge.style.color = "var(--good)";
    } else if (sync.mode === "offline") {
      badge.textContent = sync.dirty
        ? `● Offline — ${sync.dirty} change${sync.dirty > 1 ? "s" : ""} will sync on reconnect`
        : "● Offline — reconnecting to clinic server…";
      badge.style.color = "var(--review)";
    } else {
      badge.textContent = "● On-device only (no clinic server)";
      badge.style.color = "var(--muted)";
    }
  }
  setBadge();

  function setDirty(n) {
    sync.dirty = n;
    lsSet(LS_DIRTY, String(n));
    setBadge();
  }

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

  /* ---- adopt / merge ---- */
  function adopt(payload) {
    sync.rev = payload.rev;
    S.importAll(payload.state, { preserveSession: true });
    sync.lastSync = Date.now();
    lsSet(LS_LASTSYNC, String(sync.lastSync));
  }

  function mergeAndAdopt(serverPayload) {
    const local = JSON.parse(S.exportAll());
    const { state: merged, conflicts } = S.mergeStates(serverPayload.state, local);
    sync.rev = serverPayload.rev;
    S.importAll(merged, { preserveSession: true });
    const user = S.currentUser();
    for (const c of conflicts) S.audit(user ? user.id : null, "sync-conflict", c.note);
    return conflicts.length;
  }

  /* ---- push (merge on conflict — nothing is ever clobbered) ---- */
  let pushTimer = null;
  function schedulePush() {
    setDirty(sync.dirty + 1);
    if (sync.mode !== "server" || !sync.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 600);
  }

  async function push() {
    if (sync.mode !== "server" || !sync.token) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const state = JSON.parse(S.exportAll());
        state.sessionUserId = null;
        const res = await api("/api/state", { method: "PUT", body: { baseRev: sync.rev, state } });
        if (res.ok) {
          sync.rev = res.data.rev;
          sync.lastSync = Date.now();
          lsSet(LS_LASTSYNC, String(sync.lastSync));
          setDirty(0);
          return;
        }
        if (res.status === 409) { mergeAndAdopt(res.data); continue; } // re-push merged
        if (res.status === 401) { goOffline("session expired"); return; }
        return;
      } catch (e) {
        goOffline(e.message);
        return;
      }
    }
  }

  /* ---- pull other devices' changes ---- */
  async function poll() {
    if (sync.mode === "offline") return reconnectTry();
    if (sync.mode !== "server" || !sync.token) return;
    try {
      const r = await api("/api/rev");
      if (r.status === 401) return; // will re-auth on next login
      if (r.ok && r.data.rev !== sync.rev) {
        const st = await api("/api/state");
        if (st.ok) {
          if (sync.dirty) { mergeAndAdopt(st.data); push(); }
          else adopt(st.data);
          rerender();
        }
      }
    } catch (e) { goOffline(e.message); }
  }
  setInterval(poll, 6000);

  function rerender() {
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    if (!typing && window.TheraRender) window.TheraRender();
  }

  /* ---- offline handling ---- */
  function goOffline(why) {
    if (lsGet(LS_SEEN) !== "1") return; // never had a server: stay local
    if (sync.mode !== "offline") console.warn("[sync] offline:", why);
    sync.mode = "offline";
    setBadge();
  }

  async function reconnectTry() {
    try {
      const res = await fetch("/api/ping", { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (!data || data.server !== "therachart") return;
      sync.mode = "server";
      sync.whisper = !!data.whisper;
      lsSet(LS_WHISPER, sync.whisper ? "1" : "0");
      // token still valid?
      const check = await api("/api/rev");
      if (check.status === 401) {
        sync.token = null;
        lsSet(LS_TOKEN, "");
        badge.textContent = "● Reconnected — sign in again to sync your changes";
        badge.style.color = "var(--review)";
        return;
      }
      const st = await api("/api/state");
      if (st.ok) {
        if (sync.dirty) { mergeAndAdopt(st.data); await push(); }
        else adopt(st.data);
        rerender();
      }
      setBadge();
    } catch { /* still offline */ }
  }

  /* ---- login: server-side when reachable, offline unlock otherwise ---- */
  const localLogin = S.login;
  S.login = async (userId, pin) => {
    if (sync.mode === "local") return localLogin(userId, pin);

    if (sync.mode === "offline") {
      const age = Date.now() - sync.lastSync;
      if (!sync.lastSync || age > OFFLINE_UNLOCK_MS) {
        return "Offline, and this device's copy is too old to trust (last synced " +
          (sync.lastSync ? Math.round(age / 3600000) + "h ago" : "never") +
          "). Connect to the clinic server to sign in.";
      }
      const fail = localLogin(userId, pin);
      if (!fail) S.audit(userId, "login-offline", `last sync ${Math.round(age / 60000)} min ago`);
      return fail;
    }

    try {
      const res = await api("/api/login", { method: "POST", body: { userId, pin } });
      if (!res.ok) return res.data.error || "Login failed.";
      sync.token = res.data.token;
      lsSet(LS_TOKEN, sync.token);
      if (sync.dirty) {
        // offline work from before this login: merge it into the server copy
        mergeAndAdopt(res.data);
        const st = S.load();
        st.sessionUserId = userId;
        S.save();
        await push();
      } else {
        adopt(res.data);
        const st = S.load();
        st.sessionUserId = userId;
        S.save();
        setDirty(0);
      }
      return null;
    } catch (e) {
      goOffline("server unreachable during login");
      return S.login(userId, pin); // falls into the offline-unlock path
    }
  };

  /* ---- boot ---- */
  (async () => {
    try {
      const res = await fetch("/api/ping", { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (data && data.server === "therachart") {
        sync.mode = "server";
        sync.rev = data.rev;
        sync.whisper = !!data.whisper;
        lsSet(LS_SEEN, "1");
        lsSet(LS_WHISPER, sync.whisper ? "1" : "0");

        // refresh login screen info from the server
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

        // token from a previous visit? resume and sync any queued work
        if (sync.token) {
          const check = await api("/api/rev");
          if (check.ok) {
            const stt = await api("/api/state");
            if (stt.ok) {
              if (sync.dirty) { mergeAndAdopt(stt.data); await push(); }
              else adopt(stt.data);
            }
          } else {
            sync.token = null;
            lsSet(LS_TOKEN, "");
          }
        }
        if (window.TheraRender) window.TheraRender();
      } else if (lsGet(LS_SEEN) === "1") {
        sync.mode = "offline";
      }
    } catch (_) {
      if (lsGet(LS_SEEN) === "1") sync.mode = "offline";
    }
    setBadge();
    S.setChangeHook(sync.mode === "local" ? null : schedulePush);
    if (window.TheraRender) window.TheraRender();
  })();
})();
