/* TheraChart EMR — application shell.
   Routing, role/license gating, patient management, clinical documents with
   voice dictation + body mapping (the core feature), calendar, privacy panel.
   All data stays on this device (see store.js). */

(() => {
  "use strict";

  const S = window.TheraStore;
  const PR = window.TheraParser;
  S.load();

  const app = document.getElementById("app");
  const modalRoot = document.getElementById("modalRoot");

  /* TheraChart logo — clipboard + rising bar chart + breakout arrow, with the
     spine motif. Recreated as clean SVG so it scales crisply and is truly
     transparent (no baked-in checkerboard). */
  const LOGO_MARK = `<svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="tcBar1" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2f9e6f"/><stop offset="1" stop-color="#4fc48c"/></linearGradient>
    <linearGradient id="tcBar2" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#2f9e6f"/><stop offset="1" stop-color="#57cf95"/></linearGradient>
    <linearGradient id="tcBar3" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#33a77a"/><stop offset="1" stop-color="#63d59d"/></linearGradient>
    <linearGradient id="tcSpine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b7bbd"/><stop offset="1" stop-color="#33b083"/></linearGradient>
  </defs>
  <path d="M15.5 11 C 10.5 17.5, 19 23, 13.5 29.5 C 9 35, 17 40, 12.5 46.5" stroke="url(#tcSpine)" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.55"/>
  <circle cx="15.4" cy="11.5" r="2.2" fill="#2b7bbd"/><circle cx="13.2" cy="18.6" r="2.2" fill="#2f8fb0"/>
  <circle cx="16.4" cy="25.2" r="2.2" fill="#2fa2a0"/><circle cx="12.8" cy="32.2" r="2.2" fill="#31ab90"/>
  <circle cx="15.2" cy="39.2" r="2.2" fill="#37b385"/><circle cx="12.6" cy="46" r="2.2" fill="#3fb87f"/>
  <rect x="24" y="13" width="27" height="33" rx="4" fill="#ffffff" stroke="#2b8fb0" stroke-width="3"/>
  <rect x="32.5" y="8.5" width="10" height="7.5" rx="2.4" fill="#2b7bbd"/>
  <rect x="29.5" y="31" width="4.6" height="9" rx="1.2" fill="url(#tcBar1)"/>
  <rect x="36" y="27" width="4.6" height="13" rx="1.2" fill="url(#tcBar2)"/>
  <rect x="42.5" y="23" width="4.6" height="17" rx="1.2" fill="url(#tcBar3)"/>
  <path d="M29 31 L35 25.5 L41 27.5 L52 15.5" stroke="#2b7bbd" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M46.5 14.6 L53 13.5 L52 20" stroke="#2b7bbd" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;
  const printArea = document.getElementById("printArea");

  /* ---------------- helpers ---------------- */

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const fmtDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "—";
  const fmtTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  const fmtDT = (iso) => (iso ? `${fmtDate(iso)} · ${fmtTime(iso)}` : "—");
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
  // local calendar date (UTC slices shift the date near midnight in +/- zones)
  const localIso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayIso = () => localIso(new Date());
  const nowTime = () =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const initials = (name) =>
    name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const age = (dob) => {
    if (!dob) return "—";
    const d = new Date(dob), n = new Date();
    let a = n.getFullYear() - d.getFullYear();
    if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--;
    return a;
  };

  const ICON = {
    dash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.2"/></svg>',
    people: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="5.5" cy="5" r="2.4"/><path d="M1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4"/><circle cx="11.5" cy="5.5" r="1.9"/><path d="M10.5 9.7c2 .2 3.5 1.8 3.9 3.8"/></svg>',
    cal: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.8" y="2.8" width="12.4" height="11.2" rx="1.5"/><path d="M1.8 6h12.4M5 1.2v3M11 1.2v3"/></svg>',
    shield: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z"/><path d="M5.6 8l1.7 1.7 3.1-3.4"/></svg>',
    gear: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4"/></svg>',
    user: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="5.2" r="2.7"/><path d="M2.8 14c.6-2.7 2.7-4.3 5.2-4.3s4.6 1.6 5.2 4.3"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5L5 8l4.5 4.5"/></svg>',
    signout: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6M10.5 11l3-3-3-3M13 8H6"/></svg>',
    logo: LOGO_MARK,
  };

  /* scroll memory: return to where you were when navigating back */
  const scrollMem = {};
  function restoreScroll(hash) {
    requestAnimationFrame(() => window.scrollTo(0, scrollMem[hash] || 0));
  }

  function showModal(html) {
    modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", (e) => {
      if (e.target.classList.contains("modal-backdrop")) closeModal();
    });
    return modalRoot.querySelector(".modal");
  }
  function closeModal() { modalRoot.innerHTML = ""; }

  function printHTML(html) {
    printArea.innerHTML = html;
    window.print();
  }
  // release the printed chart's HTML instead of holding it in the DOM forever
  window.addEventListener("afterprint", () => { printArea.innerHTML = ""; });

  /* ---------------- body map figure (shared) ---------------- */

  /* Clinical body chart in the style used on PT/EMR pain diagrams:
     a segmented, anatomically proportioned figure with visible region
     boundaries and posterior landmarks (spine, scapulae, gluteal fold). */

  function capsule(x1, y1, x2, y2, w) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const ang = (Math.atan2(-dx, dy) * 180) / Math.PI;
    return `<rect class="sil-part" x="${-w / 2}" y="${-w / 2}" width="${w}" height="${len + w}" rx="${w / 2}"
      transform="translate(${x1},${y1}) rotate(${ang})"/>`;
  }

  function figureMarkup(view) {
    const mirror = (inner) => inner + inner.replace(/translate\((-?[\d.]+),/g, (m, x) => `translate(${200 - Number(x)},`)
      .replace(/rotate\((-?[\d.]+)\)/g, (m, a) => `rotate(${-Number(a)})`);

    // limbs (left/viewer side), mirrored programmatically
    const limbsOneSide =
      capsule(52, 100, 45, 151, 15) +     // upper arm
      capsule(45, 156, 38, 207, 12) +     // forearm
      capsule(37, 213, 33.5, 243, 10.5) + // hand
      capsule(85, 236, 83, 306, 21) +     // thigh
      capsule(83, 313, 84.5, 388, 14.5) + // lower leg
      capsule(84.5, 393, 79.5, 411, 12);  // foot

    const deltoids = `
      <circle class="sil-part" cx="53" cy="95" r="11"/>
      <circle class="sil-part" cx="147" cy="95" r="11"/>`;

    const trunk = `
      <path class="sil-part" d="M63,82 Q100,73 137,82 Q144,86 144,96 L139,142
        Q137,151 128,153 L72,153 Q63,151 61,142 L56,96 Q56,86 63,82 Z"/>
      <path class="sil-part" d="M71,153 L129,153 Q133,160 132,168 Q131,180 133,190 L67,190
        Q69,180 68,168 Q67,160 71,153 Z"/>
      <path class="sil-part" d="M67,190 L133,190 Q139,199 136,213 Q131,227 117,232
        Q108,235 100,235 Q92,235 83,232 Q69,227 64,213 Q61,199 67,190 Z"/>`;

    const headNeck = `
      <ellipse class="sil-part" cx="100" cy="36" rx="18.5" ry="22.5"/>
      ${view === "front" ? `<ellipse class="sil-part" cx="80.5" cy="39" rx="3" ry="5.5"/>
      <ellipse class="sil-part" cx="119.5" cy="39" rx="3" ry="5.5"/>` : ""}
      <path class="sil-part" d="M92,54 L92,70 Q92,77 84,81 L116,81 Q108,77 108,70 L108,54
        Q104,59 100,59 Q96,59 92,54 Z"/>`;

    const backDetail = view !== "back" ? "" : `
      <line class="sil-line" x1="100" y1="83" x2="100" y2="188"/>
      <path class="sil-line" d="M76,97 Q84,99 87,107 L84,126 Q76,122 73,112 Z"/>
      <path class="sil-line" d="M124,97 Q116,99 113,107 L116,126 Q124,122 127,112 Z"/>
      <line class="sil-line" x1="100" y1="196" x2="100" y2="232"/>
      <path class="sil-line" d="M70,226 Q85,234 99,232" fill="none"/>
      <path class="sil-line" d="M130,226 Q115,234 101,232" fill="none"/>`;

    const frontDetail = view !== "front" ? "" : `
      <path class="sil-line" d="M78,89 Q89,86 97,88" fill="none"/>
      <path class="sil-line" d="M122,89 Q111,86 103,88" fill="none"/>`;

    return `
<svg viewBox="-64 -6 328 476" xmlns="http://www.w3.org/2000/svg" data-view="${view}">
  <g class="mannequin">
    ${mirror(limbsOneSide)}
    ${deltoids}
    ${trunk}
    ${headNeck}
    ${backDetail}
    ${frontDetail}
  </g>
  <g class="points-layer"></g>
</svg>`;
  }

  /* ---------------- router ---------------- */

  let activeDictation = null; // stop mic when leaving a document

  const NAV = [
    // `short` is the compact label used in the mobile bottom tab bar.
    { hash: "#/dashboard", label: "Dashboard", short: "Home", icon: ICON.dash, emr: true },
    { hash: "#/patients", label: "Patients", short: "Patients", icon: ICON.people, emr: true },
    { hash: "#/calendar", label: "Calendar", short: "Calendar", icon: ICON.cal, emr: true },
    { hash: "#/privacy", label: "Privacy & Security", short: "Privacy", icon: ICON.shield, emr: false },
    { hash: "#/facility", label: "Facility Admin", short: "Admin", icon: ICON.gear, emr: true, adminOnly: true },
    { hash: "#/profile", label: "My Profile", short: "Profile", icon: ICON.user, emr: false },
  ];

  function render() {
    if (activeDictation) { activeDictation.stop(); activeDictation = null; window.__theraDict = null; }
    currentDocState = null; // never carry one document's edit state into another
    closeModal();
    const user = S.currentUser();
    if (!user) return renderLogin();
    // New hires and admin-reset accounts must set their own password before doing anything.
    if (user.mustChangePassword) return renderForcePassword(user);

    const hash = location.hash || "#/dashboard";
    const emrAllowed = S.canAccessEmr(user);
    const route = (hash.split("/")[1] || "dashboard").split("?")[0];

    const emrRoutes = ["dashboard", "patients", "intake", "patient", "doc", "calendar", "facility"];
    if (!emrAllowed && emrRoutes.includes(route)) return renderShell(hash, blockedView(user), user);

    if (route === "dashboard") return renderShell(hash, dashboardView(user), user, bindDashboard);
    if (route === "patients") return renderShell(hash, patientsView(user), user, bindPatients);
    if (route === "intake") return renderShell(hash, intakeView(user), user, bindIntake);
    if (route === "patient") return renderShell(hash, patientView(user), user, bindPatient);
    if (route === "doc") return renderShell(hash, "", user, bindDoc); // doc builds its own DOM
    if (route === "calendar") return renderShell(hash, calendarView(user), user, bindCalendar);
    if (route === "privacy") return renderShell(hash, privacyView(user), user, bindPrivacy);
    if (route === "facility") {
      if (user.role !== "admin") return renderShell(hash, `<div class="card"><div class="empty-state">Facility administration is limited to admin accounts.</div></div>`, user);
      return renderShell(hash, facilityView(user), user, bindFacility);
    }
    if (route === "profile") return renderShell(hash, profileView(user), user, bindProfile);
    location.hash = "#/dashboard";
  }

  /* Breadcrumb trail for the current location — powers the back button and
     the "remember where I was" navigation inside a patient. */
  function breadcrumbFor(hash, user) {
    const seg = hash.replace(/^#\//, "").split("/");
    const route = (seg[0] || "dashboard").split("?")[0];
    const trail = [];
    const patientCrumb = (pid) => {
      const p = S.getPatient(pid);
      if (p) trail.push({ label: S.patientName(p), hash: `#/patient/${pid}` });
    };
    if (route === "patients") trail.push({ label: "Patients", hash: "#/patients" });
    else if (route === "patient") { trail.push({ label: "Patients", hash: "#/patients" }); patientCrumb((seg[1] || "").split("?")[0]); }
    else if (route === "doc") {
      const d = S.getDoc(seg[1]);
      trail.push({ label: "Patients", hash: "#/patients" });
      if (d) { patientCrumb(d.patientId); trail.push({ label: d.title, hash }); }
    } else if (route === "intake") {
      trail.push({ label: "Patients", hash: "#/patients" });
      const editId = (hash.split("?edit=")[1] || "").trim();
      if (editId) { patientCrumb(editId); trail.push({ label: "Edit info", hash }); }
      else trail.push({ label: "New intake", hash });
    } else if (route === "calendar") trail.push({ label: "Calendar", hash: "#/calendar" });
    else if (route === "privacy") trail.push({ label: "Privacy & Security", hash: "#/privacy" });
    else if (route === "facility") trail.push({ label: "Facility Admin", hash: "#/facility" });
    else if (route === "profile") trail.push({ label: "My Profile", hash: "#/profile" });
    return trail;
  }

  function renderShell(hash, content, user, bind) {
    const emrAllowed = S.canAccessEmr(user);
    const groups = [
      { label: "Clinic", items: NAV.filter((n) => ["#/dashboard", "#/patients", "#/calendar"].includes(n.hash)) },
      { label: "Account", items: NAV.filter((n) => ["#/privacy", "#/facility", "#/profile"].includes(n.hash)) },
    ];
    const linkHtml = (n) => {
      if (n.adminOnly && user.role !== "admin") return "";
      const disabled = n.emr && !emrAllowed;
      const active = hash.startsWith(n.hash) ||
        (n.hash === "#/patients" && /^#\/(patient\/|intake|doc\/)/.test(hash));
      return `<a class="nav-link ${active ? "active" : ""} ${disabled ? "disabled" : ""}" href="${n.hash}">
        <span class="nav-ico">${n.icon}</span><span class="nav-label">${n.label}</span><span class="nav-label-short">${n.short || n.label}</span></a>`;
    };
    const nav = groups.map((g) => {
      const items = g.items.map(linkHtml).filter(Boolean).join("");
      return items ? `<div class="nav-group"><div class="nav-group-label">${g.label}</div>${items}</div>` : "";
    }).join("");

    const crumbs = breadcrumbFor(hash, user);
    const canBack = crumbs.length > 1;
    const crumbBar = crumbs.length ? `
      <div class="crumbbar">
        ${canBack ? `<button class="crumb-back" id="crumbBack" title="Back">${ICON.back}<span>Back</span></button>` : ""}
        <nav class="crumbs">${crumbs.map((c, i) =>
          i === crumbs.length - 1
            ? `<span class="crumb current">${esc(c.label)}</span>`
            : `<a class="crumb" href="${c.hash}">${esc(c.label)}</a><span class="crumb-sep">›</span>`
        ).join("")}</nav>
      </div>` : "";

    app.innerHTML = `
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">${ICON.logo}</div>
      <div class="brand-text"><b>TheraChart</b><span>Clinic EMR</span></div>
    </div>
    <div class="nav">${nav}</div>
    <div class="spacer"></div>
    <div class="userchip">
      <div class="avatar">${esc(initials(user.name))}</div>
      <div class="who"><b>${esc(user.name)}</b><small>${esc(roleLabel(user))}</small></div>
      <button id="logoutBtn" class="signout" title="Sign out">${ICON.signout}</button>
    </div>
  </aside>
  <main class="content" id="view">${crumbBar}<div id="viewBody">${content}</div></main>
</div>`;
    document.getElementById("logoutBtn").addEventListener("click", () => { S.logout(); render(); });
    const back = document.getElementById("crumbBack");
    if (back) back.addEventListener("click", () => { location.hash = crumbs[crumbs.length - 2].hash; });
    if (bind) bind(user);
    restoreScroll(hash);
  }

  const roleLabel = (u) =>
    u.role === "therapist" ? "Physical Therapist" : u.role === "frontdesk" ? "Front Desk" : "Administrator";

  /* Per-document-type identity: a colour + short label used everywhere a
     document appears, so the four note types are easy to tell apart. */
  const DOC_META = {
    eval:      { label: "Evaluation",  short: "EVAL", cls: "doc-eval" },
    daily:     { label: "Daily Note",  short: "DAILY", cls: "doc-daily" },
    progress:  { label: "Progress",    short: "PROG", cls: "doc-progress" },
    discharge: { label: "Discharge",   short: "DC",   cls: "doc-discharge" },
  };
  const docMeta = (t) => DOC_META[t] || { label: t, short: "", cls: "doc-daily" };

  /* Severity of a body-map finding, from its notes: pain rating, intensity
     words, and symptom type. Drives the pin colour on the body chart. */
  function severityOf(pt) {
    const text = (pt.notes || []).map((n) => n.summary).join(" ").toLowerCase();
    if (/denies/.test(text)) return { level: 0, cls: "sev-none", label: "resolved / denied" };
    const rate = text.match(/(\d{1,2})\/10/);
    const score = rate ? Number(rate[1]) : null;
    if (score !== null) {
      if (score >= 7) return { level: 3, cls: "sev-high", label: "severe" };
      if (score >= 4) return { level: 2, cls: "sev-mid", label: "moderate" };
      return { level: 1, cls: "sev-low", label: "mild" };
    }
    if (/\bsignificant\b|severe|excruciating/.test(text)) return { level: 3, cls: "sev-high", label: "severe" };
    if (/\bmild\b|slight|minor/.test(text)) return { level: 1, cls: "sev-low", label: "mild" };
    if (/pain|sharp|shooting|burning|throbbing/.test(text)) return { level: 2, cls: "sev-mid", label: "moderate" };
    return { level: 1, cls: "sev-low", label: "reported" };
  }

  function blockedView(user) {
    return `
<div class="banner bad">⚠ ${S.licenseExpired(user)
      ? `Your license (${esc(user.license.number)}) expired on ${fmtDate(user.license.expires)}. EMR access and clinical documentation are disabled until it is renewed.`
      : "Your account cannot access the EMR."}
</div>
<div class="card"><div class="empty-state">
  You can still open <a href="#/profile">My Profile</a> and <a href="#/privacy">Privacy &amp; Security</a>.<br>
  Contact your facility administrator to restore access.
</div></div>`;
  }

  /* ================= LOGIN ================= */

  let loginSelected = null;

  function renderForcePassword(user) {
    app.innerHTML = `
<div class="login-wrap">
  <div class="login-box">
    <div class="brandline">
      <div class="logo">${LOGO_MARK}</div>
      <div><h1>TheraChart EMR</h1><div class="sub">${esc(S.settings().facilityName)}</div></div>
    </div>
    <div class="card">
      <h2>Set your password</h2>
      <p style="font-size:13px; color:var(--muted)">Welcome, ${esc(user.name)}. Your account uses a temporary password — choose your own to continue.</p>
      <div class="field"><label>Current (temporary) password</label><input id="fpCur" type="password" autocomplete="current-password" /></div>
      <div class="field"><label>New password (at least 8 characters)</label><input id="fpNew" type="password" autocomplete="new-password" /></div>
      <div class="field"><label>Confirm new password</label><input id="fpConf" type="password" autocomplete="new-password" /></div>
      <button class="btn primary" id="fpSave" style="width:100%; justify-content:center">Set password &amp; continue</button>
      <div class="error" id="fpErr" style="color:var(--danger); font-size:13px; min-height:18px; margin-top:8px"></div>
      <button class="btn small" id="fpLogout" style="margin-top:10px">Sign out</button>
    </div>
  </div>
</div>`;
    const err = document.getElementById("fpErr");
    document.getElementById("fpLogout").addEventListener("click", async () => { await Promise.resolve(S.logout()); render(); });
    document.getElementById("fpSave").addEventListener("click", async () => {
      const cur = document.getElementById("fpCur").value;
      const nw = document.getElementById("fpNew").value;
      const cf = document.getElementById("fpConf").value;
      if (nw.length < 8) { err.textContent = "New password must be at least 8 characters."; return; }
      if (nw !== cf) { err.textContent = "New passwords don't match."; return; }
      err.style.color = "var(--muted)"; err.textContent = "Saving…";
      const fail = await window.TheraSync.changePassword({ currentPassword: cur, newPassword: nw });
      if (fail) { err.style.color = "var(--danger)"; err.textContent = fail; return; }
      render(); // mustChangePassword is now cleared server-side + re-pulled
    });
  }

  function renderLogin() {
    const users = S.users();
    app.innerHTML = `
<div class="login-wrap">
  <div class="login-box">
    <div class="brandline">
      <div class="logo">${LOGO_MARK}</div>
      <div>
        <h1>TheraChart EMR</h1>
        <div class="sub">${esc(S.settings().facilityName)}</div>
      </div>
    </div>
    <div class="card">
      <h2>Sign in</h2>
      ${users.map((u) => `
        <button class="login-user ${loginSelected === u.id ? "selected" : ""}" data-id="${u.id}">
          <span class="avatar">${esc(initials(u.name))}</span>
          <span><b>${esc(u.name)}</b><small>${esc(roleLabel(u))}${u.license ? ` · ${esc(u.license.number)}` : ""}</small></span>
          ${loginChip(u)}
        </button>`).join("")}
      <div class="field" style="margin-top:12px">
        <label for="pinInput">Password</label>
        <input id="pinInput" type="password" autocomplete="current-password" placeholder="Enter your password" />
      </div>
      <button class="btn primary" id="loginBtn" style="width:100%; justify-content:center">Sign in</button>
      <div class="error" id="loginErr" style="color:var(--danger); font-size:13px; min-height:18px; margin-top:8px"></div>
      <div class="demo-note">Default password is <b>1234</b> — change it under <b>My Profile</b> after signing in.</div>
    </div>
  </div>
</div>`;
    app.querySelectorAll(".login-user").forEach((b) =>
      b.addEventListener("click", () => {
        loginSelected = b.dataset.id;
        renderLogin();
        document.getElementById("pinInput").focus();
      })
    );
    const doLogin = async () => {
      const err = document.getElementById("loginErr");
      if (!loginSelected) { err.textContent = "Choose your account first."; return; }
      err.textContent = "…";
      // S.login may be wrapped by the sync layer and return a promise
      const fail = await Promise.resolve(S.login(loginSelected, document.getElementById("pinInput").value));
      if (fail) { err.textContent = fail; return; }
      location.hash = "#/dashboard";
      render();
    };
    document.getElementById("loginBtn").addEventListener("click", doLogin);
    document.getElementById("pinInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });
  }

  function loginChip(u) {
    if (!u.active) return `<span class="chip bad">access voided</span>`;
    if (S.licenseExpired(u)) return `<span class="chip bad">license expired</span>`;
    if (S.licenseExpiresSoon(u)) return `<span class="chip warn">license expiring</span>`;
    return "";
  }

  /* ================= DASHBOARD ================= */

  function dashboardView(user) {
    const patients = S.patients();
    const due = patients.filter((p) => S.progressDue(p.id));
    const drafts = S.load().documents.filter((d) => d.status === "draft");
    const todays = S.apptsOn(todayIso()).sort((a, b) => (a.start < b.start ? -1 : 1));
    const expSoon = S.users().filter((u) => u.active && S.licenseExpiresSoon(u));

    return `
<div class="page-head">
  <div><h1>Good day, ${esc(user.name.split(",")[0].split(" ")[0])}</h1>
  <div class="sub">${fmtDate(new Date().toISOString())} · ${esc(S.settings().facilityName)}</div></div>
  <div class="page-actions">
    ${S.canDocument(user) || user.role === "frontdesk" ? `<a class="btn primary" href="#/intake">+ New patient intake</a>` : ""}
  </div>
</div>

${expSoon.map((u) => `<div class="banner warn">△ ${esc(u.name)} — license ${esc(u.license.number)} expires ${fmtDate(u.license.expires)}. Renew to avoid losing documentation access.</div>`).join("")}
${due.map((p) => `<div class="banner info">◈ <b>${esc(S.patientName(p))}</b> has completed ${S.visitCount(p.id)} visits — a <b>progress report is due</b>. <a href="#/patient/${p.id}">Open chart</a></div>`).join("")}

<div class="cards-2">
  <div>
    <div class="card">
      <h2>Today's schedule</h2>
      ${todays.length ? `<table class="list"><thead><tr><th>Time</th><th>Patient</th><th>Therapist</th></tr></thead><tbody>
        ${todays.map((a) => `<tr class="rowlink" data-href="#/patient/${a.patientId}">
          <td class="num">${fmtTime(a.start)}</td>
          <td>${esc(S.patientName(S.getPatient(a.patientId)))}</td>
          <td>${esc((S.getUser(a.therapistId) || {}).name || "—")}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty-state">No visits scheduled today. <a href="#/calendar">Open the calendar</a> to book one.</div>`}
    </div>
    <div class="card">
      <h2>Unsigned drafts</h2>
      ${drafts.length ? `<table class="list"><tbody>${drafts.map((d) => `
        <tr class="rowlink" data-href="#/doc/${d.id}">
          <td><span class="doc-tag ${docMeta(d.type).cls}">${docMeta(d.type).short}</span>${esc(d.title)}<br><small style="color:var(--muted)">${esc(S.patientName(S.getPatient(d.patientId)))}</small></td>
          <td><span class="chip warn">draft</span></td>
          <td class="num">${fmtDate(d.createdAt)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty-state">Everything is signed. ✓</div>`}
    </div>
  </div>
  <div>
    <div class="card">
      <h2>How TheraChart works</h2>
      <ol style="margin:0; padding-left:20px; font-size:13.5px; line-height:1.9">
        <li><b>Front desk</b> registers the patient in <a href="#/intake">Intake</a> and books visits in the <a href="#/calendar">Calendar</a>.</li>
        <li><b>Therapists</b> open the patient chart and start a note — press <b>🎤 Listen</b> and just talk. TheraChart pins what the patient says to a body map, files measurements (ROM, strength, pain) into the right sections, and keeps the full transcript. It understands <b>English, Tagalog, and Cebuano</b>.</li>
        <li>When done, <b>e-sign</b> — the note locks. Any later change needs a signed, authorized amendment.</li>
      </ol>
    </div>
    <div class="card">
      <h2>Facility at a glance</h2>
      <table class="list"><tbody>
        <tr><td>Patients on file</td><td class="num">${patients.length}</td></tr>
        <tr><td>Documents</td><td class="num">${S.load().documents.length}</td></tr>
        <tr><td>Progress report cadence</td><td class="num">every ${S.settings().progressEvery} visits</td></tr>
        <tr><td>Booked visits (upcoming)</td><td class="num">${S.appointments().filter((a) => a.status === "booked" && a.start >= new Date().toISOString()).length}</td></tr>
      </tbody></table>
    </div>
  </div>
</div>`;
  }

  function bindDashboard() { bindRowLinks(); }

  function bindRowLinks() {
    document.querySelectorAll("tr.rowlink").forEach((tr) =>
      tr.addEventListener("click", () => { location.hash = tr.dataset.href; })
    );
  }

  /* ================= PATIENTS LIST ================= */

  function patientsView(user) {
    return `
<div class="page-head">
  <div><h1>Patients</h1><div class="sub">Select a patient to open their chart</div></div>
  <div class="page-actions"><a class="btn primary" href="#/intake">+ New patient intake</a></div>
</div>
<div class="card">
  <div class="field"><input id="patSearch" type="search" placeholder="Search by name, phone, or physician…" /></div>
  <div class="table-scroll"><table class="list" id="patTable">
    <thead><tr><th>Name</th><th>DOB</th><th>Phone</th><th>Referring physician</th><th>Visits</th><th></th></tr></thead>
    <tbody></tbody>
  </table></div>
</div>`;
  }

  function bindPatients() {
    const tbody = document.querySelector("#patTable tbody");
    const draw = (q) => {
      const ql = (q || "").toLowerCase();
      const rows = S.patients()
        .filter((p) => !ql || [p.firstName, p.lastName, p.phone, p.referringPhysician].join(" ").toLowerCase().includes(ql))
        .sort((a, b) => (a.lastName < b.lastName ? -1 : 1))
        .map((p) => `<tr class="rowlink" data-href="#/patient/${p.id}">
          <td><b>${esc(S.patientName(p))}</b></td>
          <td class="num">${esc(p.dob)} (${age(p.dob)})</td>
          <td class="num">${esc(p.phone)}</td>
          <td>${esc(p.referringPhysician || "—")}</td>
          <td class="num">${S.visitCount(p.id)}${S.progressDue(p.id) ? ' <span class="chip info">progress due</span>' : ""}</td>
          <td><span class="chip muted">open →</span></td></tr>`).join("");
      tbody.innerHTML = rows || `<tr><td colspan="6"><div class="empty-state">No patients found.</div></td></tr>`;
      bindRowLinks();
    };
    draw("");
    document.getElementById("patSearch").addEventListener("input", (e) => draw(e.target.value));
  }

  /* ================= INTAKE ================= */

  function intakeView(user) {
    const editId = (location.hash.split("?edit=")[1] || "").trim();
    const p = editId ? S.getPatient(editId) : null;
    const v = (k) => esc(p ? p[k] || "" : "");
    const ins = (k) => esc(p && p.insurance ? p.insurance[k] || "" : "");
    return `
<div class="page-head">
  <div><h1>${p ? "Edit patient information" : "New patient intake"}</h1>
  <div class="sub">Completed by front desk staff — all fields stay on this device</div></div>
</div>
<div class="card" style="max-width:760px">
  <h2>Personal information</h2>
  <div class="field-row">
    <div class="field"><label>First name *</label><input id="in-first" value="${v("firstName")}" /></div>
    <div class="field"><label>Last name *</label><input id="in-last" value="${v("lastName")}" /></div>
  </div>
  <div class="field-row">
    <div class="field"><label>Date of birth *</label><input id="in-dob" type="date" value="${v("dob")}" /></div>
    <div class="field"><label>Sex</label><select id="in-sex">
      <option value="">—</option><option ${p && p.sex === "F" ? "selected" : ""}>F</option><option ${p && p.sex === "M" ? "selected" : ""}>M</option>
    </select></div>
  </div>
  <div class="field"><label>Address</label><input id="in-address" value="${v("address")}" /></div>
  <div class="field-row">
    <div class="field"><label>Phone number *</label><input id="in-phone" value="${v("phone")}" placeholder="+63 …" /></div>
    <div class="field"><label>Email</label><input id="in-email" type="email" value="${v("email")}" /></div>
  </div>
  <div class="field"><label>Referring physician</label><input id="in-ref" value="${v("referringPhysician")}" placeholder="Name and specialty" /></div>
  <h2 style="margin-top:16px">Insurance / payment</h2>
  <div class="field-row">
    <div class="field"><label>Provider</label><input id="in-prov" value="${ins("provider")}" placeholder="PhilHealth, HMO, self-pay…" /></div>
    <div class="field"><label>Member / policy ID</label><input id="in-member" value="${ins("memberId")}" /></div>
  </div>
  <div class="field"><label>Payment notes</label><input id="in-paynotes" value="${ins("notes")}" placeholder="Co-pay, approvals, etc." /></div>
  <div style="display:flex; gap:8px; margin-top:6px">
    <button class="btn primary" id="intakeSave">${p ? "Save changes" : "Register patient"}</button>
    <a class="btn" href="${p ? `#/patient/${p.id}` : "#/patients"}">Cancel</a>
  </div>
  <div class="error" id="intakeErr" style="color:var(--danger); font-size:13px; min-height:16px; margin-top:8px"></div>
</div>`;
  }

  function bindIntake(user) {
    document.getElementById("intakeSave").addEventListener("click", () => {
      const g = (id) => document.getElementById(id).value.trim();
      const fields = {
        firstName: g("in-first"), lastName: g("in-last"), dob: g("in-dob"),
        sex: g("in-sex"), address: g("in-address"), phone: g("in-phone"),
        email: g("in-email"), referringPhysician: g("in-ref"),
        insurance: { provider: g("in-prov"), memberId: g("in-member"), notes: g("in-paynotes") },
      };
      if (!fields.firstName || !fields.lastName || !fields.dob || !fields.phone) {
        document.getElementById("intakeErr").textContent = "First name, last name, date of birth, and phone are required.";
        return;
      }
      const editId = (location.hash.split("?edit=")[1] || "").trim();
      const p = editId ? S.updatePatient(editId, fields, user.id) : S.addPatient(fields, user.id);
      location.hash = `#/patient/${p.id}`;
    });
  }

  /* ================= PATIENT CENTER ================= */

  const currentPatientId = () => (location.hash.split("/")[2] || "").split("?")[0];

  function patientView(user) {
    const p = S.getPatient(currentPatientId());
    if (!p) return `<div class="card"><div class="empty-state">Patient not found.</div></div>`;
    const docs = S.docsFor(p.id);
    const canDoc = S.canDocument(user);
    const due = S.progressDue(p.id);

    const docRow = (d) => `
      <tr class="rowlink" data-href="#/doc/${d.id}">
        <td><span class="doc-tag ${docMeta(d.type).cls}">${docMeta(d.type).short}</span><b>${esc(d.title)}</b></td>
        <td>${d.status === "signed" ? '<span class="chip good">signed & locked</span>' : '<span class="chip warn">draft</span>'}${d.imported ? ' <span class="chip muted">imported</span>' : ""}${d.amendments.length ? ` <span class="chip info">${d.amendments.length} amendment${d.amendments.length > 1 ? "s" : ""}</span>` : ""}</td>
        <td>${esc((S.getUser(d.createdBy) || {}).name || "—")}</td>
        <td class="num">${fmtDate(d.createdAt)}</td>
      </tr>`;

    return `
<div class="page-head">
  <div>
    <h1>${esc(S.patientName(p))}</h1>
    <div class="sub">${esc(p.dob)} (age ${age(p.dob)}) · ${esc(p.phone)} · Referred by ${esc(p.referringPhysician || "—")}</div>
  </div>
  <div class="page-actions">
    <button class="btn" id="printChartBtn">Print / export chart (PDF)</button>
    <a class="btn" href="#/intake?edit=${p.id}">Edit info</a>
  </div>
</div>

${due ? `<div class="banner info">◈ ${S.visitCount(p.id)} visits completed — a <b>progress report is due</b> (facility setting: every ${S.settings().progressEvery} visits).</div>` : ""}

<div class="cards-2">
  <div>
    <div class="card">
      <h2>Therapy documents</h2>
      ${canDoc ? `<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
        <button class="btn small newdoc-btn doc-eval" data-newdoc="eval"><i class="dt-swatch"></i>+ Evaluation</button>
        <button class="btn small newdoc-btn doc-daily" data-newdoc="daily"><i class="dt-swatch"></i>+ Daily note</button>
        <button class="btn small newdoc-btn doc-progress ${due ? "primary" : ""}" data-newdoc="progress"><i class="dt-swatch"></i>+ Progress report${due ? " (due)" : ""}</button>
        <button class="btn small newdoc-btn doc-discharge" data-newdoc="discharge"><i class="dt-swatch"></i>+ Discharge</button>
      </div>` : `<div class="banner warn" style="margin-bottom:12px">Your account can view this chart but cannot create or edit clinical documents.</div>`}
      ${docs.length ? `<div class="table-scroll"><table class="list"><thead><tr><th>Document</th><th>Status</th><th>Therapist</th><th>Date</th></tr></thead>
        <tbody>${docs.slice().reverse().map(docRow).join("")}</tbody></table></div>`
        : `<div class="empty-state">No documents yet.${canDoc ? " Start with an <b>Evaluation</b>." : ""}</div>`}
    </div>
    <div class="card">
      <h2>Referrals, imaging & other files</h2>
      ${p.attachments.length ? `<table class="list"><tbody>${p.attachments.map((a) => `
        <tr><td><b>${esc(a.name)}</b>${a.size ? ` <small style="color:var(--muted)">(${fmtBytes(a.size)})</small>` : ""}<br><small style="color:var(--muted)">added ${fmtDT(a.uploadedAt)} by ${esc((S.getUser(a.uploadedBy) || {}).name || "—")}</small></td>
        <td style="text-align:right"><button class="btn small" data-dl-att="${esc(a.id)}">Download</button></td></tr>`).join("")}</tbody></table>`
        : `<div class="empty-state">No files yet — add the physician referral, X-rays, or other documents.</div>`}
      <div style="margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <label class="btn small" style="position:relative; overflow:hidden">
          Upload file<input id="fileUpload" type="file" style="position:absolute; inset:0; opacity:0; cursor:pointer" />
        </label>
        ${canDoc ? `<label class="btn small" style="position:relative; overflow:hidden" title="AI reads a scanned document and turns each visit into a chart entry — you review everything before it's saved">
          ⇪ Import visit history (PDF)<input id="pdfImport" type="file" accept="application/pdf,image/*" style="position:absolute; inset:0; opacity:0; cursor:pointer" />
        </label>` : ""}
        <small style="color:var(--muted)">Referrals, imaging & scans · up to 20 MB per file</small>
      </div>
    </div>
  </div>
  <div>
    <div class="card">
      <h2>Personal information</h2>
      <table class="list"><tbody>
        <tr><td style="color:var(--muted)">Address</td><td>${esc(p.address || "—")}</td></tr>
        <tr><td style="color:var(--muted)">Phone</td><td class="num">${esc(p.phone)}</td></tr>
        <tr><td style="color:var(--muted)">Email</td><td>${esc(p.email || "—")}</td></tr>
        <tr><td style="color:var(--muted)">Referring physician</td><td>${esc(p.referringPhysician || "—")}</td></tr>
        <tr><td style="color:var(--muted)">Registered</td><td>${fmtDT(p.createdAt)} by ${esc((S.getUser(p.createdBy) || {}).name || "—")}</td></tr>
      </tbody></table>
    </div>
    <div class="card">
      <h2>Insurance / payment</h2>
      <table class="list"><tbody>
        <tr><td style="color:var(--muted)">Provider</td><td>${esc((p.insurance || {}).provider || "—")}</td></tr>
        <tr><td style="color:var(--muted)">Member ID</td><td class="num">${esc((p.insurance || {}).memberId || "—")}</td></tr>
        <tr><td style="color:var(--muted)">Notes</td><td>${esc((p.insurance || {}).notes || "—")}</td></tr>
      </tbody></table>
    </div>
    <div class="card">
      <h2>Visit history</h2>
      <table class="list"><tbody>
        <tr><td>Daily visits documented</td><td class="num">${S.visitCount(p.id)}</td></tr>
        <tr><td>Upcoming bookings</td><td class="num">${S.appointments().filter((a) => a.patientId === p.id && a.status === "booked" && a.start >= new Date().toISOString()).length}</td></tr>
      </tbody></table>
    </div>
  </div>
</div>`;
  }

  function bindPatient(user) {
    bindRowLinks();
    const p = S.getPatient(currentPatientId());
    if (!p) return;

    document.querySelectorAll("[data-newdoc]").forEach((b) =>
      b.addEventListener("click", () => {
        const res = S.createDoc(p.id, b.dataset.newdoc, user);
        if (res.error) return alertBanner(res.error);
        location.hash = `#/doc/${res.doc.id}`;
      })
    );

    const up = document.getElementById("fileUpload");
    if (up) up.addEventListener("change", async () => {
      const f = up.files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) return alertBanner("File is too large (limit 20 MB).");
      try {
        // bytes go to storage (GCS/local); only a small reference is kept on the patient
        const ref = await window.TheraSync.uploadFile(f);
        p.attachments.push({
          id: S.uid("a"), name: f.name, type: f.type, size: f.size,
          ...ref, uploadedBy: user.id, uploadedAt: new Date().toISOString(),
        });
        S.save();
        S.audit(user.id, "attachment-added", `${f.name} → ${S.patientName(p)}`);
        render();
      } catch (e) { alertBanner(e.message || "Upload failed."); }
    });
    document.querySelectorAll("[data-dl-att]").forEach((b) =>
      b.addEventListener("click", async () => {
        const att = (p.attachments || []).find((a) => a.id === b.dataset.dlAtt);
        if (!att) return;
        try { await window.TheraSync.downloadFile(att); }
        catch (e) { alertBanner(e.message || "Download failed."); }
      })
    );

    const imp = document.getElementById("pdfImport");
    if (imp) imp.addEventListener("change", () => {
      const f = imp.files[0];
      if (f) importPdfFlow(p, user, f);
      imp.value = "";
    });

    const pr = document.getElementById("printChartBtn");
    if (pr) pr.addEventListener("click", () => printPatientChart(p));
  }

  function alertBanner(msg) {
    const m = showModal(`<h2>Notice</h2><p style="font-size:14px">${esc(msg)}</p>
      <div class="modal-actions"><button class="btn primary" id="okBtn">OK</button></div>`);
    m.querySelector("#okBtn").addEventListener("click", closeModal);
  }

  /* ========== Import visit history from a scanned document (PDF) ==========
     Gemini reads the scan into one structured entry per visit; the user
     reviews and edits everything before any document is created. Imported
     documents are dated with their original visit date and locked, with the
     importing clinician's attestation. */

  async function importPdfFlow(p, user, f) {
    const sync = window.TheraSync || {};
    if (!sync.ai) {
      return alertBanner("Reading scanned documents needs the Gemini AI backend — set GEMINI_API_KEY where the app is hosted. There is no offline reader for scans.");
    }
    // Vercel serverless caps request bodies at ~4.5 MB; the clinic server allows 8 MB
    const maxMb = sync.mode === "server" ? 8 : 3;
    if (f.size > maxMb * 1024 * 1024) {
      return alertBanner(`This file is ${(f.size / 1024 / 1024).toFixed(1)} MB — the limit here is ${maxMb} MB. Split the scan into smaller PDFs and import them one at a time.`);
    }
    let b64;
    try {
      b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] || "");
        r.onerror = () => reject(new Error("couldn't read the file"));
        r.readAsDataURL(f);
      });
    } catch (e) { return alertBanner("Couldn't read the file: " + e.message); }

    showModal(`<h2>⇪ Reading ${esc(f.name)}…</h2>
      <p style="font-size:13px">Gemini is reading the document and pulling out each visit — dates, note types, findings, and measurements. You'll review everything before anything is saved to the chart.</p>
      <div class="empty-state">Working…</div>`);
    let result;
    try {
      result = await sync.extractRecords(b64, f.type || "application/pdf");
    } catch (e) {
      closeModal();
      const hint = /timeout|abort/i.test(e.message) ? " Long or unclear scans can take too long — try again, or split the PDF into fewer pages." : "";
      return alertBanner("Couldn't read the document: " + e.message + hint);
    }
    closeModal();
    if (!result.visits || !result.visits.length) {
      return alertBanner(`No visit records were found in this document${result.docDescription ? ` — it looks like: ${result.docDescription}` : ""}. Nothing was saved.`);
    }
    openImportReviewModal(p, user, f, b64, result);
  }

  function openImportReviewModal(p, user, f, b64, result) {
    const existing = S.docsFor(p.id);
    const isDupe = (v) => !!v.date && existing.some((d) => d.type === v.type && d.createdAt.slice(0, 10) === v.date);
    const visits = result.visits.map((v) => {
      const dupe = isDupe(v);
      return { ...v, _inc: !dupe, _dupe: dupe,
        findings: (v.findings || []).map((x) => ({ ...x, _inc: true })),
        rom: (v.rom || []).map((x) => ({ ...x, _inc: true })),
        mmt: (v.mmt || []).map((x) => ({ ...x, _inc: true })),
        pain: (v.pain || []).map((x) => ({ ...x, _inc: true })),
        special: (v.special || []).map((x) => ({ ...x, _inc: true })),
      };
    });

    const nameOnDoc = (result.patientName || "").toLowerCase();
    const mismatch = nameOnDoc &&
      !nameOnDoc.includes((p.lastName || "").toLowerCase()) &&
      !nameOnDoc.includes((p.firstName || "").toLowerCase());

    const measRow = (i, kind, j, label, valueHtml) => `
      <div class="imp-row">
        <input type="checkbox" data-minc="${i}:${kind}:${j}" checked />
        <span style="color:var(--muted); min-width:0">${esc(label)}</span>${valueHtml}
      </div>`;

    const visitCard = (v, i) => `
      <div class="rev-finding" style="align-items:flex-start">
        <label class="rev-inc"><input type="checkbox" data-vinc="${i}" ${v._inc ? "checked" : ""}/></label>
        <div class="rev-fbody" style="min-width:0; flex:1">
          <div class="rev-fhead imp-head" style="flex-wrap:wrap">
            <input type="date" data-vdate="${i}" value="${esc(v.date)}" style="width:150px"/>
            <select data-vtype="${i}">
              ${["eval", "daily", "progress", "discharge"].map((t) => `<option value="${t}" ${v.type === t ? "selected" : ""}>${docMeta(t).label}</option>`).join("")}
            </select>
            ${v.therapist ? `<span class="chip muted">PT: ${esc(v.therapist)}</span>` : ""}
            ${v._dupe ? `<span class="chip warn">possible duplicate — unchecked</span>` : ""}
            ${!v.date ? `<span class="chip warn">no date read — set one</span>` : ""}
          </div>
          ${[["subjective", "Subjective"], ["objective", "Objective"], ["assessment", "Assessment"], ["treatment", "Treatment / plan"]].map(([k, label]) => `
            <label class="imp-label">${label}</label>
            <textarea data-vfield="${i}:${k}" rows="2" class="imp-text">${esc(v[k] || "")}</textarea>`).join("")}
          ${v.findings.length ? `<label class="imp-label">Body-map findings</label>
            ${v.findings.map((x, j) => `<div class="imp-row">
              <input type="checkbox" data-finc="${i}:${j}" checked />
              <b style="white-space:nowrap">${esc(x.side ? cap(x.side) + " " : "")}${esc(x.part)}</b>
              <input data-fsum="${i}:${j}" value="${esc(x.summary)}" style="flex:1"/>
            </div>`).join("")}` : ""}
          ${(v.rom.length + v.mmt.length + v.pain.length + v.special.length) ? `<label class="imp-label">Measurements</label>
            ${v.rom.map((r, j) => measRow(i, "rom", j, `ROM ${r.side || ""} ${r.joint} ${r.motion}`,
              `<input type="number" data-mval="${i}:rom:${j}" value="${r.degrees}" style="width:74px"/><span>°</span>`)).join("")}
            ${v.mmt.map((r, j) => measRow(i, "mmt", j, `MMT ${r.context || ""}`,
              `<input data-mval="${i}:mmt:${j}" value="${esc(r.grade)}" style="width:64px"/>`)).join("")}
            ${v.pain.map((r, j) => measRow(i, "pain", j, `Pain ${r.location || ""}`,
              `<input type="number" min="0" max="10" data-mval="${i}:pain:${j}" value="${r.score}" style="width:60px"/><span>/10</span>`)).join("")}
            ${v.special.map((r, j) => measRow(i, "special", j, r.name,
              `<select data-mval="${i}:special:${j}"><option ${r.result === "positive" ? "selected" : ""}>positive</option><option ${r.result === "negative" ? "selected" : ""}>negative</option></select>`)).join("")}` : ""}
        </div>
      </div>`;

    const m = showModal(`
<h2>⇪ Review imported visits <span class="chip info">Gemini</span></h2>
<p style="font-size:12.5px; color:var(--muted); margin-top:-4px">
  Read from <b>${esc(f.name)}</b>${result.docDescription ? ` — ${esc(result.docDescription)}` : ""}.
  Check the dates and values against the scan; edit anything. Only checked visits are saved — each becomes a locked
  historical document dated to the original visit.</p>
${mismatch ? `<div class="banner warn">△ The document reads as belonging to <b>${esc(result.patientName)}</b>, but this chart is <b>${esc(S.patientName(p))}</b>. Make sure you're importing into the right patient.</div>` : ""}
<div style="max-height:56vh; overflow:auto">${visits.map(visitCard).join("")}</div>
<div class="modal-actions">
  <button class="btn" id="impCancel">Cancel</button>
  <button class="btn primary" id="impApply">Add ${visits.length} visit${visits.length === 1 ? "" : "s"} to chart</button>
</div>`);
    m.classList.add("wide");

    // live edits back into the working copies
    m.querySelectorAll("[data-vinc]").forEach((c) => c.addEventListener("change", () => { visits[+c.dataset.vinc]._inc = c.checked; updateApplyLabel(); }));
    m.querySelectorAll("[data-vdate]").forEach((el) => el.addEventListener("input", () => { visits[+el.dataset.vdate].date = el.value; }));
    m.querySelectorAll("[data-vtype]").forEach((el) => el.addEventListener("change", () => { visits[+el.dataset.vtype].type = el.value; }));
    m.querySelectorAll("[data-vfield]").forEach((el) => el.addEventListener("input", () => {
      const [i, k] = el.dataset.vfield.split(":");
      visits[+i][k] = el.value;
    }));
    m.querySelectorAll("[data-finc]").forEach((c) => c.addEventListener("change", () => {
      const [i, j] = c.dataset.finc.split(":");
      visits[+i].findings[+j]._inc = c.checked;
    }));
    m.querySelectorAll("[data-fsum]").forEach((el) => el.addEventListener("input", () => {
      const [i, j] = el.dataset.fsum.split(":");
      visits[+i].findings[+j].summary = el.value;
    }));
    m.querySelectorAll("[data-minc]").forEach((c) => c.addEventListener("change", () => {
      const [i, kind, j] = c.dataset.minc.split(":");
      visits[+i][kind][+j]._inc = c.checked;
    }));
    m.querySelectorAll("[data-mval]").forEach((el) => el.addEventListener("input", () => {
      const [i, kind, j] = el.dataset.mval.split(":");
      const row = visits[+i][kind][+j];
      if (kind === "rom") row.degrees = Number(el.value) || 0;
      else if (kind === "pain") row.score = Math.max(0, Math.min(10, Number(el.value) || 0));
      else if (kind === "mmt") row.grade = el.value;
      else if (kind === "special") row.result = el.value;
    }));

    const applyBtn = m.querySelector("#impApply");
    const updateApplyLabel = () => {
      const n = visits.filter((v) => v._inc).length;
      applyBtn.textContent = `Add ${n} visit${n === 1 ? "" : "s"} to chart`;
      applyBtn.disabled = !n;
    };
    updateApplyLabel();

    m.querySelector("#impCancel").addEventListener("click", closeModal);
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      await applyImport(p, user, f, b64, visits);
      closeModal();
    });
  }

  function importDocData(v) {
    const kept = (arr) => arr.filter((x) => x._inc !== false);
    const mapPoints = kept(v.findings)
      .filter((x) => (x.summary || "").trim())
      .map((x) => ({ key: x.key, part: x.part, side: x.side, view: x.view, x: x.x, y: x.y,
        notes: [{ time: "", summary: x.summary.trim(), quote: "", uttId: null, marks: [] }] }));
    const data = {
      mapPoints, transcript: [],
      rom: kept(v.rom).map(({ side, joint, motion, degrees }) => ({ side, joint, motion, degrees })),
      mmt: kept(v.mmt).map(({ context, grade }) => ({ context, grade })),
      pain: kept(v.pain).map(({ location, score }) => ({ location, score })),
      special: kept(v.special).map(({ name, result }) => ({ name, result })),
    };
    const s = (t) => (t || "").trim();
    if (v.type === "eval") {
      data.subjective = s(v.subjective); data.objectiveText = s(v.objective);
      data.assessment = s(v.assessment); data.plan = s(v.treatment);
    } else if (v.type === "progress") {
      data.currentStatus = s(v.subjective); data.updatedFindings = s(v.objective);
      data.assessment = s(v.assessment); data.goalsProgress = s(v.treatment);
    } else if (v.type === "discharge") {
      data.summary = [s(v.subjective), s(v.objective)].filter(Boolean).join("\n");
      data.outcome = s(v.assessment); data.recommendations = s(v.treatment);
    } else { // daily
      data.subjective = s(v.subjective);
      data.summary = [s(v.treatment), s(v.objective), s(v.assessment)].filter(Boolean).join("\n");
    }
    return data;
  }

  async function applyImport(p, user, f, b64, visits) {
    let n = 0;
    for (const v of visits) {
      if (!v._inc) continue;
      const res = S.addImportedDoc(p.id, { type: v.type, date: v.date, data: importDocData(v) }, user, f.name);
      if (!res.error) n++;
    }
    // keep the source scan on the chart — bytes go to storage, not the blob
    if (n && f.size <= 20 * 1024 * 1024 && !p.attachments.some((a) => a.name === f.name)) {
      try {
        const ref = await window.TheraSync.storeBytes(f.name, f.type || "application/pdf", b64, f.size);
        p.attachments.push({
          id: S.uid("a"), name: f.name, type: f.type || "application/pdf", size: f.size,
          ...ref, uploadedBy: user.id, uploadedAt: new Date().toISOString(),
        });
        S.save();
      } catch (_) { /* extraction still succeeded; skip keeping the scan */ }
    }
    S.audit(user.id, "pdf-import-applied", `${f.name}: ${n} visit${n === 1 ? "" : "s"} → ${S.patientName(p)}`);
    render();
  }

  /* ---------- patient chart printing / PDF export ---------- */

  function measurementTables(d) {
    const rom = (d.rom || []).length ? `<h3>Range of motion</h3><table><tr><th>Side</th><th>Joint</th><th>Motion</th><th>Degrees</th></tr>
      ${d.rom.map((r) => `<tr><td>${esc(r.side || "—")}</td><td>${esc(r.joint)}</td><td>${esc(r.motion)}</td><td>${r.degrees}°</td></tr>`).join("")}</table>` : "";
    const mmt = (d.mmt || []).length ? `<h3>Manual muscle testing</h3><table><tr><th>Muscle / context</th><th>Grade</th></tr>
      ${d.mmt.map((r) => `<tr><td>${esc(r.context || "—")}</td><td>${esc(r.grade)}</td></tr>`).join("")}</table>` : "";
    const sp = (d.special || []).length ? `<h3>Special tests</h3><table><tr><th>Test</th><th>Result</th></tr>
      ${d.special.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.result)}</td></tr>`).join("")}</table>` : "";
    const pain = (d.pain || []).length ? `<h3>Pain</h3><table><tr><th>Location</th><th>Rating</th></tr>
      ${d.pain.map((r) => `<tr><td>${esc(r.location || "—")}</td><td>${r.score}/10</td></tr>`).join("")}</table>` : "";
    return rom + mmt + sp + pain;
  }

  function docPrintHtml(doc) {
    const d = doc.data;
    const secs = [];
    const put = (label, val) => { if (val && String(val).trim()) secs.push(`<h3>${label}</h3><p>${esc(val)}</p>`); };
    if (doc.type === "eval") {
      put("Reason for referral", d.reason); put("Precautions", d.precautions);
      put("Past medical history", d.pmh); put("Subjective", d.subjective);
      put("Objective findings", d.objectiveText);
      secs.push(measurementTables(d));
      put("Assessment", d.assessment); put("Plan", d.plan);
    } else if (doc.type === "daily") {
      put("Subjective", d.subjective); put("Treatment summary", d.summary);
      secs.push(measurementTables(d));
    } else if (doc.type === "progress") {
      put("Baseline subjective (from evaluation)", d.baselineSubjective);
      put("Current status", d.currentStatus); put("Updated findings", d.updatedFindings);
      secs.push(measurementTables(d));
      put("Progress toward goals", d.goalsProgress); put("Assessment", d.assessment);
    } else if (doc.type === "discharge") {
      put("Summary of care", d.summary); put("Outcome", d.outcome); put("Recommendations", d.recommendations);
    }
    const maps = (d.mapPoints || []).length
      ? `<h3>Body chart findings</h3><ul>${d.mapPoints.map((pt) => `<li><b>${esc(pt.side ? pt.side + " " : "")}${esc(pt.part)}</b> (${pt.view} view): ${pt.notes.map((n) => esc(n.summary)).join("; ")}</li>`).join("")}</ul>` : "";
    const sigs = doc.signatures.map((s) =>
      `<div class="sig-line">E-signed: ${esc(s.name)}${s.license ? ` (License ${esc(s.license)})` : ""} — ${fmtDT(s.time)} — ${esc(s.reason)}</div>`).join("");
    const amds = doc.amendments.map((a) =>
      `<div><b>Amendment</b> (${fmtDT(a.time)}, ${esc(a.name)} — reason: ${esc(a.reason)}): ${esc(a.text)}</div>`).join("");
    return `<h2>${esc(doc.title)} — ${fmtDate(doc.createdAt)} <span class="print-muted">(${doc.status})</span></h2>
      ${secs.join("")}${maps}${amds}${sigs}`;
  }

  function printPatientChart(p) {
    const docs = S.docsFor(p.id);
    const html = `
<h1>${esc(S.settings().facilityName)}</h1>
<div class="print-muted">Patient chart — printed ${fmtDT(new Date().toISOString())}</div>
<h2>Patient information</h2>
<table>
  <tr><th>Name</th><td>${esc(S.patientName(p))}</td><th>DOB</th><td>${esc(p.dob)} (age ${age(p.dob)})</td></tr>
  <tr><th>Phone</th><td>${esc(p.phone)}</td><th>Email</th><td>${esc(p.email || "—")}</td></tr>
  <tr><th>Address</th><td colspan="3">${esc(p.address || "—")}</td></tr>
  <tr><th>Referring physician</th><td>${esc(p.referringPhysician || "—")}</td>
      <th>Insurance</th><td>${esc((p.insurance || {}).provider || "—")} ${esc((p.insurance || {}).memberId || "")}</td></tr>
</table>
${p.attachments.length ? `<h2>Files on record</h2><ul>${p.attachments.map((a) => `<li>${esc(a.name)} (added ${fmtDate(a.uploadedAt)})</li>`).join("")}</ul>` : ""}
${docs.map((d, i) => `<div class="${i > 0 ? "doc-break" : ""}">${docPrintHtml(d)}</div>`).join("")}`;
    S.audit(S.currentUser().id, "chart-printed", S.patientName(p));
    printHTML(html);
  }

  /* ================= DOCUMENT EDITOR ================= */

  function bindDoc(user) {
    const docId = location.hash.split("/")[2];
    const doc = S.getDoc(docId);
    const view = document.getElementById("viewBody");
    if (!doc) { view.innerHTML = `<div class="card"><div class="empty-state">Document not found.</div></div>`; return; }
    const meta = docMeta(doc.type);
    const p = S.getPatient(doc.patientId);
    const locked = doc.status === "signed";
    const canDoc = S.canDocument(user);
    const editable = !locked && canDoc;

    const ta = (field, label, placeholder, rows) => `
      <div class="field"><label>${label}</label>
      <textarea data-field="${field}" rows="${rows || 3}" placeholder="${placeholder || ""}" ${editable ? "" : "disabled"}>${esc(doc.data[field] || "")}</textarea></div>`;

    let sections = "";
    if (doc.type === "eval") {
      sections = ta("reason", "Reason for referral", "Why was the patient referred?") +
        ta("precautions", "Precautions", "Contraindications, restrictions…") +
        ta("pmh", "Past medical history", "Relevant conditions, surgeries…") +
        ta("subjective", "Subjective", "What the patient reports — dictation files here automatically") +
        ta("objectiveText", "Objective findings (narrative)", "Observations; measured values go to the tables below") +
        measurementEditor(doc, editable) +
        ta("assessment", "Assessment", "Clinical impression") +
        ta("plan", "Plan", "Frequency, duration, interventions");
    } else if (doc.type === "daily") {
      sections = ta("subjective", "Subjective", "Patient-reported status today") +
        ta("summary", "Treatment summary", "Treatments performed this visit — dictation files treatment sentences here") +
        measurementEditor(doc, editable);
    } else if (doc.type === "progress") {
      sections = `<div class="field"><label>Baseline subjective — carried over from the evaluation</label>
          <textarea rows="2" disabled>${esc(doc.data.baselineSubjective || "(no signed evaluation found)")}</textarea></div>` +
        ta("currentStatus", "Current status", "How the patient presents now") +
        ta("updatedFindings", "Updated findings", "New objective findings — measured values go to the tables below") +
        measurementEditor(doc, editable) +
        ta("goalsProgress", "Progress toward goals", "") +
        ta("assessment", "Assessment", "");
    } else if (doc.type === "discharge") {
      sections = ta("summary", "Summary of care", "") + ta("outcome", "Outcome", "") +
        ta("recommendations", "Recommendations", "");
    }

    const sigBlock = `
      <div class="sig-block">
        ${doc.signatures.map((s) => `<div class="sig">✒ <b>${esc(s.name)}</b> ${s.license ? `· License ${esc(s.license)}` : ""} · ${fmtDT(s.time)} <span style="color:var(--muted)">— ${esc(s.reason)}</span></div>`).join("")}
        ${doc.amendments.map((a) => `<div class="amendment"><b>Amendment</b> · ${esc(a.name)} · ${fmtDT(a.time)}<br>${esc(a.text)}<br><small style="color:var(--muted)">Authorization reason: ${esc(a.reason)}</small></div>`).join("")}
      </div>`;

    view.innerHTML = `
<div class="page-head doc-head ${meta.cls}">
  <div>
    <div class="doc-title-row"><span class="doc-tag ${meta.cls}">${meta.short}</span><h1>${esc(doc.title)}</h1></div>
    <div class="sub">created ${fmtDT(doc.createdAt)} by ${esc((S.getUser(doc.createdBy) || {}).name || "—")}</div>
  </div>
  <div class="page-actions">
    <button class="btn" id="printDocBtn">Print / PDF</button>
    ${locked
      ? (canDoc ? `<button class="btn" id="amendBtn">Add amendment</button>` : "")
      : (canDoc ? `<button class="btn primary" id="signBtn">✒ Sign &amp; lock</button>` : "")}
  </div>
</div>

${locked ? `<div class="lock-banner">🔒 Signed &amp; locked. Edits require a signed amendment with an authorization reason.</div>` : ""}
${!canDoc && !locked ? `<div class="banner warn">Read-only: your account cannot edit clinical documents.</div>` : ""}

<div class="doc-layout">
  <div class="card map-card">
    <div class="map-card-head">
      <h2>Dictation &amp; body map</h2>
      <div class="sev-legend">
        <span><i class="sev-dot sev-high"></i>severe</span>
        <span><i class="sev-dot sev-mid"></i>moderate</span>
        <span><i class="sev-dot sev-low"></i>mild</span>
        <span><i class="sev-dot sev-none"></i>resolved</span>
      </div>
    </div>
    <div class="dict-bar">
      <button class="mic-btn" id="micBtn" ${editable ? "" : "disabled"}><span>🎤</span><span id="micLabel">Listen</span></button>
      <select id="langSel" title="Speech language">
        <option value="en-US">English</option>
        <option value="fil-PH">Tagalog / Filipino</option>
        <option value="ceb-PH">Cebuano</option>
      </select>
      <select id="engineSel" title="Dictation engine">
        <option value="browser">Dictation: Browser (current)</option>
        <option value="cloud:standard">Dictation: Google Cloud — Standard (BAA)</option>
        <option value="cloud:chirp">Dictation: Google Cloud — Chirp (BAA)</option>
      </select>
      <span class="dict-status" id="dictStatus">${editable ? "Mic off" : "Locked"}</span>
    </div>
    ${S.settings().audioReview ? `<div class="audio-review" id="audioReview"></div>` : ""}
    <div class="figures">
      <figure><figcaption>Front <span class="hint">(patient's L on your right)</span></figcaption><div class="bodymap" id="mapFront">${figureMarkup("front")}</div></figure>
      <figure><figcaption>Back</figcaption><div class="bodymap" id="mapBack">${figureMarkup("back")}</div></figure>
    </div>
    <div class="map-notes" id="mapNotes"></div>
    <div id="cleanupSummary"></div>
    <div class="transcript-head" style="margin-top:12px">
      <h3>Transcript <span style="font-weight:400; color:var(--muted); font-size:11px">${editable ? "click a line to edit · click the speaker tag to relabel" : "click a finding to see its source"}</span></h3>
      ${editable ? `<button class="btn small" id="refineBtn" title="AI re-reads the whole conversation, splits patient vs clinician, and cleans up the findings">✦ Review &amp; clean up with AI</button>` : ""}
    </div>
    <div class="transcript-log" id="docTranscript"></div>
    <div class="interim-bar"><b>Hearing:</b><span id="interim">…</span></div>
    ${editable ? `<div class="measure-add"><input id="typedDictation" placeholder="No mic? Type what the patient says and press Enter…" /></div>` : ""}
    <div class="route-log" id="routeLog"></div>
  </div>
  <div class="card doc-fields ${meta.cls}">
    ${sections}
    ${sigBlock}
  </div>
</div>
<div class="card" id="insightsCard"></div>`;

    // ------- shared dictation/map state -------
    const dstate = { selectedKey: null, editable };
    currentDocState = dstate;
    drawAllPoints(doc);
    drawMapNotes(doc, dstate);
    drawTranscript(doc, null, dstate);
    renderCleanupSummary(doc);
    renderInsightsCard(doc, user);
    if (S.settings().audioReview) bindAudioReview(doc, user, editable);
    const refineBtn = document.getElementById("refineBtn");
    if (refineBtn) refineBtn.addEventListener("click", () => runRefine(doc, user, dstate));
    document.getElementById("printDocBtn").addEventListener("click", () => {
      printHTML(`<h1>${esc(S.settings().facilityName)}</h1>
        <div class="print-muted">${esc(S.patientName(p))} · DOB ${esc(p.dob)}</div>${docPrintHtml(doc)}`);
    });

    // autosave draft fields
    if (editable) {
      view.querySelectorAll("textarea[data-field]").forEach((t) => {
        t.addEventListener("input", () => {
          S.updateDocData(doc.id, { [t.dataset.field]: t.value }, user);
        });
      });
      bindMeasurementEditor(doc, user);
    }

    // sign / amend
    const signBtn = document.getElementById("signBtn");
    if (signBtn) signBtn.addEventListener("click", () => signModal(doc, user));
    const amendBtn = document.getElementById("amendBtn");
    if (amendBtn) amendBtn.addEventListener("click", () => amendModal(doc, user));

    // ------- speech -------
    if (editable) {
      startDictation(doc, user, dstate);
      const typed = document.getElementById("typedDictation");
      typed.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && typed.value.trim()) {
          routeUtterance(doc, user, typed.value, dstate);
          typed.value = "";
        }
      });
    }
  }

  /* ---- measurement tables ---- */

  function measurementEditor(doc, editable) {
    const d = doc.data;
    const del = (kind, i) => editable ? `<button class="btn small" data-delmeas="${kind}:${i}" title="Remove">✕</button>` : "";
    const rows = [];
    (d.rom || []).forEach((r, i) => rows.push(`<tr><td>ROM</td><td>${esc(r.side || "—")} ${esc(r.joint)} ${esc(r.motion)}</td><td class="num">${r.degrees}°</td><td>${del("rom", i)}</td></tr>`));
    (d.mmt || []).forEach((r, i) => rows.push(`<tr><td>MMT</td><td>${esc(r.context || "—")}</td><td class="num">${esc(r.grade)}</td><td>${del("mmt", i)}</td></tr>`));
    (d.special || []).forEach((r, i) => rows.push(`<tr><td>Special test</td><td>${esc(r.name)}</td><td>${esc(r.result)}</td><td>${del("special", i)}</td></tr>`));
    (d.pain || []).forEach((r, i) => rows.push(`<tr><td>Pain</td><td>${esc(r.location || "—")}</td><td class="num">${r.score}/10</td><td>${del("pain", i)}</td></tr>`));
    return `
<div class="field"><label>Objective measurements — filled automatically from dictation</label>
  <div class="table-scroll"><table class="list" id="measTable">
    <thead><tr><th>Type</th><th>Detail</th><th>Value</th><th></th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="4"><div class="empty-state" style="padding:10px">None yet — dictate e.g. “shoulder flexion 120 degrees”, “quad strength 4 out of 5”, “pain 6 out of 10”, “positive Neer test”.</div></td></tr>`}</tbody>
  </table></div>
  ${editable ? `<div class="measure-add">
    <input id="measInput" placeholder='Type a measurement, e.g. "left knee flexion 95 degrees" and press Enter' />
  </div>` : ""}
