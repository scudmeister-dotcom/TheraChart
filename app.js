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
  const todayIso = () => new Date().toISOString().slice(0, 10);
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
  };

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
<svg viewBox="0 0 200 460" xmlns="http://www.w3.org/2000/svg" data-view="${view}">
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
    { hash: "#/dashboard", label: "Dashboard", icon: ICON.dash, emr: true },
    { hash: "#/patients", label: "Patients", icon: ICON.people, emr: true },
    { hash: "#/calendar", label: "Calendar", icon: ICON.cal, emr: true },
    { hash: "#/privacy", label: "Privacy & Security", icon: ICON.shield, emr: false },
    { hash: "#/facility", label: "Facility Admin", icon: ICON.gear, emr: true, adminOnly: true },
    { hash: "#/profile", label: "My Profile", icon: ICON.user, emr: false },
  ];

  function render() {
    if (activeDictation) { activeDictation.stop(); activeDictation = null; }
    closeModal();
    const user = S.currentUser();
    if (!user) return renderLogin();

    const hash = location.hash || "#/dashboard";
    const emrAllowed = S.canAccessEmr(user);
    const route = hash.split("/")[1] || "dashboard";

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

  function renderShell(hash, content, user, bind) {
    const emrAllowed = S.canAccessEmr(user);
    const links = NAV.filter((n) => !n.adminOnly || user.role === "admin")
      .map((n) => {
        const disabled = n.emr && !emrAllowed;
        const active = hash.startsWith(n.hash) ||
          (n.hash === "#/patients" && /^(#\/patient\/|#\/intake|#\/doc\/)/.test(hash));
        return `<a class="nav-link ${active ? "active" : ""} ${disabled ? "disabled" : ""}" href="${n.hash}">${n.icon}${n.label}</a>`;
      }).join("");

    app.innerHTML = `
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">T</div>
      <div><b>TheraChart</b><small>${esc(S.settings().facilityName)}</small></div>
    </div>
    ${links}
    <div class="spacer"></div>
    <div class="userchip">
      <div class="avatar">${esc(initials(user.name))}</div>
      <div class="who"><b>${esc(user.name)}</b><small>${esc(roleLabel(user))}</small></div>
      <button id="logoutBtn" title="Sign out">Out</button>
    </div>
  </aside>
  <main class="content" id="view">${content}</main>
</div>`;
    document.getElementById("logoutBtn").addEventListener("click", () => {
      S.logout();
      render();
    });
    if (bind) bind(user);
  }

  const roleLabel = (u) =>
    u.role === "therapist" ? "Physical Therapist" : u.role === "frontdesk" ? "Front Desk" : "Administrator";

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

  function renderLogin() {
    const users = S.users();
    app.innerHTML = `
<div class="login-wrap">
  <div class="login-box">
    <div class="brandline">
      <div class="logo">T</div>
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
        <label for="pinInput">PIN</label>
        <input id="pinInput" type="password" inputmode="numeric" autocomplete="off" placeholder="Enter your PIN" />
      </div>
      <button class="btn primary" id="loginBtn" style="width:100%; justify-content:center">Sign in</button>
      <div class="error" id="loginErr" style="color:var(--danger); font-size:13px; min-height:18px; margin-top:8px"></div>
      <div class="demo-note">Demo accounts — PIN is <b>1234</b> for everyone. Records stay on this device only.</div>
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
    ${S.canDocument(user) || user.role === "frontdesk" ? `<a class="btn" href="#/intake">+ New patient intake</a>` : ""}
    <a class="btn primary" href="#/patients">Open patients</a>
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
          <td>${esc(d.title)}<br><small style="color:var(--muted)">${esc(S.patientName(S.getPatient(d.patientId)))}</small></td>
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
        <td><b>${esc(d.title)}</b></td>
        <td>${d.status === "signed" ? '<span class="chip good">signed & locked</span>' : '<span class="chip warn">draft</span>'}${d.amendments.length ? ` <span class="chip info">${d.amendments.length} amendment${d.amendments.length > 1 ? "s" : ""}</span>` : ""}</td>
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
        <button class="btn small" data-newdoc="daily">+ Daily note</button>
        <button class="btn small" data-newdoc="eval">+ Evaluation</button>
        <button class="btn small ${due ? "primary" : ""}" data-newdoc="progress">+ Progress report${due ? " (due)" : ""}</button>
        <button class="btn small" data-newdoc="discharge">+ Discharge</button>
      </div>` : `<div class="banner warn" style="margin-bottom:12px">Your account can view this chart but cannot create or edit clinical documents.</div>`}
      ${docs.length ? `<div class="table-scroll"><table class="list"><thead><tr><th>Document</th><th>Status</th><th>Therapist</th><th>Date</th></tr></thead>
        <tbody>${docs.slice().reverse().map(docRow).join("")}</tbody></table></div>`
        : `<div class="empty-state">No documents yet.${canDoc ? " Start with an <b>Evaluation</b>." : ""}</div>`}
    </div>
    <div class="card">
      <h2>Referrals, imaging & other files</h2>
      ${p.attachments.length ? `<table class="list"><tbody>${p.attachments.map((a) => `
        <tr><td><b>${esc(a.name)}</b><br><small style="color:var(--muted)">added ${fmtDT(a.uploadedAt)} by ${esc((S.getUser(a.uploadedBy) || {}).name || "—")}</small></td>
        <td style="text-align:right"><a class="btn small" href="${a.dataUrl}" download="${esc(a.name)}">Download</a></td></tr>`).join("")}</tbody></table>`
        : `<div class="empty-state">No files yet — add the physician referral, X-rays, or other documents.</div>`}
      <div style="margin-top:10px">
        <label class="btn small" style="position:relative; overflow:hidden">
          Upload file<input id="fileUpload" type="file" style="position:absolute; inset:0; opacity:0; cursor:pointer" />
        </label>
        <small style="color:var(--muted); margin-left:8px">Stored on this device only · up to ~1.5 MB per file</small>
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
    if (up) up.addEventListener("change", () => {
      const f = up.files[0];
      if (!f) return;
      if (f.size > 1.5 * 1024 * 1024) return alertBanner("File is too large for on-device storage (limit ~1.5 MB).");
      const reader = new FileReader();
      reader.onload = () => {
        p.attachments.push({
          id: S.uid("a"), name: f.name, type: f.type,
          dataUrl: reader.result, uploadedBy: user.id, uploadedAt: new Date().toISOString(),
        });
        S.save();
        S.audit(user.id, "attachment-added", `${f.name} → ${S.patientName(p)}`);
        render();
      };
      reader.readAsDataURL(f);
    });

    const pr = document.getElementById("printChartBtn");
    if (pr) pr.addEventListener("click", () => printPatientChart(p));
  }

  function alertBanner(msg) {
    const m = showModal(`<h2>Notice</h2><p style="font-size:14px">${esc(msg)}</p>
      <div class="modal-actions"><button class="btn primary" id="okBtn">OK</button></div>`);
    m.querySelector("#okBtn").addEventListener("click", closeModal);
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
    const view = document.getElementById("view");
    if (!doc) { view.innerHTML = `<div class="card"><div class="empty-state">Document not found.</div></div>`; return; }
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
<div class="page-head">
  <div>
    <h1>${esc(doc.title)}</h1>
    <div class="sub"><a href="#/patient/${p.id}">${esc(S.patientName(p))}</a> · created ${fmtDT(doc.createdAt)} by ${esc((S.getUser(doc.createdBy) || {}).name || "—")}</div>
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
  <div class="card">
    ${sections}
    ${sigBlock}
  </div>
  <div class="card">
    <h2>Dictation &amp; body map</h2>
    <div class="dict-bar">
      <button class="mic-btn" id="micBtn" ${editable ? "" : "disabled"}><span>🎤</span><span id="micLabel">Listen</span></button>
      <select id="langSel" title="Speech language">
        <option value="en-US">English</option>
        <option value="fil-PH">Tagalog / Filipino</option>
        <option value="ceb-PH">Cebuano</option>
      </select>
    </div>
    <div class="dict-bar">
      <select id="engineSel" title="Transcription engine — compare them yourself">
        <option value="browser">Engine: Browser (Google servers)</option>
        <option value="whisper">Engine: Private — Whisper on clinic server</option>
      </select>
      <span class="dict-status" id="dictStatus">${editable ? "Mic off" : "Locked"}</span>
    </div>
    <div class="figures">
      <figure><figcaption>Front <span class="hint">(patient's L on your right)</span></figcaption><div class="bodymap" id="mapFront">${figureMarkup("front")}</div></figure>
      <figure><figcaption>Back</figcaption><div class="bodymap" id="mapBack">${figureMarkup("back")}</div></figure>
    </div>
    <div class="map-notes" id="mapNotes"></div>
    <h3 style="margin-top:12px">Transcript <span style="font-weight:400; color:var(--muted); font-size:11px">saved with this note — click a finding to see its source</span></h3>
    <div class="transcript-log" id="docTranscript"></div>
    <div class="interim-bar"><b>Hearing:</b><span id="interim">…</span></div>
    ${editable ? `<div class="measure-add"><input id="typedDictation" placeholder="No mic? Type what the patient says and press Enter…" /></div>` : ""}
    <div class="route-log" id="routeLog"></div>
  </div>
</div>`;

    // ------- shared dictation/map state -------
    const dstate = { selectedKey: null };
    drawAllPoints(doc);
    drawMapNotes(doc, dstate);
    drawTranscript(doc);
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

  function drawAllPoints(doc) {
    ["front", "back"].forEach((v) => { const l = layerFor(v); if (l) l.innerHTML = ""; });
    (doc.data.mapPoints || []).forEach((pt, i) => drawPoint(doc, pt, i + 1));
  }

  function drawPoint(doc, pt, num) {
    const svgNS = "http://www.w3.org/2000/svg";
    const layer = layerFor(pt.view);
    if (!layer) return;
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "point-group");
    g.dataset.key = pt.key;
    const mk = (tag, attrs) => {
      const e = document.createElementNS(svgNS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    const ring = mk("circle", { class: "point-ring", cx: pt.x, cy: pt.y, r: 10 });
    const dot = mk("circle", { class: "point-dot", cx: pt.x, cy: pt.y, r: 8 });
    const num2 = mk("text", { class: "point-num", x: pt.x, y: pt.y });
    num2.textContent = num;
    const title = document.createElementNS(svgNS, "title");
    const latest = pt.notes[pt.notes.length - 1];
    title.textContent = `${pt.side ? cap(pt.side) + " " : ""}${pt.part}${latest ? " — " + latest.summary : ""}`;
    dot.appendChild(title);
    g.append(ring, dot, num2);
    g.addEventListener("click", () => selectMapPoint(doc, pt.key));
    layer.appendChild(g);
  }

  function drawMapNotes(doc, dstate) {
    const box = document.getElementById("mapNotes");
    if (!box) return;
    const pts = doc.data.mapPoints || [];
    box.innerHTML = pts.length ? pts.map((pt, i) => `
      <div class="map-note ${dstate && dstate.selectedKey === pt.key ? "selected" : ""}" data-key="${esc(pt.key)}">
        <b><span class="badge">${i + 1}</span>${esc(pt.side ? cap(pt.side) + " " : "")}${esc(pt.part)}</b>
        ${pt.notes.map((n) => `<div>· ${esc(n.summary)} ${n.quote ? `<span class="quote">“${esc(n.quote)}”</span>` : ""}</div>`).join("")}
      </div>`).join("")
      : `<div class="empty-state" style="padding:8px">Body areas the patient mentions will be pinned here automatically.</div>`;
    box.querySelectorAll(".map-note").forEach((el) =>
      el.addEventListener("click", () => selectMapPoint(doc, el.dataset.key))
    );
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
    drawTranscript(doc, marksByUtt);
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

  function drawTranscript(doc, marksByUtt) {
    const box = document.getElementById("docTranscript");
    if (!box) return;
    const t = doc.data.transcript || [];
    box.innerHTML = t.length ? t.map((u, i) => `
      <div class="utt" data-utt="${i}"><span class="utt-time">${esc(u.time)}</span>
      <span class="utt-text">${uttHtml(u.text, marksByUtt ? marksByUtt.get(i) : null)}</span></div>`).join("")
      : `<div class="empty-state" style="padding:8px">Everything said while listening is saved here, word for word.</div>`;
    if (!marksByUtt) box.scrollTop = box.scrollHeight;
  }

  /* ---- dictation + routing ---- */

  const TREAT_RE = /\b(performed|completed|exercis\w*|therex|sets?|reps?|ultrasound|massage|stretch\w*|mobilizat\w*|manual therapy|gait|ice|heat|e-?stim\w*|modalit\w*|educat\w*|hep|home program|tens)\b/i;

  /* Two interchangeable transcription engines, so clinics can compare:
     - "browser": the Web Speech API (fast, streams audio to the browser
       vendor's servers — on Chrome, Google)
     - "whisper": records locally, converts to 16 kHz WAV in the page, and
       sends segments to the clinic server's self-hosted Whisper. Audio never
       leaves the clinic. Segments queue in order — if the server is slow
       (CPU-only), the transcript simply arrives late; nothing is dropped. */

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
        onStatus("This speech language isn't supported here — try the Whisper engine or another device.", listening);
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

  const WHISPER_LANG = { "en-US": "en", "fil-PH": "tl", "ceb-PH": "auto" };

  function whisperEngine({ lang, onText, onInterim, onStatus }) {
    let ctx = null, stream = null, proc = null, listening = false;
    let seg = [], voicedMs = 0, silenceMs = 0, segMs = 0;
    const queue = [];
    let uploading = false, pending = 0, stopped = false;

    const status = () => {
      if (!listening && !pending) return;
      const q = pending ? ` — transcribing ${pending} segment${pending > 1 ? "s" : ""}…` : "";
      onStatus((listening ? "Listening (private, on clinic server)" : "Finishing up") + q, listening);
    };

    function cut(force) {
      const dur = segMs;
      const samples = seg;
      seg = []; voicedMs = 0; silenceMs = 0; segMs = 0;
      if (!samples.length || voicedTotal(samples) === 0) return;
      if (!force && dur < 900) return;
      const flat = new Float32Array(samples.reduce((n, a) => n + a.length, 0));
      let off = 0;
      for (const a of samples) { flat.set(a, off); off += a.length; }
      queue.push(encodeWav(flat, ctx ? ctx.sampleRate : 16000));
      pump();
    }
    // rough check that a segment contains any speech-level audio at all
    function voicedTotal(samples) {
      let n = 0;
      for (const a of samples) for (let i = 0; i < a.length; i += 160) if (Math.abs(a[i]) > 0.015) n++;
      return n;
    }

    async function pump() {
      if (uploading) return;
      uploading = true;
      while (queue.length) {
        pending = queue.length;
        status();
        const wav = queue.shift();
        try {
          const token = (window.TheraSync || {}).token;
          const res = await fetch(`/api/transcribe?lang=${WHISPER_LANG[lang()] || "auto"}`, {
            method: "POST",
            headers: { "content-type": "audio/wav", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: wav,
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.text) onText(data.text);
          else if (!res.ok) onStatus(data.error || `Transcription error (${res.status})`, listening);
        } catch (e) {
          onStatus("Clinic server unreachable — segment kept, retrying…", listening);
          queue.unshift(wav);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      pending = 0;
      uploading = false;
      status();
      if (!listening) onStatus("Mic off — all segments transcribed.", false);
    }

    return {
      name: "whisper",
      pending: () => pending + queue.length,
      async start() {
        stopped = false;
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
        stopped = true;
        if (queue.length || pending) status();
        else onStatus("Mic off", false);
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

    const sync = window.TheraSync || { mode: "local" };
    const whisperAvailable = sync.mode === "server" && sync.whisper;
    const whisperOpt = engineSel.querySelector('option[value="whisper"]');
    if (!whisperAvailable) {
      whisperOpt.disabled = true;
      whisperOpt.textContent = sync.mode === "server"
        ? "Engine: Whisper — not installed on clinic server"
        : "Engine: Whisper — needs the clinic server";
    }
    let engineChoice = localStorage.getItem("therachart-engine") || "browser";
    if (engineChoice === "whisper" && !whisperAvailable) engineChoice = "browser";
    engineSel.value = engineChoice;

    let listening = false;
    const callbacks = {
      lang: () => langSel.value,
      onText: (text) => routeUtterance(doc, user, text, dstate),
      onInterim: (t) => { interimEl.textContent = t ? t + " …" : "…"; },
      onStatus: (msg, isListening) => { statusEl.textContent = msg; if (isListening === false && !listening) setUI(); },
    };

    let engine = null;
    function makeEngine() {
      engine = engineChoice === "whisper" ? whisperEngine(callbacks) : browserEngine(callbacks);
      if (!engine) {
        statusEl.textContent = whisperAvailable
          ? "Browser speech not supported here — switch the engine to Whisper."
          : "Speech not supported in this browser — type into the dictation box instead.";
      }
      window.__theraDict = engine; // test hook
    }
    makeEngine();

    const setUI = () => {
      micBtn.classList.toggle("listening", listening);
      micLabel.textContent = listening ? "Stop" : "Listen";
      if (!listening && engine && engine.pending() === 0) statusEl.textContent = "Mic off";
      if (listening) {
        statusEl.textContent = engineChoice === "whisper"
          ? "Listening (private, on clinic server)"
          : `Listening… (${langSel.selectedOptions[0].text}, via browser/Google)`;
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
      if (engine && listening) { engine.stop(); listening = false; }
      engineChoice = engineSel.value;
      localStorage.setItem("therachart-engine", engineChoice);
      makeEngine();
      if (wasListening && engine) { listening = true; Promise.resolve(engine.start()); }
      setUI();
    });

    activeDictation = {
      stop() { if (engine) engine.stop(); listening = false; },
    };
  }

  function appendField(doc, field, sentence) {
    const cur = (doc.data[field] || "").trim();
    doc.data[field] = cur ? cur + (cur.endsWith(".") ? " " : ". ") + sentence : sentence;
    const t = document.querySelector(`textarea[data-field="${field}"]`);
    if (t) t.value = doc.data[field];
  }

  function routeUtterance(doc, user, raw, dstate) {
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
      appendField(doc, field, cap(parsed.text));
      routed.push(`text → ${fieldLabel(doc.type, field)}`);
    }

    S.updateDocData(doc.id, doc.data, user);
    drawAllPoints(doc);
    drawMapNotes(doc, dstate);
    drawTranscript(doc);
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

  /* ---- sign & amend ---- */

  function signModal(doc, user) {
    const pending = window.__theraDict && window.__theraDict.pending ? window.__theraDict.pending() : 0;
    const m = showModal(`
<h2>E-sign &amp; lock — ${esc(doc.title)}</h2>
${pending ? `<div class="banner warn">△ ${pending} dictated segment${pending > 1 ? "s are" : " is"} still being transcribed — wait for them to land before signing, or they will need an amendment.</div>` : ""}
<p style="font-size:13px; color:var(--muted)">Signing certifies this documentation is accurate and complete. The document will lock; later changes require a signed amendment with an authorization reason.</p>
<div class="field"><label>Type your full registered name (${esc(user.name)})</label><input id="sigName" autocomplete="off" /></div>
<div class="field"><label>PIN</label><input id="sigPin" type="password" inputmode="numeric" autocomplete="off" /></div>
<div class="error" id="sigErr"></div>
<div class="modal-actions">
  <button class="btn" id="sigCancel">Cancel</button>
  <button class="btn primary" id="sigOk">✒ Sign &amp; lock</button>
</div>`);
    m.querySelector("#sigCancel").addEventListener("click", closeModal);
    m.querySelector("#sigOk").addEventListener("click", () => {
      const err = m.querySelector("#sigErr");
      if (m.querySelector("#sigPin").value !== user.pin) { err.textContent = "Incorrect PIN."; return; }
      const res = S.signDoc(doc.id, user, m.querySelector("#sigName").value, "");
      if (res.error) { err.textContent = res.error; return; }
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
<div class="field"><label>PIN</label><input id="amPin" type="password" autocomplete="off" /></div>
<div class="error" id="amErr"></div>
<div class="modal-actions">
  <button class="btn" id="amCancel">Cancel</button>
  <button class="btn primary" id="amOk">✒ Sign amendment</button>
</div>`);
    m.querySelector("#amCancel").addEventListener("click", closeModal);
    m.querySelector("#amOk").addEventListener("click", () => {
      const err = m.querySelector("#amErr");
      if (m.querySelector("#amPin").value !== user.pin) { err.textContent = "Incorrect PIN."; return; }
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
    const slots = S.slotsForDay(calDate);
    const appts = S.apptsOn(calDate);
    const cols = calTherapist === "all" ? ths : ths.filter((t) => t.id === calTherapist);

    const grid = slots.length ? `
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
    return d.toISOString().slice(0, 10);
  };

  function bookingModal(user, slot, therId) {
    const pats = S.patients().slice().sort((a, b) => (a.lastName < b.lastName ? -1 : 1));
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
    return `
<div class="page-head">
  <div><h1>Privacy &amp; Security</h1><div class="sub">How TheraChart keeps patient information protected</div></div>
</div>
<div class="cards-3">
  <div class="card">
    <h2>🔐 Where your records live</h2>
    <p style="font-size:13px">${window.TheraSync && window.TheraSync.mode === "server"
      ? "This device is synced with <b>your clinic's own server</b> — a machine your facility controls, on your network. Records are shared between your clinic's devices and never touch a third-party cloud."
      : "All patient records, documents, schedules, and transcripts are stored <b>only in this device's local storage</b>. Run the included clinic server (<code>node server.js</code>) to share records between your clinic's devices — still entirely on hardware you control, never a third-party cloud."}</p>
    <div style="display:flex; gap:8px; flex-wrap:wrap">
      <button class="btn small" id="exportDataBtn">Export backup (JSON)</button>
      <button class="btn small danger" id="wipeBtn">Erase all data</button>
    </div>
  </div>
  <div class="card">
    <h2>🎙 Voice dictation, honestly</h2>
    <p style="font-size:13px">Browser dictation (the Web Speech API) typically sends <b>audio to the browser vendor's servers</b> for transcription — on Chrome that is Google. Google states dictation audio is used only to return the transcript, but there is <b>no healthcare data agreement (HIPAA BAA / RA 10173 outsourcing agreement)</b> behind the free browser API, so treat spoken PHI as leaving your control during dictation.</p>
    <p style="font-size:13px; margin-bottom:0"><b>The private option is built in:</b> switch the engine to <b>Whisper on the clinic server</b> in any note's dictation bar — audio is transcribed on your own machine and deleted, never reaching a third party (requires <code>pip install faster-whisper</code> on the server). The browser/Google engine remains available so you can compare accuracy yourself. This app never stores audio with either engine.</p>
  </div>
  <div class="card">
    <h2>🛡 Access controls</h2>
    <ul style="font-size:13px; margin:0; padding-left:18px; line-height:1.8">
      <li>PIN sign-in with role-based access (therapist / front desk / admin)</li>
      <li>Voided accounts cannot sign in; expired licenses lose EMR &amp; documentation access automatically</li>
      <li>Signed documents lock; edits require an e-signed, authorized amendment</li>
      <li>Every access-relevant action is recorded in the audit log below</li>
    </ul>
  </div>
</div>
<div class="card">
  <h2>Compliance note</h2>
  <p style="font-size:13px; margin:0">This is an on-device demonstration build. Before storing real patient data, deploy TheraChart against your compliance requirements — in the Philippines, the <b>Data Privacy Act of 2012 (RA 10173)</b>; in the US, <b>HIPAA</b>. A production deployment would add encrypted storage, per-user credentials, and consented reminder messaging.</p>
</div>
<div class="card">
  <h2>Audit log <span style="font-weight:400; color:var(--muted); font-size:12px">most recent 100 events</span></h2>
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
    <button class="btn primary" id="stSave">Save settings</button>
  </div>
  <div class="card">
    <h2>Staff &amp; licenses</h2>
    <p style="font-size:12.5px; color:var(--muted)">An expired license or voided access automatically blocks the EMR and document signing for that account.</p>
    ${S.users().map((u) => `
      <div style="border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:10px">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
          <b>${esc(u.name)}</b> <span class="chip muted">${esc(roleLabel(u))}</span>
          ${!u.active ? '<span class="chip bad">voided</span>' : S.licenseExpired(u) ? '<span class="chip bad">expired</span>' : S.licenseExpiresSoon(u) ? '<span class="chip warn">expiring soon</span>' : u.license ? '<span class="chip good">active</span>' : ""}
        </div>
        ${u.license ? `<div class="field-row" style="margin-top:8px">
          <div class="field" style="margin-bottom:4px"><label>License number</label><input data-lic-num="${u.id}" value="${esc(u.license.number)}" /></div>
          <div class="field" style="margin-bottom:4px"><label>Expires</label><input data-lic-exp="${u.id}" type="date" value="${esc(u.license.expires)}" /></div>
        </div>` : ""}
        <div style="display:flex; gap:8px; margin-top:6px">
          <button class="btn small" data-save-user="${u.id}">Save</button>
          <button class="btn small ${u.active ? "danger" : ""}" data-toggle-user="${u.id}">${u.active ? "Void access" : "Restore access"}</button>
        </div>
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
    <h2>Change PIN</h2>
    <div class="field"><label>New PIN (4–6 digits)</label><input id="newPin" type="password" inputmode="numeric" /></div>
    <button class="btn" id="pinSave">Update PIN</button>
    <div id="pinMsg" style="font-size:12.5px; color:var(--good); min-height:18px; margin-top:6px"></div>
  </div>
</div>`;
  }

  function bindProfile(user) {
    document.getElementById("pinSave").addEventListener("click", () => {
      const v = document.getElementById("newPin").value.trim();
      if (!/^\d{4,6}$/.test(v)) { document.getElementById("pinMsg").textContent = "PIN must be 4–6 digits."; return; }
      S.updateUser(user.id, { pin: v }, user);
      document.getElementById("pinMsg").textContent = "PIN updated.";
      document.getElementById("newPin").value = "";
    });
  }

  /* ================= boot ================= */

  window.TheraRender = render; // the sync layer re-renders after remote pulls
  window.addEventListener("hashchange", render);
  render();
})();
