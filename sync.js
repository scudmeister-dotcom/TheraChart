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
  const LS_STT = "therachart-stt-avail";
  const OFFLINE_UNLOCK_MS = 72 * 3600 * 1000;

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { } };

  const sync = {
    mode: "local",
    rev: 0,
    token: lsGet(LS_TOKEN) || null,
    dirty: Number(lsGet(LS_DIRTY) || 0),
    lastSync: Number(lsGet(LS_LASTSYNC) || 0),
    stt: { available: lsGet(LS_STT) === "1" }, // Google Cloud Speech-to-Text availability from the server
    ai: null, // { refine, insights, model } when an AI backend is reachable
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
    let text, color;
    if (sync.mode === "server") {
      text = sync.dirty ? `● Syncing ${sync.dirty} change${sync.dirty > 1 ? "s" : ""}…` : "● Synced with clinic server";
      color = "var(--good)";
    } else if (sync.mode === "offline") {
      text = sync.dirty
        ? `● Offline — ${sync.dirty} change${sync.dirty > 1 ? "s" : ""} will sync on reconnect`
        : "● Offline — reconnecting to clinic server…";
      color = "var(--review)";
    } else {
      text = "● On-device only (no clinic server)";
      color = "var(--muted)";
    }
    badge.textContent = text;
    badge.style.color = color;
    // Mirror the same state into the mobile top-bar dot the app shell renders.
    // On phones the full badge is hidden and this compact dot stands in for it.
    const dot = document.getElementById("topSyncDot");
    if (dot) {
      const label = text.replace(/^●\s*/, "");
      dot.style.color = color;
      dot.title = label;
      dot.setAttribute("aria-label", label);
    }
  }
  // The app shell re-renders on every navigation, replacing the top-bar dot;
  // it calls this afterwards to repaint the dot with the current state.
  sync.refreshBadge = setBadge;
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

  /* Which clinic a state blob belongs to — used to notice a device changing
     hands between clinics (a shared clinic tablet, most often). */
  function clinicOfState(state, userId) {
    if (!state) return null;
    const u = (state.users || []).find((x) => x.id === userId);
    if (u && u.clinicId) return u.clinicId;
    const rec = (state.patients || [])[0] || (state.documents || [])[0] || (state.appointments || [])[0];
    return (rec && rec.clinicId) || null;
  }

  /* Take up the server's copy after a successful sign-in, merging this device's
     offline work only when it belongs to the SAME clinic. A device that changes
     hands between clinics must not carry the previous clinic's records into the
     new session — that leaks the last user's PHI and the server drops the rows
     on push anyway.

     Both sign-in paths go through here on purpose. They had drifted: the
     password path checked the clinic and the Google path did not, so a Google
     sign-in on a device holding demo-clinic state merged it straight in. */
  async function adoptAfterLogin(payload, uid) {
    const localState = S.load();
    const was = clinicOfState(localState, localState.sessionUserId);
    const now = clinicOfState(payload.state, uid);
    const switchedClinic = !!(was && now && was !== now);

    if (sync.dirty && !switchedClinic) {
      mergeAndAdopt(payload);                 // offline work from before this login
      const st = S.load(); st.sessionUserId = uid; S.save();
      await push();
      return;
    }
    adopt(payload);
    const st = S.load(); st.sessionUserId = uid; S.save();
    setDirty(0);
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
  let pollBusy = false; // never stack polls on a slow/hung connection
  async function poll() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      if (sync.mode === "offline") return await reconnectTry();
      if (sync.mode !== "server" || !sync.token) return;
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
    finally { pollBusy = false; }
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
      sync.stt = data.stt || { available: false };
      lsSet(LS_STT, sync.stt.available ? "1" : "0");
      // refresh the AI-engine indicator too, so it isn't stale after reconnect
      await sync.probeAI();
      if (sync.ai) sync.refine = sync.ai.refine;
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

  /* ---- login: server-side when reachable, offline unlock otherwise.
     `identifier` is the employee's email (a user id also works, back-compat). ---- */
  const localLogin = S.login;
  S.login = async (identifier, password) => {
    if (sync.mode === "local") return localLogin(identifier, password);

    if (sync.mode === "offline") {
      const age = Date.now() - sync.lastSync;
      if (!sync.lastSync || age > OFFLINE_UNLOCK_MS) {
        return "Offline, and this device's copy is too old to trust (last synced " +
          (sync.lastSync ? Math.round(age / 3600000) + "h ago" : "never") +
          "). Connect to the clinic server to sign in.";
      }
      // Passwords live only on the server; synced state carries no credential to
      // check against — a fresh sign-in needs the server. (An already-signed-in
      // device keeps working offline on its existing token.)
      const u = S.findUserByLogin(identifier);
      if (u && u.pin == null && u.passwordHash == null) {
        return "You're offline. Signing in requires the clinic server (passwords are verified there). Reconnect to sign in.";
      }
      const fail = localLogin(identifier, password);
      if (!fail && u) S.audit(u.id, "login-offline", `last sync ${Math.round(age / 60000)} min ago`);
      return fail;
    }

    try {
      const res = await api("/api/login", { method: "POST", body: { email: identifier, password } });
      if (!res.ok) return res.data.error || "Login failed.";
      sync.token = res.data.token;
      lsSet(LS_TOKEN, sync.token);
      await adoptAfterLogin(res.data, res.data.userId);
      return null;
    } catch (e) {
      goOffline("server unreachable during login");
      return S.login(identifier, password); // falls into the offline-unlock path
    }
  };

  /* Google sign-in: exchange a Google ID token (from the GIS button) for a
     server session, then adopt the server copy — the same success path as the
     password login above. Server-mode + online only: an offline device can't
     verify a Google token. Returns null on success or an error string. */
  sync.googleLogin = async (credential) => {
    if (sync.mode !== "server") return "Google sign-in needs the clinic server — you appear to be offline.";
    try {
      const res = await api("/api/google-login", { method: "POST", body: { credential } });
      if (!res.ok) return (res.data && res.data.error) || "Google sign-in failed.";
      sync.token = res.data.token;
      lsSet(LS_TOKEN, sync.token);
      await adoptAfterLogin(res.data, res.data.userId);
      return null;
    } catch (_) {
      return "Couldn't reach the clinic server for Google sign-in.";
    }
  };

  /* Re-authenticate the current user (for e-signing / amending). Server-side
     when online (passwords are hashed there); local check in demo mode. */
  /* Re-authenticate a Google account for e-signing, using a fresh ID token.
     Returns { ok } or { ok:false, error }. There is no offline fallback: a
     Google token can only be checked against Google's keys, so a device that
     can't reach the server can't complete a signature this way. */
  sync.verifyGoogle = async (credential) => {
    if (sync.mode !== "server") return { ok: false, error: "Signing with Google needs the clinic server." };
    try {
      const res = await api("/api/verify-google", { method: "POST", body: { credential } });
      if (!res.ok) return { ok: false, error: (res.data && res.data.error) || "Couldn't verify that Google account." };
      return res.data && res.data.ok ? { ok: true } : { ok: false, error: (res.data && res.data.error) || "Google verification failed." };
    } catch (_) {
      return { ok: false, error: "Couldn't reach the clinic server to verify." };
    }
  };

  sync.verifyPassword = async (pw) => {
    const u = S.currentUser();
    if (!u) return false;
    if (sync.mode === "local") return S.verifyPassword(u.id, pw);
    try {
      const res = await api("/api/verify-password", { method: "POST", body: { password: pw } });
      return !!(res.ok && res.data && res.data.ok);
    } catch (_) {
      return S.verifyPassword(u.id, pw); // offline best-effort
    }
  };

  /* Change a password. Self-change needs the current one; an admin may set
     another user's (pass userId). Returns null on success or an error string. */
  sync.changePassword = async ({ userId, currentPassword, newPassword }) => {
    if (sync.mode === "local") {
      const me = S.currentUser();
      const target = userId && userId !== me.id ? userId : me.id;
      if (target === me.id) { if (!S.verifyPassword(me.id, currentPassword)) return "Current password is incorrect."; }
      else if (me.role !== "admin") return "Only an administrator can change another user's password.";
      const r = S.setPassword(target, newPassword, me);
      return r.error || null;
    }
    const res = await api("/api/set-password", { method: "POST", body: { userId, currentPassword, newPassword } });
    if (res.ok && !userId) { const st = await api("/api/state"); if (st.ok) adopt(st.data); } // clear mustChangePassword locally
    return res.ok ? null : ((res.data && res.data.error) || "Could not change password.");
  };

  /* Blend the therapist's own wording with the AI's, for one field.
     Server-only and deliberately explicit: the result is shown for editing and
     never written to the note without the therapist pressing Apply. */
  sync.blendNote = async ({ mine, ai, field, type }) => {
    if (sync.mode !== "server" || !sync.token) return null;
    const res = await api("/api/blend-note", { method: "POST", body: { mine, ai, field, type } });
    return res.ok ? res.data : null;
  };

  /* File a tester's bug report. Server-only: there is nowhere for a report to
     go in local/offline mode, and silently swallowing one would be worse than
     saying so. Returns null on success, or a message to show the reporter. */
  sync.sendBugReport = async (report) => {
    if (sync.mode !== "server" || !sync.token) {
      return "Bug reports need the clinic server — this device isn't connected to one right now.";
    }
    const res = await api("/api/bug-report", { method: "POST", body: report });
    if (res.ok) return null;
    return (res.data && res.data.error) || "Couldn't send that report. Please try again, or tell Amador directly.";
  };

  /* Admin: create an employee. Server-authoritative (password hashed there),
     then re-pull so the new user appears. Returns { error } or { userId }. */
  sync.addUser = async (fields) => {
    if (sync.mode === "offline") return { error: "Reconnect to the clinic server to add an employee." };
    if (sync.mode === "server" && sync.token) {
      const r = await api("/api/users", { method: "POST", body: fields });
      if (!r.ok) return { error: (r.data && r.data.error) || "Couldn't add the employee." };
      const st = await api("/api/state"); if (st.ok) adopt(st.data);
      return { userId: r.data.userId };
    }
    const r = S.addUser(fields, S.currentUser());
    return r.error ? { error: r.error } : { userId: r.user.id };
  };

  /* Admin: remove an employee. */
  sync.deleteUser = async (userId) => {
    if (sync.mode === "offline") return "Reconnect to the clinic server to remove an employee.";
    if (sync.mode === "server" && sync.token) {
      const r = await api("/api/delete-user", { method: "POST", body: { userId } });
      if (!r.ok) return (r.data && r.data.error) || "Couldn't remove the employee.";
      const st = await api("/api/state"); if (st.ok) adopt(st.data);
      return null;
    }
    const r = S.deleteUser(userId, S.currentUser());
    return r.error || null;
  };

  /* Admin: reset another user's password to a temporary one (forces a change
     at their next login). Delegates to set-password with a userId. */
  sync.resetPassword = async (userId, tempPassword) => {
    if (sync.mode === "offline") return "Reconnect to the clinic server to reset a password.";
    if (sync.mode === "server" && sync.token) {
      const r = await api("/api/set-password", { method: "POST", body: { userId, newPassword: tempPassword } });
      if (!r.ok) return (r.data && r.data.error) || "Couldn't reset the password.";
      const st = await api("/api/state"); if (st.ok) adopt(st.data);
      return null;
    }
    const r = S.setPassword(userId, tempPassword, S.currentUser(), { mustChange: true });
    return r.error || null;
  };

  /* ---- file attachments (bytes kept out of the synced state) ----
     Upload returns a reference to store on the patient: { key } when a server
     holds the bytes, or { dataUrl } in the single-device demo (no server). */
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || ""); // strip data: prefix
    r.onerror = () => reject(new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
  // Store raw base64 bytes; returns { key } (server) or { dataUrl } (demo/offline).
  sync.storeBytes = async (name, type, base64, size) => {
    if (sync.mode === "server" && sync.token) {
      const r = await api("/api/files", { method: "POST", body: { name, type, dataBase64: base64 } });
      if (!r.ok) throw new Error((r.data && r.data.error) || "Upload failed.");
      return { key: r.data.key, size: r.data.size };
    }
    // Without a server the bytes live inside browser storage (~5 MB quota for
    // everything). A big data-URL would silently break every save after it.
    if (base64.length > 3 * 1024 * 1024) {
      throw new Error(sync.mode === "offline"
        ? "Files this large need the clinic server — reconnect and try again (offline attachments are limited to ~2 MB)."
        : "In on-device demo mode attachments are limited to ~2 MB (they share the browser's small storage quota).");
    }
    return { dataUrl: `data:${type || "application/octet-stream"};base64,${base64}`, size };
  };

  sync.uploadFile = async (file) => sync.storeBytes(file.name, file.type, await fileToBase64(file), file.size);

  // Trigger a browser download for an attachment (server key or legacy dataUrl).
  sync.downloadFile = async (att) => {
    const click = (href) => { const a = document.createElement("a"); a.href = href; a.download = att.name || "file"; document.body.appendChild(a); a.click(); a.remove(); };
    if (att.dataUrl) return click(att.dataUrl);
    const res = await fetch(`/api/files?key=${encodeURIComponent(att.key)}`, { headers: sync.token ? { authorization: `Bearer ${sync.token}` } : {} });
    if (!res.ok) throw new Error("Download failed.");
    const url = URL.createObjectURL(await res.blob());
    click(url);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  };

  /* ---- AI transcript refinement ----
     Uses the clinic server (Gemini if configured, else server-local) when
     online; falls back to the in-browser local refiner otherwise, so the
     "Review & clean up" pass always works. */
  // These call the AI endpoints when they exist (clinic server OR a Vercel
  // deployment with GEMINI_API_KEY set), else the in-browser local fallback.
  sync.refineTranscript = async (utterances) => {
    if (sync.ai) {
      try {
        const r = await api("/api/refine", { method: "POST", body: { transcript: utterances } });
        if (r.ok) return r.data;
      } catch (_) { /* fall through to local */ }
    }
    return { ...window.TheraParser.refineTranscript(utterances), source: "local" };
  };

  // Read a scanned/uploaded document (base64) into structured visit records.
  // Needs the Gemini backend — there is no local OCR fallback.
  sync.extractRecords = async (fileBase64, mime) => {
    if (!sync.ai) throw new Error("no AI backend");
    const r = await api("/api/extract-doc", { method: "POST", body: { pdf: fileBase64, mime } });
    if (!r.ok) throw new Error((r.data && r.data.error) || "Couldn't read the document.");
    return r.data;
  };

  sync.getInsights = async (ctx) => {
    if (sync.ai) {
      try {
        const r = await api("/api/insights", { method: "POST", body: ctx });
        if (r.ok) return r.data;
      } catch (_) { /* fall through to local */ }
    }
    return window.TheraInsights.buildInsights(ctx);
  };

  // Ask the grounded per-patient assistant a question. Model-only — there is
  // no local fallback for freeform Q&A, so this throws when no AI backend is
  // reachable (the UI shows an "unavailable" state instead).
  sync.askPatient = async ({ chart, question, history }) => {
    if (!sync.ai || sync.ai.assistant === "unavailable") throw new Error("no AI backend");
    const r = await api("/api/patient-assistant", { method: "POST", body: { chart, question, history } });
    if (!r.ok) throw new Error((r.data && r.data.error) || "The assistant couldn't answer that.");
    return r.data;
  };

  // The Gemini backend is configured only through host environment variables
  // (GEMINI_API_KEY on Vercel, or GEMINI_VERTEX=1 + GCP creds on Cloud Run) —
  // there is no in-app key entry, so nothing here writes the key.

  // Probe whether an AI backend is reachable (Vercel serverless or clinic
  // server). Sets sync.ai = { refine, insights, model } or leaves it null.
  sync.probeAI = async () => {
    try {
      const res = await fetch("/api/ai-status", { signal: AbortSignal.timeout(2500) });
      if (res.ok) { sync.ai = await res.json(); }
    } catch (_) { /* no AI backend: local fallback */ }
    return sync.ai;
  };

  /* ---- boot ---- */
  (async () => {
    try {
      const res = await fetch("/api/ping", { signal: AbortSignal.timeout(2500) });
      const data = await res.json();
      if (data && data.server === "therachart") {
        sync.mode = "server";
        sync.rev = data.rev;
        sync.stt = data.stt || { available: false };
        sync.refine = data.refine || "local"; // "gemini" | "local"
        lsSet(LS_SEEN, "1");
        lsSet(LS_STT, sync.stt.available ? "1" : "0");

        // refresh the facility name for the login screen (the employee roster is
        // NOT fetched here anymore — employees sign in by email, no picker)
        const boot = await fetch("/api/bootstrap").then((r) => r.json());
        const st = S.load();
        st.settings.facilityName = boot.facilityName || st.settings.facilityName;
        S.save();
        sync.googleClientId = boot.googleClientId || ""; // "" → login screen hides the Google button
        sync.testAccounts = boot.testAccounts || [];     // demo logins surfaced on the sign-in screen

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
    // Detect an AI backend independently of the data-sync mode: this works on
    // a Vercel deployment (serverless functions using the GEMINI_API_KEY env
    // var) as well as a self-hosted clinic server. Static hosting → local.
    await sync.probeAI();
    if (sync.ai) {
      sync.refine = sync.ai.refine;
      // ai-status also reports STT availability (works on a clinic server or any
      // host that exposes /api/ai-status); keep the cached flag in step
      if (sync.ai.stt) { sync.stt = sync.ai.stt; lsSet(LS_STT, sync.ai.stt.available ? "1" : "0"); }
    }
    setBadge();
    S.setChangeHook(sync.mode === "local" ? null : schedulePush);
    if (window.TheraRender) window.TheraRender();
  })();
})();