</div>`;
  }

  function bindMeasurementEditor(doc, user) {
    document.querySelectorAll("[data-delmeas]").forEach((b) =>
      b.addEventListener("click", () => {
        const [kind, i] = b.dataset.delmeas.split(":");
        doc.data[kind].splice(Number(i), 1);
        S.save();
        render();
      })
    );
    const inp = document.getElementById("measInput");
    if (inp) inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !inp.value.trim()) return;
      const parsed = PR.parseUtterance(inp.value);
      const n = mergeMeasurements(doc, parsed.measurements);
      if (n) { S.save(); render(); }
      else {
        document.getElementById("routeLog").textContent = "No measurement recognized in that phrase.";
        inp.select();
      }
    });
  }

  function mergeMeasurements(doc, meas) {
    let n = 0;
    for (const k of ["rom", "mmt", "special", "pain"]) {
      if (!doc.data[k]) doc.data[k] = [];
      for (const item of meas[k] || []) { doc.data[k].push(item); n++; }
    }
    return n;
  }

  /* ---- body map drawing ---- */

  const layerFor = (view) =>
    document.querySelector(`#map${view === "back" ? "Back" : "Front"} .points-layer`);

  const svgNS = "http://www.w3.org/2000/svg";
  const mkSvg = (tag, attrs) => {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  /* Draw the body chart as a callout diagram: a small severity-coloured dot
     at the exact spot, a leader line out to a numbered marker in the gutter
     beside the figure. Numbers sit OUTSIDE the mannequin and are spaced apart,
     so several findings can point at the same area and each stays legible. */
  function drawAllPoints(doc) {
    ["front", "back"].forEach((v) => { const l = layerFor(v); if (l) l.innerHTML = ""; });
    const pts = doc.data.mapPoints || [];
    // re-pin every point to the current lexicon coordinates + tag its number
    pts.forEach((pt, i) => {
      if (pt.part) { const c = PR.coordForName(pt.part, pt.side); pt.x = c.x; pt.y = c.y; pt.view = c.view; }
      // display-only annotations: non-enumerable so they never get saved/synced
      Object.defineProperty(pt, "_num", { value: i + 1, configurable: true });
      Object.defineProperty(pt, "_sev", { value: severityOf(pt), configurable: true });
    });
    for (const view of ["front", "back"]) {
      const layer = layerFor(view);
      if (!layer) continue;
      const here = pts.filter((p) => p.view === view);
      for (const side of ["left", "right"]) {
        const col = here.filter((p) => (p.x <= 100 ? "left" : "right") === side).sort((a, b) => a.y - b.y);
        layoutGutter(col, side).forEach(({ pt, ly }) => drawCallout(doc, layer, pt, side, ly));
      }
    }
  }

  // spread label y-positions in a gutter so markers never overlap
  function layoutGutter(col, side) {
    const GAP = 30, MIN = 8, MAX = 452;
    let y = MIN;
    return col.map((pt) => {
      const ly = Math.min(MAX, Math.max(y, pt.y));
      y = ly + GAP;
      return { pt, ly };
    });
  }

  function drawCallout(doc, layer, pt, side, ly) {
    const lx = side === "left" ? -46 : 246; // gutter x
    const elbow = side === "left" ? -30 : 230;
    const g = mkSvg("g", { class: `point-group ${pt._sev.cls}` });
    g.dataset.key = pt.key;

    // leader line: dot → elbow → marker
    const line = mkSvg("polyline", {
      class: "leader",
      points: `${pt.x},${pt.y} ${elbow},${ly} ${lx + (side === "left" ? 12 : -12)},${ly}`,
    });
    const dot = mkSvg("circle", { class: "loc-dot", cx: pt.x, cy: pt.y, r: 3.6 });
    const ring = mkSvg("circle", { class: "loc-ring", cx: pt.x, cy: pt.y, r: 3.6 });
    const marker = mkSvg("circle", { class: "marker", cx: lx, cy: ly, r: 11 });
    const num = mkSvg("text", { class: "marker-num", x: lx, y: ly });
    num.textContent = pt._num;
    const title = document.createElementNS(svgNS, "title");
    const latest = pt.notes[pt.notes.length - 1];
    title.textContent = `${pt.side ? cap(pt.side) + " " : ""}${pt.part}${latest ? " — " + latest.summary : ""} (${pt._sev.label})`;
    marker.appendChild(title);

    g.append(line, ring, dot, marker, num);
    g.addEventListener("click", () => selectMapPoint(doc, pt.key));
    layer.appendChild(g);
  }

  function drawMapNotes(doc, dstate) {
    const box = document.getElementById("mapNotes");
    if (!box) return;
    const editable = dstate && dstate.editable;
    const pts = doc.data.mapPoints || [];
    box.innerHTML = pts.length ? pts.map((pt, i) => `
      <div class="map-note ${dstate && dstate.selectedKey === pt.key ? "selected" : ""}" data-key="${esc(pt.key)}">
        <div class="map-note-head">
          <b><span class="badge ${severityOf(pt).cls}">${i + 1}</span><span class="note-part" ${editable ? `contenteditable="true" data-editpart="${esc(pt.key)}" title="Click to correct the body area — the marker re-pins to wherever you name (e.g. “back of leg”, “left knee”)"` : ""}>${esc(pt.side ? cap(pt.side) + " " : "")}${esc(pt.part)}</span></b>
          ${editable ? `<button class="icon-btn" data-delpoint="${esc(pt.key)}" title="Remove this finding">✕</button>` : ""}
        </div>
        ${pt.notes.map((n, ni) => `<div>· <span class="note-summary" ${editable ? `contenteditable="true" data-editnote="${esc(pt.key)}::${ni}"` : ""}>${esc(n.summary)}</span> ${n.quote ? `<span class="quote">“${esc(n.quote)}”</span>` : ""}</div>`).join("")}
      </div>`).join("")
      : `<div class="empty-state" style="padding:8px">Body areas the patient mentions will be pinned here automatically.</div>`;

    box.querySelectorAll(".map-note").forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target.closest("[contenteditable], [data-delpoint]")) return;
        selectMapPoint(doc, el.dataset.key);
      })
    );
    if (editable) {
      const user = S.currentUser();
      // Rename a finding's body area — re-pin the marker to wherever it now names.
      box.querySelectorAll("[data-editpart]").forEach((el) => {
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
        el.addEventListener("blur", () => {
          const pt = (doc.data.mapPoints || []).find((x) => x.key === el.dataset.editpart);
          if (!pt) return;
          const raw = el.textContent.trim();
          // The label already carries the side word (e.g. "Left Knee"), so let the
          // typed text alone decide part + side.
          const c = PR.coordForName(raw, null);
          if (!raw || (c.part === pt.part && (c.side || null) === (pt.side || null))) {
            drawMapNotes(doc, dstate); // no real change — restore the tidy label
            return;
          }
          pt.part = c.part; pt.side = c.side || null; pt.view = c.view; pt.x = c.x; pt.y = c.y;
          pt.key = `${c.part}|${c.side || ""}`;
          if (dstate.selectedKey === el.dataset.editpart) dstate.selectedKey = pt.key;
          S.updateDocData(doc.id, doc.data, user);
          drawAllPoints(doc);
          drawMapNotes(doc, dstate);
        });
      });
      box.querySelectorAll("[data-editnote]").forEach((el) => {
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
        el.addEventListener("blur", () => {
          const [key, ni] = el.dataset.editnote.split("::");
          const pt = (doc.data.mapPoints || []).find((x) => x.key === key);
          if (!pt || !pt.notes[ni]) return;
          const v = el.textContent.trim();
          if (v && v !== pt.notes[ni].summary) { pt.notes[ni].summary = v; S.updateDocData(doc.id, doc.data, user); }
        });
      });
      box.querySelectorAll("[data-delpoint]").forEach((b) =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          doc.data.mapPoints = (doc.data.mapPoints || []).filter((x) => x.key !== b.dataset.delpoint);
          S.updateDocData(doc.id, doc.data, user);
          drawAllPoints(doc);
          drawMapNotes(doc, dstate);
        })
      );
    }
  }

  let currentDocState = null;

  function selectMapPoint(doc, key) {
    const dstate = currentDocState || {};
    dstate.selectedKey = dstate.selectedKey === key ? null : key;
    drawMapNotes(doc, dstate);
    // transcript highlight
    const pt = (doc.data.mapPoints || []).find((x) => x.key === key);
    const marksByUtt = new Map();
    if (dstate.selectedKey && pt) {
      for (const n of pt.notes) {
        if (n.uttId == null) continue;
        if (!marksByUtt.has(n.uttId)) marksByUtt.set(n.uttId, []);
        marksByUtt.get(n.uttId).push(...(n.marks || []));
      }
    }
    drawTranscript(doc, marksByUtt, dstate);
    if (dstate.selectedKey && marksByUtt.size) {
      const first = Math.min(...marksByUtt.keys());
      const target = document.querySelector(`#docTranscript [data-utt="${first}"]`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // flash the dot
    const g = document.querySelector(`.point-group[data-key="${CSS.escape(key)}"]`);
    if (g) { g.classList.add("flash"); setTimeout(() => g.classList.remove("flash"), 1100); }
  }

  function uttHtml(text, marks) {
    if (!marks || !marks.length) return esc(text);
    const level = new Uint8Array(text.length);
    for (const [s, e, strong] of marks) {
      const lv = strong ? 2 : 1;
      for (let i = Math.max(0, s); i < Math.min(text.length, e); i++) if (level[i] < lv) level[i] = lv;
    }
    let html = "", i = 0;
    while (i < text.length) {
      const lv = level[i];
      let j = i;
      while (j < text.length && level[j] === lv) j++;
      const chunk = esc(text.slice(i, j));
      html += lv === 2 ? `<mark class="hl strong">${chunk}</mark>` : lv === 1 ? `<mark class="hl">${chunk}</mark>` : chunk;
      i = j;
    }
    return html;
  }

  const SPEAKER_NEXT = { patient: "clinician", clinician: "", "": "patient" };
  const speakerTag = (sp) =>
    sp === "patient" ? `<span class="spk spk-patient">Patient</span>`
      : sp === "clinician" ? `<span class="spk spk-clin">Clinician</span>`
        : `<span class="spk spk-none">—</span>`;

  function drawTranscript(doc, marksByUtt, dstate) {
    const box = document.getElementById("docTranscript");
    if (!box) return;
    const editable = dstate && dstate.editable;
    const t = doc.data.transcript || [];
    box.innerHTML = t.length ? t.map((u, i) => `
      <div class="utt ${u.speaker ? "utt-" + u.speaker : ""}" data-utt="${i}">
        <span class="utt-meta">
          ${editable
        ? `<span class="spk-toggle" data-spk="${i}" role="button" tabindex="0" title="Click to relabel speaker">${speakerTag(u.speaker || "")}</span>`
        : (u.speaker ? speakerTag(u.speaker) : `<span class="utt-time">${esc(u.time || "")}</span>`)}
        </span>
        <span class="utt-text" ${editable ? `contenteditable="true" data-edittext="${i}"` : ""}>${uttHtml(u.text, marksByUtt ? marksByUtt.get(i) : null)}</span>
      </div>`).join("")
      : `<div class="empty-state" style="padding:8px">Everything said while listening is saved here, word for word.</div>`;
    if (!marksByUtt) box.scrollTop = box.scrollHeight;

    if (editable) {
      const user = S.currentUser();
      box.querySelectorAll("[data-edittext]").forEach((el) => {
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
        el.addEventListener("blur", () => {
          const i = Number(el.dataset.edittext);
          const v = el.textContent.trim();
          if (v && doc.data.transcript[i] && v !== doc.data.transcript[i].text) {
            doc.data.transcript[i].text = v;
            doc.data.transcript[i].edited = true;
            S.updateDocData(doc.id, doc.data, user);
          }
        });
      });
      const relabel = (i) => {
        const u = doc.data.transcript[i];
        u.speaker = SPEAKER_NEXT[u.speaker || ""];
        S.updateDocData(doc.id, doc.data, user);
        drawTranscript(doc, null, dstate);
      };
      box.querySelectorAll("[data-spk]").forEach((el) => {
        el.addEventListener("click", () => relabel(Number(el.dataset.spk)));
        el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); relabel(Number(el.dataset.spk)); } });
      });
    }
  }

  /* ---- dictation + routing ---- */

  const TREAT_RE = /\b(performed|completed|exercis\w*|therex|sets?|reps?|ultrasound|massage|stretch\w*|mobilizat\w*|manual therapy|gait|ice|heat|e-?stim\w*|modalit\w*|educat\w*|hep|home program|tens)\b/i;

  /* Two interchangeable dictation engines the clinician switches between:
     - "browser": the Web Speech API (fast, streams audio to the browser
       vendor's servers — on Chrome, Google's consumer service). The current
       default; no BAA, so not for real PHI once live.
     - "cloud":   records short WAV segments in the page and POSTs them to the
       server's /api/stt, which proxies to Google Cloud Speech-to-Text under the
       clinic's BAA (model "standard" or "chirp"). See cloudEngine below. */

  function browserEngine({ lang, onText, onInterim, onStatus }) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    let listening = false;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang();
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) onText(res[0].transcript);
        else interim += res[0].transcript;
      }
      onInterim(interim);
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        listening = false;
        onStatus("Mic blocked — allow microphone access and retry.", false);
      } else if (event.error === "language-not-supported") {
        onStatus("This speech language isn't supported here — try another device, or type below.", listening);
      } else if (event.error === "network") {
        onStatus("No connection — dictation needs the internet. Type into the box below until you're back online.", listening);
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        onStatus(`Mic error: ${event.error}`, listening);
      }
    };
    rec.onend = () => { if (listening) { try { rec.start(); } catch (_) { } } };
    return {
      name: "browser",
      start() { listening = true; rec.lang = lang(); try { rec.start(); } catch (_) { } },
      stop() { listening = false; try { rec.stop(); } catch (_) { } },
      setLang(l) { rec.lang = l; },
      pending: () => 0,
    };
  }

  function encodeWav(float32, inRate, outRate = 16000) {
    // downsample (linear) + 16-bit PCM WAV encode, entirely in the page
    const ratio = inRate / outRate;
    const outLen = Math.floor(float32.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = float32[i0] * (1 - frac) + (float32[Math.min(i0 + 1, float32.length - 1)] || 0) * frac;
      pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }

  // BCP-47 codes Google Cloud Speech-to-Text expects for each UI language
  const STT_LANG = { "en-US": "en-US", "fil-PH": "fil-PH", "ceb-PH": "ceb-PH" };

  /* Google Cloud Speech-to-Text engine. Records short WAV segments in the page
     and POSTs each straight to /api/stt (model = "standard" | "chirp"), which
     proxies to Google Cloud under the clinic's BAA. Segments are held only in
     memory and sent immediately — no audio is written to the device — and are
     delivered in order via a promise chain. */
  function cloudEngine({ docId, lang, model, onText, onInterim, onStatus }) {
    let ctx = null, stream = null, proc = null, listening = false;
    let seg = [], voicedMs = 0, silenceMs = 0, segMs = 0;
    let pending = 0;               // segments in flight
    let chain = Promise.resolve(); // keeps segments transcribing in order

    const label = model === "chirp" ? "Google Cloud · Chirp" : "Google Cloud · Standard";
    const status = () => {
      const q = pending ? ` — transcribing ${pending} segment${pending > 1 ? "s" : ""}…` : "";
      if (listening) onStatus(`Listening (${label})${q}`, true);
      else if (pending) onStatus(`Mic off${q}`, false);
      else onStatus("Mic off", false);
    };

    function send(wav) {
      pending++; status();
      chain = chain.then(async () => {
        const sync = window.TheraSync || {};
        try {
          const res = await fetch(`/api/stt?lang=${encodeURIComponent(STT_LANG[lang()] || "en-US")}&model=${encodeURIComponent(model)}&docId=${encodeURIComponent(docId)}`, {
            method: "POST",
            headers: Object.assign({ "content-type": "audio/wav" }, sync.token ? { authorization: `Bearer ${sync.token}` } : {}),
            body: wav,
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) { if (data.text) onText(data.text); }
          else onStatus(res.status === 501
            ? "Google Cloud dictation isn't set up on the server yet — see Privacy & Security."
            : `Dictation error: ${(data.error || "server " + res.status)}`, listening);
        } catch (_) {
          onStatus("Couldn't reach the server for dictation — check your connection.", listening);
        } finally { pending = Math.max(0, pending - 1); status(); }
      });
    }

    function cut(force) {
      const dur = segMs;
      const samples = seg;
      seg = []; voicedMs = 0; silenceMs = 0; segMs = 0;
      if (!samples.length || voicedTotal(samples) === 0) return;
      if (!force && dur < 900) return;
      const flat = new Float32Array(samples.reduce((n, a) => n + a.length, 0));
      let off = 0;
      for (const a of samples) { flat.set(a, off); off += a.length; }
      send(encodeWav(flat, ctx ? ctx.sampleRate : 16000));
    }
    // rough check that a segment contains any speech-level audio at all
    function voicedTotal(samples) {
      let n = 0;
      for (const a of samples) for (let i = 0; i < a.length; i += 160) if (Math.abs(a[i]) > 0.015) n++;
      return n;
    }

    return {
      name: "cloud",
      pending: () => pending,
      async start() {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        } catch (_) {
          onStatus("Mic blocked — allow microphone access and retry.", false);
          return false;
        }
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaStreamSource(stream);
        proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
          if (!listening) return;
          const data = e.inputBuffer.getChannelData(0);
          seg.push(new Float32Array(data));
          const chunkMs = (data.length / ctx.sampleRate) * 1000;
          segMs += chunkMs;
          let rms = 0;
          for (let i = 0; i < data.length; i += 8) rms += data[i] * data[i];
          rms = Math.sqrt(rms / (data.length / 8));
          if (rms > 0.012) { voicedMs += chunkMs; silenceMs = 0; }
          else silenceMs += chunkMs;
          onInterim(voicedMs > 200 ? "recording…" : "");
          // cut on a natural pause, or hard-cut long monologues
          if ((voicedMs > 400 && silenceMs > 750) || segMs > 15000) cut(false);
        };
        src.connect(proc);
        proc.connect(ctx.destination);
        listening = true;
        status();
        return true;
      },
      stop() {
        listening = false;
        cut(true); // flush whatever was being said
        try { if (proc) proc.disconnect(); } catch (_) { }
        try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
        try { if (ctx) ctx.close(); } catch (_) { }
        status();
      },
      setLang() { },
      // test hook: feed synthetic samples through the same path as the mic
      _testPush(float32, sampleRate) {
        ctx = ctx || { sampleRate: sampleRate || 16000 };
        seg.push(float32);
        segMs += (float32.length / ctx.sampleRate) * 1000;
        voicedMs += 1000;
        cut(true);
      },
    };
  }

  function startDictation(doc, user, dstate) {
    currentDocState = dstate;
    const micBtn = document.getElementById("micBtn");
    const micLabel = document.getElementById("micLabel");
    const statusEl = document.getElementById("dictStatus");
    const interimEl = document.getElementById("interim");
    const langSel = document.getElementById("langSel");
    const engineSel = document.getElementById("engineSel");
    langSel.value = localStorage.getItem("therachart-lang") || "en-US";

    // Google Cloud dictation is offered whenever the server reports it's set up.
    // Until then (e.g. this preview), the cloud options stay disabled and the
    // browser engine remains the working default.
    const stt = (window.TheraSync && window.TheraSync.stt) || { available: false };
    if (!stt.available) {
      engineSel.querySelectorAll('option[value^="cloud:"]').forEach((o) => {
        o.disabled = true;
        o.textContent = o.textContent.replace(" (BAA)", " — needs Google Cloud setup");
      });
    }
    let engineChoice = localStorage.getItem("therachart-engine") || "browser";
    if (engineChoice.startsWith("cloud:") && !stt.available) engineChoice = "browser";
    engineSel.value = engineChoice;

    let listening = false;
    // deliver a finished utterance, but only draw into the note if it's still
    // the one on screen — a cloud segment can land just after we navigate away
    const deliver = (text) => {
      const seg = location.hash.split("/");
      const open = seg[1] === "doc" && seg[2] === doc.id;
      routeUtterance(doc, user, text, open ? currentDocState : null, !open);
    };
    const callbacks = {
      docId: doc.id,
      lang: () => langSel.value,
      onText: deliver,
      onInterim: (t) => { interimEl.textContent = t ? t + " …" : "…"; },
      onStatus: (msg, isListening) => { statusEl.textContent = msg; if (isListening === false && !listening) setUI(); },
    };

    let engine = null;
    function makeEngine() {
      if (engineChoice.startsWith("cloud:")) {
        engine = cloudEngine(Object.assign({}, callbacks, { model: engineChoice.split(":")[1] || "standard" }));
      } else {
        engine = browserEngine(callbacks);
        if (!engine) statusEl.textContent = "Speech not supported in this browser — type into the dictation box instead.";
      }
      window.__theraDict = engine; // test hook
    }
    makeEngine();

    const setUI = () => {
      micBtn.classList.toggle("listening", listening);
      micLabel.textContent = listening ? "Stop" : "Listen";
      if (!listening && engine && engine.pending() === 0) statusEl.textContent = "Mic off";
      // the cloud engine writes its own richer status (model + queue); only the
      // browser engine needs setUI to set the "Listening…" line
      if (listening && !engineChoice.startsWith("cloud:")) {
        statusEl.textContent = `Listening… (${langSel.selectedOptions[0].text})`;
      }
    };

    micBtn.addEventListener("click", async () => {
      if (!engine) return;
      if (!listening) {
        listening = true;
        const ok = await Promise.resolve(engine.start());
        if (ok === false) listening = false;
      } else {
        listening = false;
        engine.stop();
      }
      setUI();
    });

    langSel.addEventListener("change", () => {
      localStorage.setItem("therachart-lang", langSel.value);
      if (engine) engine.setLang(langSel.value);
      setUI();
    });

    engineSel.addEventListener("change", () => {
      const wasListening = listening;
      if (engine) engine.stop();
      listening = false;
      engineChoice = engineSel.value;
      localStorage.setItem("therachart-engine", engineChoice);
      makeEngine();
      if (wasListening && engine) {
        listening = true;
        Promise.resolve(engine.start()).then((ok) => { if (ok === false) { listening = false; setUI(); } });
      }
      setUI();
    });

    activeDictation = {
      stop() { if (engine) engine.stop(); listening = false; },
    };
  }

  /* Temporary session-audio review panel. Shows only when the facility enabled
     the feature. Lets the clinician record the patient's consent, then (once
     Google Cloud dictation is in use) replay the kept segments to double-check
     the transcript. Audio auto-deletes when the note is signed or after the
     retention window; here we also offer an immediate "Delete now". */
  async function bindAudioReview(doc, user, editable) {
    const host = document.getElementById("audioReview");
    if (!host) return;
    const sync = window.TheraSync || {};
    const onServer = sync.mode === "server" && sync.token;
    const p = S.getPatient(doc.patientId);
    const consent = p && p.audioConsent && p.audioConsent.granted;

    // fetch kept segments (server-side; only meaningful in clinic/cloud mode)
    let segments = [], reviewDays = 7;
    if (onServer) {
      try {
        const r = await fetch(`/api/audio?docId=${encodeURIComponent(doc.id)}`, { headers: { authorization: `Bearer ${sync.token}` } });
        if (r.ok) { const d = await r.json(); segments = d.segments || []; reviewDays = d.reviewDays || 7; }
      } catch (_) { /* offline: just show the consent state */ }
    }

    const consentLine = consent
      ? `<span class="chip good">🎙 Consented</span> <span style="color:var(--muted)">Patient agreed ${p.audioConsent.at ? fmtDT(p.audioConsent.at) : ""} · audio is kept only to double-check dictation, then deleted when you sign (or after ${reviewDays} days).</span>${editable ? ` <button class="btn small" id="arRevoke">Revoke consent</button>` : ""}`
      : `<span class="chip muted">Session-audio review available</span> <span style="color:var(--muted)">With the patient's consent, Google Cloud dictation audio is kept briefly so you can re-check the transcript, then auto-deleted.</span>${editable ? ` <button class="btn small" id="arConsent">Record patient consent</button>` : ""}`;

    const segList = segments.length
      ? `<div style="margin-top:8px; display:flex; flex-direction:column; gap:6px">
          ${segments.map((s, i) => `<div style="display:flex; align-items:center; gap:8px; font-size:12.5px">
            <button class="btn small" data-ar-play="${esc(s.id)}">▶ Segment ${i + 1}</button>
            <span style="color:var(--muted)">${fmtDT(new Date(s.time).toISOString())} · ${(s.size / 1024).toFixed(0)} KB</span>
          </div>`).join("")}
          <div><button class="btn small danger" id="arDeleteAll">Delete all session audio now</button></div>
        </div>`
      : consent
        ? `<div style="margin-top:6px; font-size:12.5px; color:var(--muted)">No session audio kept yet — dictate with a Google Cloud engine and segments will appear here for review.</div>`
        : "";

    host.innerHTML = `<div class="banner info" style="display:block">
      <div style="font-weight:600; margin-bottom:4px">Session audio (temporary)</div>
      <div style="font-size:12.5px; line-height:1.6">${consentLine}</div>
      ${segList}
    </div>`;

    const rec = document.getElementById("arConsent");
    if (rec) rec.addEventListener("click", () => {
      S.updatePatient(p.id, { audioConsent: { granted: true, at: new Date().toISOString(), by: user.id } }, user.id);
      S.audit(user.id, "audio-consent-granted", S.patientName(p));
      bindAudioReview(doc, user, editable);
    });
    const rev = document.getElementById("arRevoke");
    if (rev) rev.addEventListener("click", () => {
      S.updatePatient(p.id, { audioConsent: { granted: false, at: new Date().toISOString(), by: user.id } }, user.id);
      S.audit(user.id, "audio-consent-revoked", S.patientName(p));
      deleteSessionAudio(doc.id); // stop keeping any audio already captured
      bindAudioReview(doc, user, editable);
    });
    const del = document.getElementById("arDeleteAll");
    if (del) del.addEventListener("click", async () => { await deleteSessionAudio(doc.id); bindAudioReview(doc, user, editable); });
    host.querySelectorAll("[data-ar-play]").forEach((b) => b.addEventListener("click", () => playSegment(doc.id, b.dataset.arPlay, b)));
  }

  async function deleteSessionAudio(docId) {
    const sync = window.TheraSync || {};
    if (!(sync.mode === "server" && sync.token)) return;
    try { await fetch(`/api/audio?docId=${encodeURIComponent(docId)}`, { method: "DELETE", headers: { authorization: `Bearer ${sync.token}` } }); } catch (_) { }
  }

  async function playSegment(docId, segId, btn) {
    const sync = window.TheraSync || {};
    if (!(sync.mode === "server" && sync.token)) return;
    const old = btn.textContent; btn.textContent = "Loading…"; btn.disabled = true;
    try {
      const r = await fetch(`/api/audio?docId=${encodeURIComponent(docId)}&seg=${encodeURIComponent(segId)}`, { headers: { authorization: `Bearer ${sync.token}` } });
      if (!r.ok) throw new Error("unavailable");
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (_) { /* ignore */ } finally { btn.textContent = old; btn.disabled = false; }
  }

  function appendField(doc, field, sentence, silent) {
    const cur = (doc.data[field] || "").trim();
    doc.data[field] = cur ? cur + (cur.endsWith(".") ? " " : ". ") + sentence : sentence;
    if (silent) return; // data only — the open view belongs to another doc
    const t = document.querySelector(`textarea[data-field="${field}"]`);
    if (t) t.value = doc.data[field];
  }

  function routeUtterance(doc, user, raw, dstate, silent) {
    const parsed = PR.parseUtterance(raw);
    if (!parsed.text) return;
    const time = nowTime();
    if (!doc.data.transcript) doc.data.transcript = [];
    const uttId = doc.data.transcript.length;
    doc.data.transcript.push({ time, text: parsed.text });

    const routed = [];
    const nMeas = mergeMeasurements(doc, parsed.measurements);
    if (nMeas) routed.push(`${nMeas} measurement${nMeas > 1 ? "s" : ""} → Objective`);

    // map points — skip mentions that are only part of a measurement
    // ("shoulder flexion 130 degrees" is data, not a complaint)
    const pinnable = parsed.mentions.filter(
      (m) => !(nMeas && m.summary.startsWith("Mentioned this area"))
    );
    for (const m of pinnable) addDocMapPoint(doc, m, uttId, time);
    if (!parsed.mentions.length && parsed.loose && (doc.data.mapPoints || []).length) {
      const pt = doc.data.mapPoints[doc.data.mapPoints.length - 1];
      pt.notes.push({ time, summary: parsed.loose.summary, quote: parsed.loose.quote, uttId, marks: [[0, parsed.text.length, false]] });
      routed.push(`follow-up → ${pt.part}`);
    } else if (pinnable.length) {
      routed.push(`${pinnable.length} body area${pinnable.length > 1 ? "s" : ""} → map`);
    }

    // text routing
    const section = PR.classifyUtterance(parsed.text, parsed, parsed.measurements);
    let field = null;
    if (doc.type === "eval") {
      field = { reason: "reason", precautions: "precautions", pmh: "pmh", assessment: "assessment", objective: "objectiveText", subjective: "subjective" }[section];
    } else if (doc.type === "progress") {
      field = { reason: "currentStatus", precautions: "currentStatus", pmh: "currentStatus", assessment: "assessment", objective: "updatedFindings", subjective: "currentStatus" }[section];
    } else if (doc.type === "daily") {
      // objective measurements (ROM/MMT/tests) live in the table only;
      // pain ratings are patient-reported and also belong in Subjective
      const objMeas = parsed.measurements.rom.length + parsed.measurements.mmt.length + parsed.measurements.special.length;
      field = objMeas ? null : TREAT_RE.test(parsed.text) ? "summary" : "subjective";
    } else if (doc.type === "discharge") {
      field = "summary";
    }
    if (field) {
      appendField(doc, field, cap(parsed.text), silent);
      routed.push(`text → ${fieldLabel(doc.type, field)}`);
    }

    S.updateDocData(doc.id, doc.data, user);
    if (silent) return;
    drawAllPoints(doc);
    drawMapNotes(doc, dstate);
    drawTranscript(doc, null, dstate);
    refreshMeasTable(doc);
    const log = document.getElementById("routeLog");
    if (log) log.textContent = routed.length ? "Filed: " + routed.join(" · ") : "Heard (saved to transcript)";
  }

  function fieldLabel(type, field) {
    return ({
      reason: "Reason for referral", precautions: "Precautions", pmh: "Past medical history",
      subjective: "Subjective", objectiveText: "Objective", assessment: "Assessment",
      summary: type === "discharge" ? "Summary of care" : "Treatment summary",
      currentStatus: "Current status", updatedFindings: "Updated findings",
    })[field] || field;
  }

  function refreshMeasTable(doc) {
    const table = document.getElementById("measTable");
    if (!table) return;
    const holder = table.closest(".field");
    const temp = document.createElement("div");
    temp.innerHTML = measurementEditor(doc, doc.status !== "signed" && S.canDocument(S.currentUser()));
    holder.replaceWith(temp.firstElementChild);
    bindMeasurementEditor(doc, S.currentUser());
  }

  function addDocMapPoint(doc, m, uttId, time) {
    if (!doc.data.mapPoints) doc.data.mapPoints = [];
    const key = `${m.partName}|${m.side || ""}`;
    let pt = doc.data.mapPoints.find((x) => x.key === key);
    if (!pt) {
      pt = { key, part: m.partName, side: m.side, view: m.view, x: m.x, y: m.y, notes: [] };
      while (doc.data.mapPoints.some((o) => o !== pt && o.view === pt.view && Math.abs(o.x - pt.x) < 9 && Math.abs(o.y - pt.y) < 10)) pt.y += 12;
      doc.data.mapPoints.push(pt);
    }
    const last = pt.notes[pt.notes.length - 1];
    if (!last || last.summary !== m.summary || last.uttId !== uttId) {
      pt.notes.push({ time, summary: m.summary, quote: m.quote, uttId, marks: [[m.winStart, m.winEnd, false], [m.start, m.end, true]] });
    }
  }

  /* ================= AI review & clean-up (second pass) ================= */

  function renderCleanupSummary(doc) {
    const box = document.getElementById("cleanupSummary");
    if (!box) return;
    const r = doc.data.refinement;
    if (!r || !r.applied) { box.innerHTML = ""; return; }
    box.innerHTML = `
      <div class="cleanup-card">
        <div class="cleanup-head">
          <b>✦ AI cleanup applied</b>
          <span class="chip ${r.engine === "gemini" ? "info" : "muted"}">${r.engine === "gemini" ? "Gemini" : "local AI"}</span>
          <button class="btn small" id="viewChangesBtn">See what changed</button>
        </div>
        <div class="cleanup-line">${esc(r.headline || "")}</div>
      </div>`;
    const btn = document.getElementById("viewChangesBtn");
    if (btn) btn.addEventListener("click", () => showChangesModal(doc));
  }

  function showChangesModal(doc) {
    const r = doc.data.refinement;
    if (!r) return;
    const rows = (r.changes || []).map((c) => `
      <tr><td><span class="chip ${c.tag === "added" ? "good" : c.tag === "dropped" ? "bad" : c.tag === "reworded" ? "warn" : "muted"}">${esc(c.tag)}</span></td>
      <td>${esc(c.label)}</td><td>${esc(c.detail || "")}</td></tr>`).join("");
    const m = showModal(`
<h2>Live transcript vs AI cleanup</h2>
<p style="font-size:12.5px; color:var(--muted)">What the live pass captured while you spoke, and what the ${r.engine === "gemini" ? "Gemini" : "local"} review changed on ${fmtDT(r.ranAt)}.</p>
<div class="table-scroll"><table class="list"><thead><tr><th>Change</th><th>Finding</th><th>Detail</th></tr></thead>
<tbody>${rows || `<tr><td colspan="3"><div class="empty-state">No differences — the AI confirmed the live findings.</div></td></tr>`}</tbody></table></div>
<div style="font-size:12.5px; margin-top:10px"><b>${r.clinicianTurns || 0}</b> line${r.clinicianTurns === 1 ? "" : "s"} were identified as the clinician speaking and excluded from the patient findings.</div>
<div class="modal-actions"><button class="btn primary" id="chOk">Close</button></div>`);
    m.querySelector("#chOk").addEventListener("click", closeModal);
  }

  async function runRefine(doc, user, dstate) {
    const utterances = (doc.data.transcript || []).map((u) => u.text).filter(Boolean);
    if (!utterances.length) return alertBanner("There's no transcript to review yet — dictate or type something first.");
    const sync = window.TheraSync || {};
    const engineName = sync.refine === "gemini" ? "Google Gemini" : "the local AI reviewer";

    const m = showModal(`<h2>✦ Reviewing with AI…</h2>
      <p style="font-size:13px">Sending the transcript to <b>${esc(engineName)}</b> to split patient vs clinician speech, clean up wording, and re-check the findings.</p>
      <div class="empty-state">Working…</div>`);
    let result;
    try {
      result = sync.refineTranscript
        ? await sync.refineTranscript(utterances)
        : { ...PR.refineTranscript(utterances), source: "local" };
    } catch (e) {
      closeModal();
      return alertBanner("AI review failed: " + e.message + ". Your transcript is unchanged.");
    }
    openReviewModal(doc, user, dstate, result);
  }

  function openReviewModal(doc, user, dstate, result) {
    // Build the merged, editable finding list: live points vs AI findings.
    const livePts = doc.data.mapPoints || [];
    const liveKeys = new Set(livePts.map((p) => p.key));
    const aiByKey = new Map(result.findings.map((f) => [f.key, f]));
    const rows = [];
    for (const f of result.findings) {
      const inLive = liveKeys.has(f.key);
      rows.push({ key: f.key, part: f.part, side: f.side, view: f.view, x: f.x, y: f.y,
        summary: f.summary, quote: f.quote, include: true, origin: inLive ? "confirmed" : "added" });
    }
    for (const p of livePts) {
      if (aiByKey.has(p.key)) continue;
      const sum = p.notes.map((n) => n.summary).join(" · ");
      rows.push({ key: p.key, part: p.part, side: p.side, view: p.view, x: p.x, y: p.y,
        summary: sum, quote: (p.notes[0] || {}).quote || "", include: true, origin: "live-only" });
    }

    const engineChip = result.source && result.source.startsWith("gemini")
      ? `<span class="chip info">Gemini</span>` : `<span class="chip muted">local AI</span>`;

    // which note field the cleaned subjective / treatment text writes into
    const subjField = { eval: "subjective", daily: "subjective", progress: "currentStatus", discharge: "summary" }[doc.type];
    const treatField = doc.type === "daily" ? "summary" : null;
    const meas = result.measurements || { rom: [], mmt: [], special: [], pain: [] };
    const measCount = meas.rom.length + meas.mmt.length + meas.special.length + meas.pain.length;
    const measList = [
      ...meas.rom.map((r) => `ROM · ${r.side ? r.side + " " : ""}${r.joint} ${r.motion} ${r.degrees}°`),
      ...meas.mmt.map((r) => `MMT · ${r.context || ""} ${r.grade}`),
      ...meas.special.map((r) => `${r.name} — ${r.result}`),
      ...meas.pain.map((r) => `Pain · ${r.location || "—"} ${r.score}/10`),
    ];
    const sectionsHtml = `
      <div class="rev-legend">The AI's cleaned write-up. Applying <b>replaces</b> the note's text sections and files the measurements below — all still editable afterward.</div>
      <div class="field"><label>${esc(fieldLabel(doc.type, subjField))} — from the patient's statements</label>
        <textarea data-sec="subjective" class="rev-text" rows="3">${esc(result.subjective || "")}</textarea></div>
      ${treatField ? `<div class="field"><label>Treatment summary — interventions performed</label>
        <textarea data-sec="treatment" class="rev-text" rows="2">${esc(result.treatment || "")}</textarea></div>` : ""}
      <div class="field"><label>Objective measurements to file (${measCount})</label>
        ${measCount ? `<ul class="rev-meas">${measList.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
        : `<div class="empty-state" style="padding:8px">No measurements detected in the transcript.</div>`}</div>`;

    const dialogueHtml = result.dialogue.map((d, i) => `
      <div class="rev-turn">
        <select data-spk="${i}" class="rev-spk">
          <option value="patient" ${d.speaker === "patient" ? "selected" : ""}>Patient</option>
          <option value="clinician" ${d.speaker === "clinician" ? "selected" : ""}>Clinician</option>
        </select>
        <textarea data-turn="${i}" rows="1" class="rev-text">${esc(d.text)}</textarea>
      </div>`).join("");

    const findingRow = (r, i) => `
      <div class="rev-finding">
        <label class="rev-inc"><input type="checkbox" data-inc="${i}" ${r.include ? "checked" : ""}/></label>
        <div class="rev-fbody">
          <div class="rev-fhead"><b>${esc(r.side ? cap(r.side) + " " : "")}${esc(r.part)}</b>
            <span class="chip ${r.origin === "added" ? "good" : r.origin === "live-only" ? "warn" : "muted"}">${r.origin === "added" ? "AI added" : r.origin === "live-only" ? "live only — AI didn't confirm" : "confirmed"}</span></div>
          <textarea data-fsum="${i}" rows="1" class="rev-text">${esc(r.summary)}</textarea>
        </div>
      </div>`;

    const m = showModal(`
<h2>Review &amp; clean up ${engineChip}</h2>
<p style="font-size:12.5px; color:var(--muted); margin-top:-4px">Edit anything below. Speaker labels and wording are yours to correct; only the findings you keep will be saved to the note and body map.</p>
<div class="rev-tabs">
  <button class="rev-tab active" data-tab="dialogue">Conversation</button>
  <button class="rev-tab" data-tab="findings">Findings (${rows.length})</button>
  <button class="rev-tab" data-tab="sections">Note sections</button>
</div>
<div class="rev-pane" data-pane="dialogue">
  <div class="rev-legend">Who said what — click a speaker to change it, edit text inline.</div>
  ${dialogueHtml || `<div class="empty-state">No dialogue.</div>`}
</div>
<div class="rev-pane" data-pane="findings" style="display:none">
  <div class="rev-legend">Findings drawn from the <b>patient's</b> statements. Uncheck any you don't want; edit the wording freely.</div>
  ${rows.map(findingRow).join("") || `<div class="empty-state">No patient findings detected.</div>`}
</div>
<div class="rev-pane" data-pane="sections" style="display:none">${sectionsHtml}</div>
<div class="modal-actions">
  <button class="btn" id="revCancel">Cancel</button>
  <button class="btn primary" id="revApply">Apply cleaned-up version</button>
</div>`);
    m.classList.add("wide");

    const fit = (ta) => { ta.style.height = "auto"; ta.style.height = Math.max(32, ta.scrollHeight) + "px"; };
    m.querySelectorAll(".rev-tab").forEach((t) => t.addEventListener("click", () => {
      m.querySelectorAll(".rev-tab").forEach((x) => x.classList.toggle("active", x === t));
      m.querySelectorAll(".rev-pane").forEach((p) => { p.style.display = p.dataset.pane === t.dataset.tab ? "" : "none"; });
      // re-fit textareas now that their pane is visible (scrollHeight was 0 while hidden)
      m.querySelectorAll(`.rev-pane[data-pane="${t.dataset.tab}"] textarea.rev-text`).forEach(fit);
    }));
    m.querySelectorAll("textarea.rev-text").forEach((ta) => {
      ta.addEventListener("input", () => fit(ta));
      setTimeout(() => fit(ta), 0);
    });

    // live edits back into the working copies
    m.querySelectorAll("[data-spk]").forEach((s) => s.addEventListener("change", () => { result.dialogue[Number(s.dataset.spk)].speaker = s.value; }));
    m.querySelectorAll("[data-turn]").forEach((t) => t.addEventListener("input", () => { result.dialogue[Number(t.dataset.turn)].text = t.value; }));
    m.querySelectorAll("[data-fsum]").forEach((t) => t.addEventListener("input", () => { rows[Number(t.dataset.fsum)].summary = t.value; }));
    m.querySelectorAll("[data-inc]").forEach((c) => c.addEventListener("change", () => { rows[Number(c.dataset.inc)].include = c.checked; }));
    m.querySelectorAll("[data-sec]").forEach((t) => t.addEventListener("input", () => { result[t.dataset.sec] = t.value; }));

    m.querySelector("#revCancel").addEventListener("click", closeModal);
    m.querySelector("#revApply").addEventListener("click", () => {
      applyRefinement(doc, user, dstate, result, rows, { subjField, treatField });
      closeModal();
    });
  }

  function applyRefinement(doc, user, dstate, result, rows, fields) {
    const { subjField, treatField } = fields || {};
    const before = doc.data.mapPoints || [];
    const beforeByKey = new Map(before.map((p) => [p.key, p.notes.map((n) => n.summary).join(" · ")]));
    const sectionChanges = [];

    // 1) transcript becomes the speaker-labeled, cleaned dialogue
    doc.data.transcript = result.dialogue.map((d) => ({ time: "", speaker: d.speaker, text: d.text, edited: true }));

    // 2) rebuild body-map points from the findings the user kept, relinking
    //    each to the dialogue turn that contains its words (click-to-source)
    const findText = (needle) => {
      if (!needle) return -1;
      const key = needle.toLowerCase().replace(/^[…\s]+|[…\s]+$/g, "").slice(0, 20);
      return doc.data.transcript.findIndex((u) => u.text.toLowerCase().includes(key));
    };
    const kept = rows.filter((r) => r.include && r.summary.trim());
    doc.data.mapPoints = kept.map((r) => {
      const c = PR.coordForName(r.part, r.side);
      const quoteIdx = findText(r.quote);
      const uttId = quoteIdx >= 0 ? quoteIdx : findText(r.part);
      const turnText = uttId >= 0 ? doc.data.transcript[uttId].text : "";
      return {
        key: r.key, part: c.part, side: r.side, view: c.view, x: c.x, y: c.y,
        notes: [{ time: "", summary: r.summary.trim(), quote: r.quote || "",
          uttId: uttId >= 0 ? uttId : null,
          marks: uttId >= 0 ? [[0, turnText.length, false]] : [] }],
      };
    });

    // 2b) update the note's text sections + objective measurements from the AI
    if (subjField && (result.subjective || "").trim()) {
      doc.data[subjField] = result.subjective.trim();
      sectionChanges.push({ tag: "section", label: fieldLabel(doc.type, subjField), detail: "updated from patient statements" });
    }
    if (treatField && (result.treatment || "").trim()) {
      doc.data[treatField] = result.treatment.trim();
      sectionChanges.push({ tag: "section", label: "Treatment summary", detail: "updated from interventions performed" });
    }
    const meas = result.measurements || { rom: [], mmt: [], special: [], pain: [] };
    let filed = 0;
    for (const kind of ["rom", "mmt", "special", "pain"]) {
      if (!doc.data[kind]) doc.data[kind] = [];
      const seen = new Set(doc.data[kind].map((x) => JSON.stringify(x)));
      for (const item of meas[kind] || []) {
        if (!seen.has(JSON.stringify(item))) { doc.data[kind].push(item); seen.add(JSON.stringify(item)); filed++; }
      }
    }
    if (filed) sectionChanges.push({ tag: "section", label: "Objective measurements", detail: `${filed} filed` });

    // 3) compute the change list (live vs cleaned) for the comparison view
    const changes = sectionChanges.slice();
    const keptKeys = new Set(kept.map((r) => r.key));
    for (const r of kept) {
      const label = `${r.side ? cap(r.side) + " " : ""}${r.part}`;
      if (!beforeByKey.has(r.key)) changes.push({ tag: "added", label, detail: r.summary });
      else if (beforeByKey.get(r.key) !== r.summary) changes.push({ tag: "reworded", label, detail: `“${beforeByKey.get(r.key)}” → “${r.summary}”` });
      else changes.push({ tag: "kept", label, detail: r.summary });
    }
    for (const p of before) {
      if (!keptKeys.has(p.key)) changes.push({ tag: "dropped", label: `${p.side ? cap(p.side) + " " : ""}${p.part}`, detail: "removed in cleanup" });
    }
    const clinicianTurns = result.dialogue.filter((d) => d.speaker === "clinician").length;
    const added = changes.filter((c) => c.tag === "added").length;
    const reworded = changes.filter((c) => c.tag === "reworded").length;
    const dropped = changes.filter((c) => c.tag === "dropped").length;

    const secBit = sectionChanges.length ? ` · ${sectionChanges.length} section${sectionChanges.length === 1 ? "" : "s"} updated` : "";
    doc.data.refinement = {
      applied: true,
      ranAt: new Date().toISOString(),
      engine: result.source && result.source.startsWith("gemini") ? "gemini" : "local",
      changes, clinicianTurns,
      headline: `${clinicianTurns} clinician line${clinicianTurns === 1 ? "" : "s"} set aside · ${added} added · ${reworded} reworded · ${dropped} dropped · ${kept.length} finding${kept.length === 1 ? "" : "s"} kept${secBit}.`,
    };

    S.updateDocData(doc.id, doc.data, user);
    S.audit(user.id, "transcript-refined", `${doc.title}: ${doc.data.refinement.engine} · ${kept.length} findings${secBit}`);
    dstate.selectedKey = null;
    // full re-render so the updated Subjective / Treatment / measurements and
    // body map all reflect the cleaned-up note
    render();
  }

  /* ================= AI clinical insights ================= */

  const findingsFromPoints = (pts) =>
    (pts || []).map((p) => ({ part: p.part, side: p.side, summary: (p.notes || []).map((n) => n.summary).join("; ") }));

  const docSubjective = (d) =>
    d.data.subjective || d.data.currentStatus || d.data.summary || "";

  const measOf = (d) => ({
    rom: d.data.rom || [], mmt: d.data.mmt || [], special: d.data.special || [], pain: d.data.pain || [],
  });

  // Assemble the chart context (current visit + full history) for the insights model.
  function gatherInsightContext(doc) {
    const p = S.getPatient(doc.patientId);
    const evalDoc = S.docsFor(doc.patientId).find((d) => d.type === "eval");
    const all = S.docsFor(doc.patientId)
      .filter((d) => d.id !== doc.id)
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .map((d) => ({
        date: d.createdAt.slice(0, 10), type: docMeta(d.type).label,
        subjective: docSubjective(d), assessment: d.data.assessment || "",
        findings: findingsFromPoints(d.data.mapPoints), measurements: measOf(d),
      }));
    // the 12 most recent visits go in full; anything older (e.g. years of
    // imported records) is compressed into a digest so the AI context stays
    // about a page no matter how long the chart gets
    const history = all.slice(0, 12);
    const historyDigest = all.length > 12 ? window.TheraInsights.buildHistoryDigest(all.slice(12)) : null;
    return {
      patient: p ? { age: age(p.dob), sex: p.sex || "" } : {},
      referral: (evalDoc && evalDoc.data.reason) || (p && p.referringPhysician) || "",
      pmh: (evalDoc && evalDoc.data.pmh) || "",
      current: { subjective: docSubjective(doc), findings: findingsFromPoints(doc.data.mapPoints), measurements: measOf(doc) },
      history, historyDigest,
    };
  }

  const planFieldFor = (type) =>
    ({ eval: "plan", daily: "summary", progress: "assessment", discharge: "recommendations" })[type];

  function renderInsightsCard(doc, user) {
    const card = document.getElementById("insightsCard");
    if (!card) return;
    const editable = doc.status !== "signed" && S.canDocument(user);
    const ins = doc.data.insights;
    const engineChip = ins
      ? `<span class="chip ${ins.source && ins.source.startsWith("gemini") ? "info" : "muted"}">${ins.source && ins.source.startsWith("gemini") ? "Gemini" : "local AI"}</span>` : "";

    card.innerHTML = `
      <div class="ins-head">
        <h2>✦ Clinical insights ${engineChip}<span class="chip muted">decision support</span></h2>
        <button class="btn small ai" id="insBtn">${ins ? "Refresh" : "Find connections &amp; recommendations"}</button>
      </div>
      <p class="ins-disclaimer">Considers this visit <b>and</b> the patient's history. This is decision support for a licensed PT — <b>not a diagnosis</b>. Verify before acting.</p>
      <div id="insBody">${ins ? insightsHtml(ins) : `<div class="empty-state" style="padding:10px">No insights yet. Click above to check the transcript and history for possible connections and next-step recommendations.</div>`}</div>`;

    document.getElementById("insBtn").addEventListener("click", () => runInsights(doc, user));
    bindInsightActions(doc, user, editable);
  }

  function insightsHtml(ins) {
    const confChip = (c) => c ? `<span class="chip ${c === "high" ? "good" : c === "medium" ? "warn" : "muted"}">${esc(c)}</span>` : "";
    const prioChip = (p) => `<span class="chip ${p === "urgent" ? "bad" : p === "high" ? "warn" : "muted"}">${esc(p || "routine")}</span>`;
    const conns = (ins.connections || []).map((c) => `
      <div class="ins-item">
        <div class="ins-item-head"><b>${esc(c.title)}</b>${confChip(c.confidence)}</div>
        <div class="ins-detail">${esc(c.detail || "")}</div>
        ${c.basis ? `<div class="ins-basis">Based on: ${esc(c.basis)}</div>` : ""}
      </div>`).join("");
    const flags = (ins.redFlags || []).map((f) => `
      <div class="ins-flag"><b>⚠ ${esc(f.flag)}</b>${f.action ? `<div class="ins-detail">${esc(f.action)}</div>` : ""}</div>`).join("");
    const recs = (ins.recommendations || []).map((r, i) => `
      <div class="ins-item">
        <div class="ins-item-head"><b>${esc(r.action)}</b>${prioChip(r.priority)}
          <button class="btn small ins-add" data-rec="${i}" title="Append to the note's plan/assessment">＋ Add to note</button></div>
        ${r.rationale ? `<div class="ins-detail">${esc(r.rationale)}</div>` : ""}
      </div>`).join("");
    return `
      ${flags ? `<div class="ins-section"><h3 class="ins-h">Red flags</h3>${flags}</div>` : ""}
      <div class="ins-section"><h3 class="ins-h">Possible connections</h3>${conns || `<div class="empty-state" style="padding:8px">No cross-visit connections detected.</div>`}</div>
      <div class="ins-section"><h3 class="ins-h">Recommendations — what to do now</h3>${recs || `<div class="empty-state" style="padding:8px">No specific recommendations.</div>`}</div>`;
  }

  function bindInsightActions(doc, user, editable) {
    document.querySelectorAll(".ins-add").forEach((b) =>
      b.addEventListener("click", () => {
        if (!editable) return alertBanner("This note is locked — reopen or amend to add recommendations.");
        const rec = doc.data.insights.recommendations[Number(b.dataset.rec)];
        const field = planFieldFor(doc.type);
        if (!rec || !field) return;
        const cur = (doc.data[field] || "").trim();
        doc.data[field] = (cur ? cur + "\n" : "") + `- ${rec.action}${rec.rationale ? ` (${rec.rationale})` : ""}`;
        S.updateDocData(doc.id, doc.data, user);
        const ta = document.querySelector(`textarea[data-field="${field}"]`);
        if (ta) ta.value = doc.data[field];
        b.textContent = "✓ Added";
        b.disabled = true;
      })
    );
  }

  async function runInsights(doc, user) {
    const body = document.getElementById("insBody");
    if (body) body.innerHTML = `<div class="empty-state" style="padding:14px">Analyzing the transcript and history…</div>`;
    const ctx = gatherInsightContext(doc);
    let result;
    try {
      const sync = window.TheraSync || {};
      result = sync.getInsights ? await sync.getInsights(ctx) : window.TheraInsights.buildInsights(ctx);
    } catch (e) {
      if (body) body.innerHTML = `<div class="banner bad">Insights failed: ${esc(e.message)}</div>`;
      return;
    }
    doc.data.insights = { ...result, ranAt: new Date().toISOString() };
    S.updateDocData(doc.id, doc.data, user);
    S.audit(user.id, "insights-generated", `${doc.title}: ${result.source} · ${(result.connections || []).length} connections, ${(result.recommendations || []).length} recs`);
    renderInsightsCard(doc, user);
  }

  /* ---- sign & amend ---- */

  function signModal(doc, user) {
    const pending = window.__theraDict && window.__theraDict.pending ? window.__theraDict.pending() : 0;
    const m = showModal(`
<h2>E-sign &amp; lock — ${esc(doc.title)}</h2>
${pending ? `<div class="banner warn">△ ${pending} dictated segment${pending > 1 ? "s are" : " is"} still being transcribed — wait for them to land before signing, or they will need an amendment.</div>` : ""}
<p style="font-size:13px; color:var(--muted)">Signing certifies this documentation is accurate and complete. The document will lock; later changes require a signed amendment with an authorization reason.</p>
<div class="field"><label>Type your full registered name (${esc(user.name)})</label><input id="sigName" autocomplete="off" /></div>
<div class="field"><label>Password</label><input id="sigPin" type="password" autocomplete="current-password" /></div>
<div class="error" id="sigErr"></div>
<div class="modal-actions">
  <button class="btn" id="sigCancel">Cancel</button>
  <button class="btn primary" id="sigOk">✒ Sign &amp; lock</button>
</div>`);
    m.querySelector("#sigCancel").addEventListener("click", closeModal);
    m.querySelector("#sigOk").addEventListener("click", async () => {
      const err = m.querySelector("#sigErr");
      if (!(await window.TheraSync.verifyPassword(m.querySelector("#sigPin").value))) { err.textContent = "Incorrect password."; return; }
      const res = S.signDoc(doc.id, user, m.querySelector("#sigName").value, "");
      if (res.error) { err.textContent = res.error; return; }
      deleteSessionAudio(doc.id); // signing locks the note — the review audio is no longer needed
      closeModal();
      render();
    });
  }

  function amendModal(doc, user) {
    const m = showModal(`
<h2>Amend a locked document</h2>
<p style="font-size:13px; color:var(--muted)">The original stays intact. Your amendment is appended with your e-signature and an authorization reason, and is recorded in the audit log.</p>
<div class="field"><label>Amendment text *</label><textarea id="amText" rows="3"></textarea></div>
<div class="field"><label>Authorization reason *</label><input id="amReason" placeholder="e.g. Documentation error, late entry…" /></div>
<div class="field"><label>Type your full registered name (${esc(user.name)})</label><input id="amName" autocomplete="off" /></div>
<div class="field"><label>Password</label><input id="amPin" type="password" autocomplete="current-password" /></div>
<div class="error" id="amErr"></div>
<div class="modal-actions">
  <button class="btn" id="amCancel">Cancel</button>
  <button class="btn primary" id="amOk">✒ Sign amendment</button>
</div>`);
    m.querySelector("#amCancel").addEventListener("click", closeModal);
    m.querySelector("#amOk").addEventListener("click", async () => {
      const err = m.querySelector("#amErr");
      if (!(await window.TheraSync.verifyPassword(m.querySelector("#amPin").value))) { err.textContent = "Incorrect password."; return; }
      const res = S.amendDoc(doc.id, user, m.querySelector("#amName").value,
        m.querySelector("#amText").value, m.querySelector("#amReason").value);
      if (res.error) { err.textContent = res.error; return; }
      closeModal();
      render();
    });
  }

  /* ================= CALENDAR ================= */

  let calDate = todayIso();
  let calTherapist = "all";

  function therapists() {
    return S.users().filter((u) => u.active && (u.role === "therapist" || u.role === "admin") && u.license);
  }

  function calendarView(user) {
    const ths = therapists();
    // the selected therapist may have been voided/expired since — fall back
    if (calTherapist !== "all" && !ths.some((t) => t.id === calTherapist)) calTherapist = "all";
    const slots = S.slotsForDay(calDate);
    const appts = S.apptsOn(calDate);
    const cols = calTherapist === "all" ? ths : ths.filter((t) => t.id === calTherapist);

    const grid = !cols.length
      ? `<div class="card"><div class="empty-state">No active licensed therapists to schedule — update staff licenses in Facility Admin.</div></div>`
      : slots.length ? `
<div class="cal-grid" style="grid-template-columns: 80px repeat(${cols.length}, 1fr)">
  <div class="cal-cell cal-head">Time</div>
  ${cols.map((t) => `<div class="cal-cell cal-head">${esc(t.name)}${S.licenseExpired(t) ? ' <span class="chip bad">expired</span>' : ""}</div>`).join("")}
  ${slots.map((slot) => `
    <div class="cal-cell cal-time">${fmtTime(slot)}</div>
    ${cols.map((t) => {
      const here = appts.filter((a) => a.therapistId === t.id && a.start === slot);
      if (here.length) return `<div class="cal-cell">${here.map((a) => `
        <div class="slot-appt" data-appt="${a.id}">${esc(S.patientName(S.getPatient(a.patientId)))}
        <small>${esc(a.note || "")}</small></div>`).join("")}</div>`;
      return `<div class="cal-cell"><span class="slot-free" data-slot="${slot}" data-ther="${t.id}">+ available</span></div>`;
    }).join("")}`).join("")}
</div>` : `<div class="card"><div class="empty-state">The facility is closed on this day.</div></div>`;

    const upcomingReminders = S.appointments()
      .filter((a) => a.status === "booked")
      .flatMap((a) => a.reminders.map((r) => ({ ...r, appt: a })))
      .filter((r) => new Date(r.when) >= new Date(new Date().setHours(0, 0, 0, 0)))
      .sort((a, b) => (a.when < b.when ? -1 : 1))
      .slice(0, 8);

    return `
<div class="page-head">
  <div><h1>Calendar</h1><div class="sub">All bookings record who created or changed them</div></div>
  <div class="page-actions">
    <button class="btn" id="printSchedBtn">Print schedule</button>
  </div>
</div>
<div class="card">
  <div class="cal-toolbar">
    <button class="btn small" id="calPrev">←</button>
    <input type="date" id="calDate" value="${calDate}" />
    <button class="btn small" id="calNext">→</button>
    <button class="btn small" id="calToday">Today</button>
    <select id="calTher">
      <option value="all">All therapists</option>
      ${ths.map((t) => `<option value="${t.id}" ${calTherapist === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
    </select>
    <span class="dict-status">${slots.length ? `${slots.length} slots · ${appts.length} booked` : "closed"}</span>
  </div>
  ${grid}
</div>
<div class="card">
  <h2>Automatic visit reminders</h2>
  <p style="font-size:12.5px; color:var(--muted); margin:0 0 10px">
    Each booking schedules an email/SMS reminder 3 days before and the morning of the visit.
    In this on-device demo the sending is <b>simulated</b> — connecting a real SMS/email gateway is a deployment step.</p>
  ${upcomingReminders.length ? `<table class="list"><thead><tr><th>When</th><th>Patient</th><th>Visit</th><th>Channel</th><th>Status</th></tr></thead><tbody>
    ${upcomingReminders.map((r) => `<tr>
      <td class="num">${fmtDT(r.when)}</td>
      <td>${esc(S.patientName(S.getPatient(r.appt.patientId)))}</td>
      <td class="num">${fmtDT(r.appt.start)}</td>
      <td>${esc(r.method)}</td>
      <td><span class="chip ${r.status.startsWith("sent") ? "good" : "info"}">${esc(r.status)}</span></td></tr>`).join("")}
  </tbody></table>` : `<div class="empty-state">No upcoming reminders.</div>`}
</div>`;
  }

  function bindCalendar(user) {
    const redraw = () => { renderShell(location.hash, calendarView(user), user, bindCalendar); };
    document.getElementById("calDate").addEventListener("change", (e) => { calDate = e.target.value; redraw(); });
    document.getElementById("calPrev").addEventListener("click", () => { calDate = shiftDay(calDate, -1); redraw(); });
    document.getElementById("calNext").addEventListener("click", () => { calDate = shiftDay(calDate, 1); redraw(); });
    document.getElementById("calToday").addEventListener("click", () => { calDate = todayIso(); redraw(); });
    document.getElementById("calTher").addEventListener("change", (e) => { calTherapist = e.target.value; redraw(); });
    document.getElementById("printSchedBtn").addEventListener("click", () => printSchedule(user));

    document.querySelectorAll(".slot-free").forEach((s) =>
      s.addEventListener("click", () => bookingModal(user, s.dataset.slot, s.dataset.ther))
    );
    document.querySelectorAll(".slot-appt").forEach((s) =>
      s.addEventListener("click", () => apptModal(user, s.dataset.appt))
    );
  }

  const shiftDay = (iso, n) => {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return localIso(d);
  };

  function bookingModal(user, slot, therId) {
    const pats = S.patients().slice().sort((a, b) => (a.lastName < b.lastName ? -1 : 1));
    if (!pats.length) return alertBanner("No patients on file yet — register one in Intake first.");
    const m = showModal(`
<h2>Book visit — ${fmtDT(slot)}</h2>
<div class="field"><label>Patient</label><select id="bkPat">
  ${pats.map((p) => `<option value="${p.id}">${esc(S.patientName(p))}</option>`).join("")}
</select></div>
<div class="field"><label>Therapist</label><select id="bkTher">
  ${therapists().map((t) => `<option value="${t.id}" ${t.id === therId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
</select></div>
<div class="field"><label>Note (optional)</label><input id="bkNote" placeholder="e.g. Visit 5, re-eval" /></div>
<p style="font-size:12px; color:var(--muted)">Reminders will be scheduled automatically (3 days before + morning of). Booked by ${esc(user.name)} — recorded.</p>
<div class="error" id="bkErr"></div>
<div class="modal-actions">
  <button class="btn" id="bkCancel">Cancel</button>
  <button class="btn primary" id="bkOk">Book visit</button>
</div>`);
    m.querySelector("#bkCancel").addEventListener("click", closeModal);
    m.querySelector("#bkOk").addEventListener("click", () => {
      const res = S.bookAppointment({
        patientId: m.querySelector("#bkPat").value,
        therapistId: m.querySelector("#bkTher").value,
        start: slot, note: m.querySelector("#bkNote").value,
      }, user);
      if (res.error) { m.querySelector("#bkErr").textContent = res.error; return; }
      closeModal();
      render();
    });
  }

  function apptModal(user, apptId) {
    const a = S.appointments().find((x) => x.id === apptId);
    if (!a) return;
    const p = S.getPatient(a.patientId);
    const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("PT visit — " + S.patientName(p))}&dates=${gcalTime(a.start)}/${gcalTime(new Date(new Date(a.start).getTime() + a.minutes * 60000).toISOString())}`;
    const m = showModal(`
<h2>${esc(S.patientName(p))} — ${fmtDT(a.start)}</h2>
<table class="list"><tbody>
  <tr><td style="color:var(--muted)">Therapist</td><td>${esc((S.getUser(a.therapistId) || {}).name || "—")}</td></tr>
  <tr><td style="color:var(--muted)">Note</td><td>${esc(a.note || "—")}</td></tr>
  <tr><td style="color:var(--muted)">Booked by</td><td>${esc((S.getUser(a.createdBy) || {}).name || "—")} · ${fmtDT(a.createdAt)}</td></tr>
</tbody></table>
<h3 style="margin-top:10px">Change history</h3>
<table class="list"><tbody>${a.history.map((h) => `<tr><td>${esc(h.action)}</td><td>${esc((S.getUser(h.userId) || {}).name || "—")}</td><td class="num">${fmtDT(h.time)}</td></tr>`).join("")}</tbody></table>
<h3 style="margin-top:10px">Reminders</h3>
<table class="list"><tbody>${a.reminders.map((r) => `<tr><td class="num">${fmtDT(r.when)}</td><td>${esc(r.method)}</td><td><span class="chip info">${esc(r.status)}</span></td></tr>`).join("") || "<tr><td>None</td></tr>"}</tbody></table>
<div class="modal-actions">
  <a class="btn small" href="${gcal}" target="_blank" rel="noopener">Add to Google Calendar</a>
  <a class="btn small" href="#/patient/${p.id}" id="apChart">Open chart</a>
  <button class="btn small danger" id="apCancel">Cancel visit</button>
  <button class="btn small" id="apClose">Close</button>
</div>`);
    m.querySelector("#apClose").addEventListener("click", closeModal);
    m.querySelector("#apChart").addEventListener("click", closeModal);
    m.querySelector("#apCancel").addEventListener("click", () => {
      S.cancelAppointment(a.id, user);
      closeModal();
      render();
    });
  }

  const gcalTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  function printSchedule(user) {
    const ths = calTherapist === "all" ? therapists() : therapists().filter((t) => t.id === calTherapist);
    const appts = S.apptsOn(calDate).sort((a, b) => (a.start < b.start ? -1 : 1));
    const html = `
<h1>${esc(S.settings().facilityName)}</h1>
<div class="print-muted">Schedule for ${fmtDate(calDate + "T00:00:00")}${calTherapist !== "all" ? " — " + esc(ths[0]?.name || "") : " — all therapists"} · printed ${fmtDT(new Date().toISOString())} by ${esc(user.name)}</div>
${ths.map((t) => {
      const mine = appts.filter((a) => a.therapistId === t.id);
      return `<h2>${esc(t.name)}</h2>
      ${mine.length ? `<table><tr><th>Time</th><th>Patient</th><th>Phone</th><th>Note</th><th>Booked by</th></tr>
        ${mine.map((a) => {
        const p = S.getPatient(a.patientId);
        return `<tr><td>${fmtTime(a.start)}</td><td>${esc(S.patientName(p))}</td><td>${esc(p ? p.phone : "")}</td><td>${esc(a.note || "")}</td><td>${esc((S.getUser(a.createdBy) || {}).name || "")}</td></tr>`;
      }).join("")}</table>` : `<p class="print-muted">No visits.</p>`}`;
    }).join("")}`;
    S.audit(user.id, "schedule-printed", calDate);
    printHTML(html);
  }

  /* ================= PRIVACY ================= */

  function privacyView(user) {
    const log = S.auditLog().slice().reverse().slice(0, 100);
    const geminiOn = window.TheraSync && window.TheraSync.refine === "gemini";
    return `
<div class="page-head">
  <div><h1>Privacy &amp; Security</h1><div class="sub">Where your information lives and what the AI features do with it — in plain terms</div></div>
</div>
<div class="cards-3" style="align-items:stretch">
  <div class="card">
    <h2>🔐 Where your data lives</h2>
    <p style="font-size:13px">TheraChart runs as one secure service on <b>Google Cloud</b>, so your clinic can open it from anywhere — the office, a home visit, another city — with the same login. Records are kept in an <b>encrypted database</b>, and each clinic's data is walled off from every other clinic's.</p>
    <p style="font-size:13px">Google Cloud holds that data under a signed <b>Business Associate Agreement (BAA)</b> — the healthcare contract that legally binds them to protect patient information. Nothing is stored on a service that isn't under that agreement.</p>
    <p style="font-size:13px">You stay in control: download a complete backup or erase everything, any time.</p>
    <div style="display:flex; gap:8px; flex-wrap:wrap">
      <button class="btn small" id="exportDataBtn">Export backup (JSON)</button>
      <button class="btn small danger" id="wipeBtn">Erase all data</button>
    </div>
  </div>
  <div class="card">
    <h2>🎤 Voice dictation</h2>
    <p style="font-size:13px">When you dictate, the audio streams to <b>Google Cloud Speech-to-Text</b>, which turns it into text and sends it straight back — under the <b>same Google Cloud BAA</b>, never a free consumer speech service. <b>By default the audio itself is kept only in memory and discarded</b> the moment it's transcribed; only the transcript is saved.</p>
    <p style="font-size:13px"><b>Optional session-audio review.</b> A clinic can turn on a feature — off by default — that keeps the dictation audio briefly <b>for patients who consent</b>, so a clinician can replay it to double-check the transcript. That kept audio is <b>automatically deleted the moment the note is signed</b>, or after the clinic's short retention window, whichever comes first. It's never kept long-term, and the patient's consent is recorded in the chart.</p>
  </div>
  <div class="card">
    <h2>✦ AI cleanup &amp; insights${geminiOn ? " (Gemini)" : ""}</h2>
    ${geminiOn
      ? `<p style="font-size:13px">When you press <b>✦ Review &amp; clean up</b> or ask for <b>insights</b>, the note's <b>text</b> — never the audio — is sent to <b>Google Gemini on Vertex AI</b>, under the same Google Cloud BAA. Under that agreement, <b>Google does not use your data to train its models</b>.</p>
    <p style="font-size:13px"><b>Importing a scanned PDF</b> of past visits sends that document the same way, to be read into chart entries.</p>
    <p style="font-size:13px; margin-bottom:0">The AI only ever suggests — every result is shown for your review, and <b>nothing is saved until a licensed clinician approves and signs it</b>.</p>`
      : `<p style="font-size:13px">Cleanup and insights run on a built-in reviewer <b>right on this device</b> — nothing is sent anywhere.</p>
    <p style="font-size:13px; margin-bottom:0">A clinic can connect <b>Google Gemini on Vertex AI</b> (under the BAA) for smarter results and scanned-PDF import; this one hasn't. Either way, a licensed clinician reviews and signs everything.</p>`}
  </div>
</div>
<div class="cards-2">
  <div class="card">
    <h2>🛡 Who can see what</h2>
    <ul style="font-size:13px; margin:0; padding-left:18px; line-height:1.8">
      <li>Everyone signs in with their own PIN and sees only what their role needs (therapist / front desk / admin)</li>
      <li>Expired licenses and voided accounts lose access automatically</li>
      <li>Signed documents lock — later changes need a signed, authorized amendment</li>
      <li>Notable actions are recorded in the activity log below</li>
    </ul>
  </div>
  <div class="card">
    <h2>A note on real-world use</h2>
    <p style="font-size:13px; margin:0">This is a demonstration build. Before storing real patient data, deploy TheraChart's production configuration — sign the <b>Google Cloud BAA</b>, enable the encrypted database and the Vertex AI &amp; Speech-to-Text endpoints, and replace the demo PIN logins with real per-user credentials — to meet <b>HIPAA</b> (US) or the <b>Data Privacy Act of 2012 / RA 10173</b> (Philippines).</p>
  </div>
</div>
<div class="card">
  <h2>Activity log <span style="font-weight:400; color:var(--muted); font-size:12px">most recent 100 events</span></h2>
  <div class="table-scroll"><table class="list"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
    ${log.map((e) => `<tr><td class="num">${fmtDT(e.time)}</td><td>${esc((S.getUser(e.userId) || {}).name || e.userId || "—")}</td><td><span class="chip muted">${esc(e.action)}</span></td><td>${esc(e.detail)}</td></tr>`).join("") || `<tr><td colspan="4"><div class="empty-state">No events yet.</div></td></tr>`}
  </tbody></table></div>
</div>`;
  }

  function bindPrivacy(user) {
    document.getElementById("exportDataBtn").addEventListener("click", () => {
      const blob = new Blob([S.exportAll()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `therachart-backup-${todayIso()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      S.audit(user.id, "data-exported", "full backup");
    });
    document.getElementById("wipeBtn").addEventListener("click", () => {
      const m = showModal(`<h2>Erase all data?</h2>
        <p style="font-size:13.5px">This permanently removes every patient, document, and schedule from this device and restores the demo seed data.</p>
        <div class="modal-actions"><button class="btn" id="wCancel">Cancel</button>
        <button class="btn danger" id="wOk">Erase everything</button></div>`);
      m.querySelector("#wCancel").addEventListener("click", closeModal);
      m.querySelector("#wOk").addEventListener("click", () => {
        S.wipeAll();
        closeModal();
        location.hash = "#/dashboard";
        render();
      });
    });
  }

  /* ================= FACILITY ADMIN ================= */

  function facilityView(user) {
    const st = S.settings();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `
<div class="page-head"><div><h1>Facility Admin</h1><div class="sub">Settings and staff licenses</div></div></div>
<div class="cards-2">
  <div class="card">
    <h2>Facility settings</h2>
    <div class="field"><label>Facility name</label><input id="st-name" value="${esc(st.facilityName)}" /></div>
    <div class="field-row">
      <div class="field"><label>Progress report every N visits</label><input id="st-prog" type="number" min="1" max="30" value="${st.progressEvery}" /></div>
      <div class="field"><label>Slot length (minutes)</label><input id="st-slot" type="number" min="15" max="120" step="5" value="${st.slotMinutes}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Day starts (hour)</label><input id="st-start" type="number" min="5" max="12" value="${st.dayStartHour}" /></div>
      <div class="field"><label>Day ends (hour)</label><input id="st-end" type="number" min="13" max="22" value="${st.dayEndHour}" /></div>
    </div>
    <div class="field"><label>Open days</label>
      <div style="display:flex; gap:10px; flex-wrap:wrap">${days.map((d, i) => `
        <label style="display:flex; gap:4px; align-items:center; font-size:13px">
        <input type="checkbox" class="st-day" value="${i}" ${st.workDays.includes(i) ? "checked" : ""}/>${d}</label>`).join("")}
      </div>
    </div>
    <div class="field" style="border-top:1px solid var(--border); padding-top:12px">
      <label style="display:flex; gap:8px; align-items:center; font-size:13px">
        <input type="checkbox" id="st-audio" ${st.audioReview ? "checked" : ""}/>
        Allow temporary session-audio review</label>
      <div style="font-size:12px; color:var(--muted); margin:4px 0 8px">Off by default. When on, Google Cloud dictation audio is kept — <b>only for patients who consent</b> — so a clinician can re-check the transcript, then it's auto-deleted when the note is signed or after the window below. Audio is never kept long-term. See Privacy &amp; Security.</div>
      <div class="field" style="max-width:220px"><label>Auto-delete kept audio after (days)</label><input id="st-audio-days" type="number" min="1" max="90" value="${st.audioReviewDays || 7}" /></div>
    </div>
    <button class="btn primary" id="stSave">Save settings</button>
  </div>
  <div class="card">
    <h2>Staff &amp; licenses</h2>
    <p style="font-size:12.5px; color:var(--muted)">An expired license or voided access automatically blocks the EMR and document signing for that account. New employees get a temporary password and must set their own at first login.</p>
    <details style="margin:6px 0 14px">
      <summary style="cursor:pointer; font-weight:600; font-size:13px">+ Add employee</summary>
      <div style="border:1px solid var(--border); border-radius:10px; padding:12px; margin-top:8px">
        <div class="field-row">
          <div class="field"><label>Full name</label><input id="nu-name" placeholder="e.g. Ana Reyes, PT" /></div>
          <div class="field"><label>Role</label><select id="nu-role">
            <option value="therapist">Therapist</option><option value="admin">Administrator</option><option value="frontdesk">Front desk</option>
          </select></div>
        </div>
        <div class="field-row" id="nu-license-row">
          <div class="field"><label>License number</label><input id="nu-lic-num" placeholder="PT-…" /></div>
          <div class="field"><label>License expires</label><input id="nu-lic-exp" type="date" /></div>
        </div>
        <div class="field"><label>Temporary password (min 8 — they'll change it at first login)</label>
          <div style="display:flex; gap:8px"><input id="nu-pw" type="text" autocomplete="off" style="flex:1" /><button class="btn small" id="nu-gen" type="button">Generate</button></div></div>
        <button class="btn primary small" id="nu-add">Create employee</button>
        <div id="nu-msg" style="font-size:12.5px; min-height:18px; margin-top:6px"></div>
      </div>
    </details>
    ${S.users().map((u) => `
      <div style="border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:10px">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
          <b>${esc(u.name)}</b> <span class="chip muted">${esc(roleLabel(u))}</span>
          ${!u.active ? '<span class="chip bad">voided</span>' : S.licenseExpired(u) ? '<span class="chip bad">expired</span>' : S.licenseExpiresSoon(u) ? '<span class="chip warn">expiring soon</span>' : u.license ? '<span class="chip good">active</span>' : ""}
          ${u.mustChangePassword ? '<span class="chip warn">must set password</span>' : ""}
        </div>
        ${u.license ? `<div class="field-row" style="margin-top:8px">
          <div class="field" style="margin-bottom:4px"><label>License number</label><input data-lic-num="${u.id}" value="${esc(u.license.number)}" /></div>
          <div class="field" style="margin-bottom:4px"><label>Expires</label><input data-lic-exp="${u.id}" type="date" value="${esc(u.license.expires)}" /></div>
        </div>` : ""}
        <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap">
          <button class="btn small" data-save-user="${u.id}">Save</button>
          <button class="btn small ${u.active ? "danger" : ""}" data-toggle-user="${u.id}">${u.active ? "Void access" : "Restore access"}</button>
          <button class="btn small" data-reset-user="${u.id}">Reset password</button>
          ${u.id !== user.id ? `<button class="btn small danger" data-delete-user="${u.id}">Delete</button>` : ""}
        </div>
        <div class="user-msg" data-msg="${u.id}" style="font-size:12px; min-height:16px; margin-top:4px"></div>
      </div>`).join("")}
  </div>
</div>`;
  }

  function bindFacility(user) {
    document.getElementById("stSave").addEventListener("click", () => {
      S.updateSettings({
        facilityName: document.getElementById("st-name").value.trim() || "TheraChart Clinic",
        progressEvery: Math.max(1, Number(document.getElementById("st-prog").value) || 5),
        slotMinutes: Math.max(15, Number(document.getElementById("st-slot").value) || 45),
        dayStartHour: Number(document.getElementById("st-start").value) || 8,
        dayEndHour: Number(document.getElementById("st-end").value) || 17,
        workDays: [...document.querySelectorAll(".st-day:checked")].map((c) => Number(c.value)),
        audioReview: document.getElementById("st-audio").checked,
        audioReviewDays: Math.min(90, Math.max(1, Number(document.getElementById("st-audio-days").value) || 7)),
      }, user);
      render();
    });
    document.querySelectorAll("[data-save-user]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.saveUser;
        const num = document.querySelector(`[data-lic-num="${id}"]`);
        const exp = document.querySelector(`[data-lic-exp="${id}"]`);
        const patch = {};
        if (num && exp) patch.license = { number: num.value.trim(), expires: exp.value };
        S.updateUser(id, patch, user);
        render();
      })
    );
    document.querySelectorAll("[data-toggle-user]").forEach((b) =>
      b.addEventListener("click", () => {
        const u = S.getUser(b.dataset.toggleUser);
        S.updateUser(u.id, { active: !u.active }, user);
        render();
      })
    );

    // ---- employee management (create / reset password / delete) ----
    const genTempPw = () => {
      const a = new Uint8Array(9);
      (window.crypto && window.crypto.getRandomValues) ? window.crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256)));
      return btoa(String.fromCharCode(...a)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    };
    const T = window.TheraSync || {};
    const roleSel = document.getElementById("nu-role");
    if (roleSel) roleSel.addEventListener("change", () => {
      document.getElementById("nu-license-row").style.display = roleSel.value === "frontdesk" ? "none" : "";
    });
    const genBtn = document.getElementById("nu-gen");
    if (genBtn) genBtn.addEventListener("click", () => { document.getElementById("nu-pw").value = genTempPw(); });
    const addBtn = document.getElementById("nu-add");
    if (addBtn) addBtn.addEventListener("click", async () => {
      const msg = document.getElementById("nu-msg");
      const fail = (t) => { msg.style.color = "var(--danger)"; msg.textContent = t; };
      const role = document.getElementById("nu-role").value;
      const fields = {
        name: document.getElementById("nu-name").value.trim(),
        role,
        password: document.getElementById("nu-pw").value,
        license: role === "frontdesk" ? null : { number: document.getElementById("nu-lic-num").value.trim(), expires: document.getElementById("nu-lic-exp").value },
      };
      if (!fields.name) return fail("Enter a name.");
      if ((fields.password || "").length < 8) return fail("Temporary password must be at least 8 characters (use Generate).");
      msg.style.color = "var(--muted)"; msg.textContent = "Creating…"; addBtn.disabled = true;
      const r = T.addUser ? await T.addUser(fields) : S.addUser(fields, user);
      addBtn.disabled = false;
      if (r.error) return fail(r.error);
      render();
    });

    const userMsg = (id, text, ok) => { const el = document.querySelector(`[data-msg="${id}"]`); if (el) { el.style.color = ok ? "var(--good)" : "var(--danger)"; el.textContent = text; } };
    document.querySelectorAll("[data-reset-user]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.resetUser;
        const temp = genTempPw();
        b.disabled = true; userMsg(id, "Resetting…", true);
        const err = T.resetPassword ? await T.resetPassword(id, temp) : (S.setPassword(id, temp, user, { mustChange: true }).error || null);
        b.disabled = false;
        if (err) return userMsg(id, err, false);
        userMsg(id, `Temporary password: ${temp} — share it securely; they'll be asked to change it at next login.`, true);
      })
    );
    document.querySelectorAll("[data-delete-user]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.deleteUser;
        if (!confirm(`Delete ${S.getUser(id) ? S.getUser(id).name : "this employee"}? Their login is removed. Their signed documents and audit history stay intact.`)) return;
        b.disabled = true;
        const err = T.deleteUser ? await T.deleteUser(id) : (S.deleteUser(id, user).error || null);
        if (err) { b.disabled = false; return userMsg(id, err, false); }
        render();
      })
    );
  }

  /* ================= PROFILE ================= */

  function profileView(user) {
    return `
<div class="page-head"><div><h1>My Profile</h1></div></div>
<div class="cards-2">
  <div class="card">
    <h2>Therapist information</h2>
    <table class="list"><tbody>
      <tr><td style="color:var(--muted)">Name</td><td>${esc(user.name)}</td></tr>
      <tr><td style="color:var(--muted)">Role</td><td>${esc(roleLabel(user))}</td></tr>
      ${user.license ? `
      <tr><td style="color:var(--muted)">License number</td><td class="num">${esc(user.license.number)}</td></tr>
      <tr><td style="color:var(--muted)">License expires</td><td class="num">${fmtDate(user.license.expires)}
        ${S.licenseExpired(user) ? '<span class="chip bad">expired</span>' : S.licenseExpiresSoon(user) ? '<span class="chip warn">expiring soon</span>' : '<span class="chip good">valid</span>'}</td></tr>` : ""}
      <tr><td style="color:var(--muted)">Account status</td><td>${user.active ? '<span class="chip good">active</span>' : '<span class="chip bad">voided</span>'}</td></tr>
    </tbody></table>
    ${S.licenseExpired(user) ? `<div class="banner bad" style="margin-top:12px">Your license has expired — EMR access and document creation/editing are disabled until an administrator updates it.</div>` : ""}
  </div>
  <div class="card">
    <h2>Change password</h2>
    <div class="field"><label>Current password</label><input id="curPw" type="password" autocomplete="current-password" /></div>
    <div class="field"><label>New password (at least 8 characters)</label><input id="newPw" type="password" autocomplete="new-password" /></div>
    <div class="field"><label>Confirm new password</label><input id="confPw" type="password" autocomplete="new-password" /></div>
    <button class="btn" id="pwSave">Update password</button>
    <div id="pwMsg" style="font-size:12.5px; min-height:18px; margin-top:6px"></div>
  </div>
</div>`;
  }

  function bindProfile(user) {
    const btn = document.getElementById("pwSave");
    btn.addEventListener("click", async () => {
      const cur = document.getElementById("curPw").value;
      const nw = document.getElementById("newPw").value;
      const cf = document.getElementById("confPw").value;
      const msg = document.getElementById("pwMsg");
      const fail = (t) => { msg.style.color = "var(--danger)"; msg.textContent = t; };
      if (nw.length < 8) return fail("New password must be at least 8 characters.");
      if (nw !== cf) return fail("New passwords don't match.");
      msg.style.color = "var(--muted)"; msg.textContent = "Updating…"; btn.disabled = true;
      const err = await window.TheraSync.changePassword({ currentPassword: cur, newPassword: nw });
      btn.disabled = false;
      if (err) return fail(err);
      msg.style.color = "var(--good)"; msg.textContent = "Password updated.";
      ["curPw", "newPw", "confPw"].forEach((id) => (document.getElementById(id).value = ""));
    });
  }

  /* ================= boot ================= */

  window.TheraRender = render; // the sync layer re-renders after remote pulls
  window.addEventListener("hashchange", () => { render(); });
  // remember scroll position per screen so Back returns you where you were
  window.addEventListener("scroll", () => { scrollMem[location.hash || "#/dashboard"] = window.scrollY; }, { passive: true });
  render();
})();
