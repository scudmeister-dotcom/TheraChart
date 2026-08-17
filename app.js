/* TheraChart EMR — application shell.
   Routing, role/license gating, patient management, clinical documents with
   voice dictation + body mapping (the core feature), calendar, privacy panel.
   All data stays on this device (see store.js). */

(() => {
  "use strict";

  const S = window.TheraStore;
  const PR = window.TheraParser;
  const CL = window.TheraClinical; // billing rules, outcome measures, goals
  const VD = window.TheraValidate; // intake guardrails: phone shapes, date bounds, duplicates
  S.load();

  const app = document.getElementById("app");
  const modalRoot = document.getElementById("modalRoot");

  /* TheraChart logo — clipboard + rising bar chart + breakout arrow, with the
     spine motif. Recreated as clean SVG so it scales crisply and is truly
     transparent (no baked-in checkerboard). */
  // "Vertebrae" mark (brand handoff 1b): spine segments as a stacked data
  // column — tapering, darkening teal bars on a deep-teal tile. The tile is
  // part of the mark, so it needs no wrapper background.
  const LOGO_MARK = `<svg viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="56" height="56" rx="14" fill="#0B4F4A"/>
  <rect x="20" y="10" width="16" height="7" rx="3.5" fill="#5EEAD4"/>
  <rect x="17" y="20" width="22" height="7" rx="3.5" fill="#2DD4BF"/>
  <rect x="20" y="30" width="16" height="7" rx="3.5" fill="#14B8A6"/>
  <rect x="23" y="40" width="10" height="7" rx="3.5" fill="#0D9488"/>
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
    // compare calendar parts directly — new Date("YYYY-MM-DD") is UTC midnight,
    // which shifts the birthday a day in local time and miscounts near it
    const [y, mo, day] = String(dob).split("-").map(Number);
    if (!y) return "—";
    const n = new Date();
    let a = n.getFullYear() - y;
    if (n.getMonth() + 1 < mo || (n.getMonth() + 1 === mo && n.getDate() < day)) a--;
    return a;
  };

  const ICON = {
    // Nav icon set from the brand handoff (24×24, currentColor stroke).
    dash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M7 14l2.5 2.5L12 13l2 2 3-4"/></svg>',
    people: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    cal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="m9 12 2 2 4-4"/></svg>',
    gear: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="13" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><circle cx="12" cy="14" r="1.6"/><path d="M12 15.6V18"/></svg>',
    user: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.5L5 8l4.5 4.5"/></svg>',
    signout: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3.5A1.5 1.5 0 002 4v8a1.5 1.5 0 001.5 1.5H6M10.5 11l3-3-3-3M13 8H6"/></svg>',
    logo: LOGO_MARK,
    spark: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/></svg>',
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

  /* ================= FORM VALIDATION (shared) =================

     validate.js decides what is wrong; this decides how it is shown. Three
     pieces, used by both the intake page and the patient edit windows:

     - paintFieldMessages puts each message under the input it belongs to.
       A fourteen-field form with one line of red at the bottom makes the user
       hunt; a message under the box does not.
     - wirePhoneMasks reformats a phone as it is typed, so the shape of a
       Philippine number is taught by the field rather than by an error after
       the fact. It preserves the caret at the end, which is where it is 99%
       of the time — a full caret-mapping implementation costs more than it
       saves for a field this short.
     - Errors block. Warnings are shown, and then the same button saves. */

  const fieldWrap = (scope, inputId) => {
    const el = scope.querySelector("#" + inputId);
    return el ? el.closest(".field") : null;
  };

  function clearFieldMessages(scope) {
    scope.querySelectorAll(".field.invalid, .field.warned")
      .forEach((f) => f.classList.remove("invalid", "warned"));
    scope.querySelectorAll(".field-msg").forEach((m) => m.remove());
  }

  /* messages: { fieldKey: text }, idFor: fieldKey -> DOM id.
     Unknown keys (a field this form doesn't show) are skipped, which is what
     lets the section-edit windows validate the whole patient but only surface
     what is on screen. */
  function paintFieldMessages(scope, messages, idFor, kind) {
    let firstEl = null;
    Object.keys(messages || {}).forEach((key) => {
      const id = idFor[key];
      if (!id) return;
      const wrap = fieldWrap(scope, id);
      if (!wrap) return;
      wrap.classList.add(kind);
      const msg = document.createElement("div");
      msg.className = "field-msg";
      msg.textContent = messages[key];
      wrap.appendChild(msg);
      if (!firstEl) firstEl = scope.querySelector("#" + id);
    });
    return firstEl;
  }

  function wirePhoneMasks(scope, ids) {
    ids.forEach((id) => {
      const el = scope.querySelector("#" + id);
      if (!el) return;
      el.setAttribute("inputmode", "tel");
      el.addEventListener("input", () => {
        const atEnd = el.selectionStart === el.value.length;
        const next = VD.formatPhoneAsTyped(el.value);
        if (next === el.value) return;
        el.value = next;
        if (atEnd) el.setSelectionRange(next.length, next.length);
      });
      // Whatever survives a blur is stored in its canonical form, so a number
      // pasted from a message app is filed the same way as a typed one.
      el.addEventListener("blur", () => {
        const res = VD.checkPhone(el.value);
        if (res.ok && res.value) el.value = res.value;
      });
    });
  }

  /* The one place that turns a validation result into screen state.

     Returns "ok" (save it), "errors" (something is impossible — blocked until
     fixed) or "confirm" (only warnings; the prompt is now on screen and the
     next click on the same button should go through). Callers distinguish the
     last two, because acknowledging a warning must not be a side effect of
     having been stopped for an error.

     Only keys present in `idFor` are considered, which is what lets the
     patient edit windows validate the whole record while surfacing and
     blocking on just the section that is open. */
  function applyValidation(scope, result, idFor, opts) {
    const o = opts || {};
    clearFieldMessages(scope);
    const summary = o.summaryEl || null;
    if (summary) summary.textContent = "";
    if (o.confirmEl) o.confirmEl.innerHTML = "";

    const shown = (map) => Object.keys(map || {}).filter((k) => idFor[k]);
    const blockingKeys = shown(result.errors);

    if (blockingKeys.length) {
      const first = paintFieldMessages(scope, result.errors, idFor, "invalid");
      if (summary) {
        summary.textContent = blockingKeys.length === 1
          ? "One field needs fixing before this can be saved."
          : `${blockingKeys.length} fields need fixing before this can be saved.`;
      }
      if (first) { first.focus(); first.scrollIntoView({ block: "center", behavior: "smooth" }); }
      return "errors";
    }

    const warnKeys = shown(result.warnings);
    paintFieldMessages(scope, result.warnings, idFor, "warned");
    if (!warnKeys.length || !o.confirmEl || o.warningsAcknowledged) return "ok";

    o.confirmEl.innerHTML = `<div class="warn-confirm">
      <b>Check this before saving</b>
      <ul>${warnKeys.map((k) => `<li>${esc(result.warnings[k])}</li>`).join("")}</ul>
      Press <b>${esc(o.saveLabel || "Save")}</b> again to save anyway.</div>`;
    return "confirm";
  }

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
  let showLogin = false; // logged-out: false → marketing landing, true → login form

  const NAV = [
    // `short` is the compact label used in the mobile bottom tab bar.
    { hash: "#/dashboard", label: "Dashboard", short: "Home", icon: ICON.dash, emr: true },
    { hash: "#/patients", label: "Patients", short: "Patients", icon: ICON.people, emr: true },
    { hash: "#/calendar", label: "Calendar", short: "Calendar", icon: ICON.cal, emr: true },
    { hash: "#/privacy", label: "Privacy & Security", short: "Privacy", icon: ICON.shield, emr: false },
    { hash: "#/facility", label: "Facility Admin", short: "Admin", icon: ICON.gear, emr: true, adminOnly: true },
    { hash: "#/profile", label: "My Profile", short: "Profile", icon: ICON.user, emr: false },
  ];

  // A freshly-created draft being watched for accidental back-out: { id, snapshot }.
  // If the user leaves it untouched (see render()), it's auto-discarded.
  let pristineDraft = null;

  function render() {
    if (activeDictation) { activeDictation.stop(); activeDictation = null; window.__theraDict = null; }
    currentDocState = null; // never carry one document's edit state into another
    closeModal();
    const user = S.currentUser();
    // Logged-out visitors land on the marketing page first; the Sign-in CTA
    // flips to the login form. A deep link into an app route skips the splash.
    if (!user) {
      const deepLink = location.hash && location.hash !== "#/" && location.hash !== "#/welcome";
      return (showLogin || deepLink) ? renderLogin() : renderLanding();
    }
    // New hires and admin-reset accounts must set their own password before doing anything.
    if (user.mustChangePassword) return renderForcePassword(user);

    // Auto-discard a just-created draft the user backed out of without touching
    // it — i.e. the document was opened by accident. Only fires when navigating
    // AWAY from that draft, and only if its content is byte-for-byte the pristine
    // freshly-created state (any edit or dictation keeps it).
    if (pristineDraft) {
      const goingToDoc = location.hash.startsWith("#/doc/") ? location.hash.split("/")[2] : null;
      if (goingToDoc !== pristineDraft.id) {
        const d = S.getDoc(pristineDraft.id);
        if (d && d.status === "draft" && JSON.stringify(d.data) === pristineDraft.snapshot) S.deleteDoc(pristineDraft.id, user);
        pristineDraft = null;
      }
    }

    const hash = location.hash || "#/dashboard";
    const emrAllowed = S.canAccessEmr(user);
    const route = (hash.split("/")[1] || "dashboard").split("?")[0];

    const emrRoutes = ["dashboard", "patients", "intake", "patient", "doc", "drafts", "calendar", "facility"];
    if (!emrAllowed && emrRoutes.includes(route)) return renderShell(hash, blockedView(user), user);

    if (route === "dashboard") return renderShell(hash, dashboardView(user), user, bindDashboard);
    if (route === "drafts") return renderShell(hash, draftsView(user), user, bindDrafts);
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

  /* Brief branded splash shown right after a successful sign-in — the logo,
     product name and facility, held for a beat before the app appears. It's a
     standard "welcome" moment; kept short so it never feels like a wait. The
     app renders underneath while the splash fades, so the reveal is the app. */
  function showSplash(done) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const el = document.createElement("div");
    el.className = "splash";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", "Signing in");
    el.innerHTML = `
      <div class="splash-inner">
        <div class="splash-logo">${LOGO_MARK}</div>
        <div class="splash-name">TheraChart EMR</div>
        <div class="splash-sub">${esc(S.currentClinicName())}</div>
        <div class="splash-bar"><span></span></div>
      </div>`;
    document.body.appendChild(el);
    // Next frame so the fade-in transition actually runs from opacity 0.
    requestAnimationFrame(() => el.classList.add("show"));

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      done(); // render the app underneath, so the fade-out reveals it — not the login screen
      el.classList.add("leaving");
      let removed = false;
      const remove = () => { if (removed) return; removed = true; el.remove(); };
      el.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 500); // backstop if transitionend never fires
    };
    // Reduced-motion users get a much shorter hold and no animation flourish.
    setTimeout(finish, reduce ? 350 : 1500);
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
    } else if (route === "drafts") trail.push({ label: "Unsigned drafts", hash: "#/drafts" });
    else if (route === "calendar") trail.push({ label: "Calendar", hash: "#/calendar" });
    else if (route === "privacy") trail.push({ label: "Privacy & Security", hash: "#/privacy" });
    else if (route === "facility") trail.push({ label: "Facility Admin", hash: "#/facility" });
    else if (route === "profile") trail.push({ label: "My Profile", hash: "#/profile" });
    return trail;
  }

  function renderShell(hash, content, user, bind) {
    const emrAllowed = S.canAccessEmr(user);
    // the patient assistant drawer is available whenever a patient chart is open
    const drawerPid = /^#\/patient\//.test(hash) ? (hash.split("/")[2] || "").split("?")[0] : null;
    if (assistantFor !== drawerPid) { assistantOpen = false; assistantFor = drawerPid; }
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

    // --- mobile bottom bar: the three main workflow destinations as a
    //     segmented pill slider, with a highlight that slides to where we are.
    const primaryNav = NAV.filter((n) => ["#/dashboard", "#/patients", "#/calendar"].includes(n.hash));
    const isTabActive = (n) => hash.startsWith(n.hash) ||
      (n.hash === "#/patients" && /^#\/(patient\/|intake|doc\/)/.test(hash));
    const activeTabIdx = primaryNav.findIndex(isTabActive);
    const tabbar = `
      <nav class="tabbar" style="--tab-count:${primaryNav.length}; --tab-index:${activeTabIdx < 0 ? 0 : activeTabIdx}">
        <span class="tab-pill ${activeTabIdx < 0 ? "hidden" : ""}" aria-hidden="true"></span>
        ${primaryNav.map((n) => {
          const disabled = n.emr && !emrAllowed;
          return `<a class="tab ${isTabActive(n) ? "active" : ""} ${disabled ? "disabled" : ""}" href="${n.hash}">
            <span class="tab-ico">${n.icon}</span><span class="tab-label">${n.short}</span></a>`;
        }).join("")}
      </nav>`;

    // --- account menu: the pages that aren't part of the moment-to-moment
    //     workflow (Privacy, Admin, Profile) live here, opened from the avatar.
    const acctNav = NAV.filter((n) => ["#/privacy", "#/facility", "#/profile"].includes(n.hash))
      .filter((n) => !(n.adminOnly && user.role !== "admin"))
      .filter((n) => !(n.emr && !emrAllowed));
    const acctMenuHtml = `
      <div class="acct-menu" id="acctMenu" role="menu" aria-hidden="true">
        <div class="acct-menu-head">
          <div class="avatar">${esc(initials(user.name))}</div>
          <div><b>${esc(user.name)}</b><small>${esc(roleLabel(user))}</small></div>
        </div>
        ${acctNav.map((n) => `<a class="acct-item" role="menuitem" href="${n.hash}"><span class="acct-ico">${n.icon}</span>${esc(n.label)}</a>`).join("")}
        <button class="acct-item danger" id="acctLogout" role="menuitem" type="button"><span class="acct-ico">${ICON.signout}</span>Sign out</button>
      </div>`;

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
    <div class="sidebar-inner">
      <div class="brand">
        <div class="logo">${ICON.logo}</div>
        <div class="brand-text"><b>Thera<em>Chart</em></b><span>Clinic EMR</span></div>
      </div>
      <span class="topbar-sync" id="topSyncDot" title="Sync status" aria-label="Sync status">●</span>
      <div class="nav">${nav}${drawerPid ? `<div class="nav-group sidebar-context">
        <div class="nav-group-label">This patient</div>
        <button class="nav-link nav-btn" id="assistantLaunch" type="button"><span class="nav-ico">${ICON.spark}</span><span class="nav-label">Ask about patient</span></button>
      </div>` : ""}</div>
      <div class="spacer"></div>
      <div class="userchip">
        <button class="avatar avatar-btn" id="acctBtn" type="button" aria-haspopup="menu" aria-expanded="false" title="Account">${esc(initials(user.name))}</button>
        <div class="who"><b>${esc(user.name)}</b><small>${esc(roleLabel(user))}</small></div>
        <button id="logoutBtn" class="signout" title="Sign out">${ICON.signout}</button>
      </div>
      ${acctMenuHtml}
    </div>
  </aside>
  <main class="content ${drawerPid ? "patient-bg" : ""}" id="view">${crumbBar}<div id="viewBody">${content}</div></main>
  ${tabbar}
  ${drawerPid ? `
  <div class="assistant-backdrop" id="asstBackdrop"></div>
  <aside class="assistant-drawer" id="assistantDrawer" aria-hidden="true" aria-label="Patient assistant">
    <div class="assistant-drawer-head">
      <b>${ICON.spark} Patient assistant</b>
      <button class="drawer-close" id="asstClose" type="button" title="Close" aria-label="Close">✕</button>
    </div>
    <div class="asst-card assistant-drawer-body" id="patientAssistant"></div>
  </aside>` : ""}
</div>`;
    document.getElementById("logoutBtn").addEventListener("click", () => { S.logout(); render(); });

    // account menu (Privacy / Admin / Profile / Sign out), opened from the avatar
    const acctBtn = document.getElementById("acctBtn");
    const acctMenu = document.getElementById("acctMenu");
    if (acctBtn && acctMenu) {
      const setOpen = (open) => {
        acctMenu.classList.toggle("open", open);
        acctBtn.setAttribute("aria-expanded", open ? "true" : "false");
        acctMenu.setAttribute("aria-hidden", open ? "false" : "true");
        // only listen for outside clicks while open — no listener accumulation
        if (open) document.addEventListener("click", onDocClick);
        else document.removeEventListener("click", onDocClick);
      };
      function onDocClick(e) {
        if (!acctMenu.contains(e.target) && !acctBtn.contains(e.target)) setOpen(false);
      }
      acctBtn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!acctMenu.classList.contains("open")); });
      acctMenu.querySelectorAll("a.acct-item").forEach((a) => a.addEventListener("click", () => setOpen(false)));
      const acctLogout = document.getElementById("acctLogout");
      if (acctLogout) acctLogout.addEventListener("click", () => { S.logout(); render(); });
    }
    // paint the top-bar sync dot with the live connection state
    if (window.TheraSync && window.TheraSync.refreshBadge) window.TheraSync.refreshBadge();
    const back = document.getElementById("crumbBack");
    if (back) back.addEventListener("click", () => { location.hash = crumbs[crumbs.length - 2].hash; });
    if (bind) bind(user);
    if (drawerPid) wireAssistantDrawer(drawerPid, user);
    restoreScroll(hash);
  }

  /* Mounts the patient assistant into the left drawer and wires its launchers.
     Open state + conversation persist across re-renders (see module state). */
  function wireAssistantDrawer(patientId, user) {
    const drawer = document.getElementById("assistantDrawer");
    const backdrop = document.getElementById("asstBackdrop");
    const body = document.getElementById("patientAssistant");
    if (!drawer || !backdrop) return;
    if (body) renderAssistant(body, patientId, user, { persistKey: patientId });

    const setOpen = (open) => {
      assistantOpen = open;
      drawer.classList.toggle("open", open);
      backdrop.classList.toggle("open", open);
      drawer.setAttribute("aria-hidden", open ? "false" : "true");
      if (open) { const inp = drawer.querySelector("#asstInput"); if (inp) inp.focus(); }
    };
    [document.getElementById("assistantLaunch"), document.getElementById("assistantLaunchM")]
      .forEach((b) => b && b.addEventListener("click", () => setOpen(true)));
    const close = document.getElementById("asstClose");
    if (close) close.addEventListener("click", () => setOpen(false));
    backdrop.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", function esc(e) {
      if (!document.getElementById("assistantDrawer")) return document.removeEventListener("keydown", esc);
      if (e.key === "Escape" && assistantOpen) setOpen(false);
    });
    setOpen(assistantOpen); // restore open state across tab-switch re-renders
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


  function renderForcePassword(user) {
    app.innerHTML = `
<div class="login-wrap">
  <div class="login-box">
    <div class="brandline">
      <div class="logo">${LOGO_MARK}</div>
      <div><h1>TheraChart EMR</h1><div class="sub">${esc(S.currentClinicName())}</div></div>
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

  function renderLanding() {
    const facility = esc(S.currentClinicName());
    const feature = (icon, title, body) => `
      <div class="lp-feature">
        <div class="lp-feature-ico">${icon}</div>
        <h3>${title}</h3>
        <p>${body}</p>
      </div>`;
    app.innerHTML = `
<div class="landing">
  <header class="lp-nav">
    <div class="brandline">
      <div class="logo">${LOGO_MARK}</div>
      <div><b>TheraChart</b><span class="lp-nav-sub">EMR</span></div>
    </div>
    <button class="btn primary" id="lpSignIn">Sign in</button>
  </header>

  <section class="lp-hero">
    <div class="lp-hero-copy">
      <div class="lp-eyebrow">Physical therapy EMR · built for the clinic floor</div>
      <h1>Chart by voice.<br>Map the body.<br><span class="lp-accent">Trust the record.</span></h1>
      <p class="lp-lead">Press listen and just talk. TheraChart pins what the patient says to a body map, files ROM, strength and pain into the right fields, and keeps the full transcript — in <b>English, Tagalog, and Cebuano</b>. Then ask its AI assistant anything about the patient, answered <b>only</b> from that patient's own chart.</p>
      <div class="lp-cta">
        <button class="btn primary lp-cta-btn" id="lpStart">Sign in to get started</button>
        <button class="btn ghost lp-cta-btn" data-open-walkthrough type="button">See how it works</button>
      </div>
      <div class="lp-trust">🔒 Records live in your clinic's own cloud project — not a shared vendor database. Dictation audio is transcribed and discarded, and Google's Vertex AI terms bar using your data to train its models.</div>
    </div>
    <div class="lp-hero-shot">
      <img src="marketing-screenshots/walkthrough/05-dictation-body-map.jpg" alt="TheraChart dictation and body map" loading="lazy" />
    </div>
  </section>

  <section class="lp-features" id="features">
    <h2 class="lp-section-title">Everything a session needs — in one flow</h2>
    <div class="lp-feature-grid">
      ${feature("🎤", "Voice-first dictation", "Speak naturally. Findings pin to the body map and measurements sort themselves into ROM, MMT, special tests and pain — no typing between patients.")}
      ${feature("🗺️", "Body-mapped findings", "Every symptom lands on a front/back body map with severity, so the whole picture is visible at a glance — and carries onto the printed chart as a labelled list of findings.")}
      ${feature("🌐", "Multilingual", "Understands English, Tagalog and Cebuano — including the Taglish code-switching real patients actually use.")}
      ${feature("✦", "Grounded AI assistant", "Ask about a patient's history, trends or precautions. Answers are drawn strictly from that patient's records — it cites its sources and says so when something isn't documented.")}
      ${feature("📈", "Clinical insights", "Cross-visit connections, ROM/pain trends and red flags surfaced as decision support for a licensed PT — never a diagnosis.")}
      ${feature("🛡️", "Privacy by design", "Your own database, walled off per clinic. E-signed notes that lock, amendments that are authorised and audited, and a plain-English page naming exactly which data leaves the clinic and where it goes.")}
    </div>
  </section>

  <section class="lp-shots">
    <div class="lp-shot"><img src="marketing-screenshots/walkthrough/02-patient-overview.jpg" alt="Patient chart overview" loading="lazy" /><span>Everything that needs attention on one patient, before you open a single note.</span></div>
    <div class="lp-shot"><img src="marketing-screenshots/walkthrough/01-dashboard.jpg" alt="Clinic dashboard" loading="lazy" /><span>Clinic-wide view: today's schedule, unsigned drafts and progress reports due.</span></div>
  </section>

  <section class="lp-final">
    <h2>Ready when you are.</h2>
    <p>Sign in with the credentials your administrator gave you.</p>
    <button class="btn primary lp-cta-btn" id="lpStart2">Sign in</button>
    <div class="lp-foot">TheraChart EMR · ${facility}</div>
  </section>
</div>
${walkthroughMarkup()}`;
    const go = () => { showLogin = true; render(); };
    ["lpSignIn", "lpStart", "lpStart2"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", go);
    });
    bindWalkthrough();
  }

  /* ================= "SEE HOW IT WORKS" WALKTHROUGH =================

     A guided tour of real screenshots, opened from the landing page. It exists
     because the hard part of selling this isn't explaining features — it's
     showing a clinic that already has a workflow why they'd change it. So every
     step is framed as "what you do now" against "what happens here", and each
     one points at the actual screen where it lives.

     The images are captured from the running app rather than mocked up, so a
     stale screenshot is a bug we can see rather than a promise we can't keep.
     They are numbered by step because a visit genuinely is a sequence.

     Nothing here claims a feature the product doesn't have — the AI review,
     the 8-minute rule, the authorisation counter and the audit log are all
     shown in their own screens, from seeded clinical data. */

  const WALKTHROUGH = [
    {
      shot: "05-dictation-body-map",
      title: "Talk through the visit. It writes the note.",
      now: "You finish the session, then type the note up afterwards — usually after hours, usually from memory.",
      here: "Press <b>Listen</b> and speak the way you already speak, in English, Tagalog or Taglish. What the patient says goes in their words; what you observe is filed as your findings. The body area they mention gets pinned to the map automatically.",
      where: "Inside any note · <b>Dictation &amp; body map</b>, top left",
    },
    {
      shot: "06-measurements-filed",
      title: "Measurements sort themselves into the right rows.",
      now: "ROM and strength go on a paper form, then get copied into the note, then copied again into the progress report.",
      here: 'Say <i>"right shoulder abduction 90 degrees, external rotation 45, deltoid strength 4 over 5"</i> and all three land as separate, labelled measurements — joint, motion, side and value — without you naming the joint twice.',
      where: "Inside any note · <b>Objective measurements</b>, right column",
    },
    {
      shot: "07-ai-review",
      title: "A second read before you sign.",
      now: "Nobody checks the note. Whatever you typed at 8pm is what the payer sees.",
      here: "Ask for a clean-up and it reorganises the transcript, proposes the findings, and tidies the wording. <b>You approve every line</b> — speaker labels, findings, section text. Nothing enters the chart until you accept it and sign.",
      where: "Inside any note · <b>✦ Review &amp; clean up with AI</b>",
    },
    {
      shot: "02-patient-overview",
      title: "The chart remembers, so you don't have to.",
      now: "\"How is this patient actually doing?\" means flipping back through months of paper and comparing numbers by eye.",
      here: "One screen: what needs attention today, goals against their target dates, outcome scores trended across the episode, and allergies on a banner that follows you into every screen of the chart.",
      where: "Any patient · <b>Overview</b> tab",
    },
    {
      shot: "08-billing",
      title: "The units are counted for you.",
      now: "Someone works out timed units by hand against the 8-minute rule, and a miscount is either lost revenue or a claim problem.",
      here: "Enter the interventions and minutes. TheraChart computes what the units <i>should</i> be and flags a mismatch instead of silently billing whatever was typed. The signature, licence number and timestamp lock to the note.",
      where: "Inside any note · <b>Billing — CPT codes, minutes and units</b>",
    },
    {
      shot: "04-patient-info",
      title: "Authorisation you can see before the visit, not after.",
      now: "Nobody notices the HMO approval ran out until the claim is rejected — months later, when the money is already spent.",
      here: "Visits authorised, visits used and the expiry date sit on the patient's chart and count down as they attend. Provider, member ID and approval reference are all in one place when the claim has to be filed.",
      where: "Any patient · <b>Info</b> tab · Insurance &amp; authorisation",
    },
    {
      shot: "10-intake-guardrails",
      title: "Front desk can't fat-finger a patient in.",
      now: "A mistyped mobile number isn't found until someone tries to phone about a cancelled slot.",
      here: "Phone numbers format themselves as Philippine numbers as they're typed. Birth dates can't be in the future. A patient who already exists is flagged before a duplicate chart is made. Real mistakes are blocked; judgement calls are only warned about.",
      where: "<b>Patients → New patient intake</b>",
    },
    {
      shot: "11-privacy",
      title: "Who saw what, in plain language.",
      now: "Records sit in a filing cabinet or a shared folder, and there's no way to answer \"who opened this chart?\"",
      here: "Every sign-in, chart opened, note signed and amendment is recorded and searchable. The same page states plainly which company processes what data and where — the disclosure the Data Privacy Act expects you to be able to make.",
      where: "<b>Privacy &amp; Security</b> in the sidebar",
    },
  ];

  function walkthroughMarkup() {
    const slides = WALKTHROUGH.map((s, i) => `
      <figure class="wt-slide ${i === 0 ? "on" : ""}" data-wt-slide="${i}" ${i === 0 ? "" : 'aria-hidden="true"'}>
        <div class="wt-shotwrap">
          <!-- data-src, not src+lazy: a lazy image inside a display:none slide
               never enters the viewport, so it never loads and the tour opens
               on a blank panel. show() assigns the real src for the current
               step and pre-loads the next one. -->
          <img data-src="marketing-screenshots/walkthrough/${s.shot}.jpg" alt="${esc(s.title)}" />
        </div>
        <figcaption class="wt-copy">
          <div class="wt-step">Step ${i + 1} of ${WALKTHROUGH.length}</div>
          <h3>${s.title}</h3>
          <div class="wt-compare">
            <div class="wt-now"><span class="wt-tag">How it works now</span><p>${s.now}</p></div>
            <div class="wt-here"><span class="wt-tag">With TheraChart</span><p>${s.here}</p></div>
          </div>
          <div class="wt-where"><span>Where it lives</span> ${s.where}</div>
        </figcaption>
      </figure>`).join("");

    return `
<div class="wt-backdrop" id="wtBackdrop" role="dialog" aria-modal="true" aria-label="How TheraChart works" hidden>
  <div class="wt-panel">
    <header class="wt-head">
      <div><b>How it works</b><span class="wt-sub">A visit, start to finish — in the real app</span></div>
      <button class="wt-close" id="wtClose" type="button" aria-label="Close">✕</button>
    </header>
    <div class="wt-stage" id="wtStage">${slides}</div>
    <footer class="wt-foot">
      <button class="btn" id="wtPrev" type="button">← Back</button>
      <div class="wt-dots" id="wtDots">${WALKTHROUGH.map((s, i) =>
        `<button class="wt-dot ${i === 0 ? "on" : ""}" data-wt-go="${i}" type="button" aria-label="Step ${i + 1}: ${esc(s.title)}"></button>`).join("")}</div>
      <button class="btn primary" id="wtNext" type="button">Next →</button>
    </footer>
  </div>
</div>`;
  }

  function bindWalkthrough() {
    const back = document.getElementById("wtBackdrop");
    if (!back) return;
    const slides = [...back.querySelectorAll("[data-wt-slide]")];
    const dots = [...back.querySelectorAll("[data-wt-go]")];
    const stage = document.getElementById("wtStage");
    let at = 0;

    // Load this step's screenshot and the next one, so paging forward is
    // instant without pulling all 2 MB the moment the tour opens.
    const load = (i) => {
      const img = slides[i] && slides[i].querySelector("img[data-src]");
      if (img) { img.src = img.dataset.src; img.removeAttribute("data-src"); }
    };

    const show = (n) => {
      at = Math.max(0, Math.min(WALKTHROUGH.length - 1, n));
      load(at); load(at + 1);
      slides.forEach((el, i) => {
        el.classList.toggle("on", i === at);
        if (i === at) el.removeAttribute("aria-hidden"); else el.setAttribute("aria-hidden", "true");
      });
      dots.forEach((d, i) => d.classList.toggle("on", i === at));
      document.getElementById("wtPrev").disabled = at === 0;
      const next = document.getElementById("wtNext");
      next.textContent = at === WALKTHROUGH.length - 1 ? "Sign in →" : "Next →";
      if (stage) stage.scrollTop = 0;
    };

    const open = () => {
      back.hidden = false;
      document.body.style.overflow = "hidden";
      show(0);
      document.getElementById("wtNext").focus();
    };
    const close = () => {
      back.hidden = true;
      document.body.style.overflow = "";
    };

    document.getElementById("wtClose").addEventListener("click", close);
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.getElementById("wtPrev").addEventListener("click", () => show(at - 1));
    document.getElementById("wtNext").addEventListener("click", () => {
      // the last step hands straight over to signing in — the whole point
      if (at === WALKTHROUGH.length - 1) { close(); showLogin = true; render(); return; }
      show(at + 1);
    });
    dots.forEach((d) => d.addEventListener("click", () => show(Number(d.dataset.wtGo))));

    document.addEventListener("keydown", (e) => {
      if (back.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") show(at + 1);
      else if (e.key === "ArrowLeft") show(at - 1);
    });

    // the landing page's "See how it works" opens this instead of jumping to an anchor
    document.querySelectorAll('[data-open-walkthrough]').forEach((el) =>
      el.addEventListener("click", (e) => { e.preventDefault(); open(); }));
  }

  function renderLogin() {
    // Test/demo accounts shown on the sign-in screen so a handful of testers can
    // log straight in. The server advertises them via /api/bootstrap (only the
    // seeded @therachart.demo accounts — never real staff); in local demo mode
    // we build the same list from the on-device roster.
    let testAccounts = (window.TheraSync && window.TheraSync.testAccounts) || [];
    if (!testAccounts.length && window.TheraSync && window.TheraSync.mode === "local") {
      // Match on the seeded ids, not the email domain: a therapist added through
      // Calendar → "+ Add PT" is saved without an email and gets an
      // @therachart.demo one, so a domain filter would list real staff here as a
      // test account with a published password. (Server mode is gated separately,
      // behind THERACHART_DEMO_LOGINS — see server.js demoLogins.)
      const seeded = new Set(S.SEEDED_DEMO_USER_IDS || []);
      testAccounts = S.users()
        .filter((u) => seeded.has(u.id) && /@therachart\.demo$/i.test(u.email || ""))
        .map((u) => ({ name: u.name, email: u.email, role: u.role, password: "1234",
          status: u.active === false ? "sign-in blocked (voided)" : "" }));
    }
    testAccounts = testAccounts.slice(0, 10); // keep the panel short
    const roleWord = (r) => r === "therapist" ? "Therapist" : r === "frontdesk" ? "Front desk" : "Admin";
    // Google sign-in appears only when the server advertises a client id.
    const googleClientId = (window.TheraSync && window.TheraSync.googleClientId) || "";
    app.innerHTML = `
<div class="login-wrap">
  <div class="login-box">
    <div class="brandline">
      <div class="logo">${LOGO_MARK}</div>
      <div>
        <h1>TheraChart EMR</h1>
        <div class="sub">${esc(S.currentClinicName())}</div>
      </div>
    </div>
    <div class="card">
      <div class="login-cardhead">
        <h2>Sign in</h2>
        <button class="btn small ghost" id="backToLanding" type="button">← Back</button>
      </div>
      <div class="field" style="margin-top:4px">
        <label for="emailInput">Email</label>
        <input id="emailInput" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="you@clinic.com" />
      </div>
      <div class="field">
        <label for="pinInput">Password</label>
        <input id="pinInput" type="password" autocomplete="current-password" placeholder="Enter your password" />
      </div>
      <button class="btn primary" id="loginBtn" style="width:100%; justify-content:center">Sign in</button>
      <div class="error" id="loginErr" style="color:var(--danger); font-size:13px; min-height:18px; margin-top:8px"></div>
      ${googleClientId ? `<div class="login-or"><span>or</span></div><div id="googleBtnWrap" class="google-btn-wrap"></div>` : ""}
      ${testAccounts.length ? `
      <div class="test-accounts">
        <div class="ta-head">Test accounts <span class="ta-pw">tap to fill · password <b>1234</b></span></div>
        <div class="ta-list">
          ${testAccounts.map((a) => `
          <button type="button" class="ta-row" data-ta-email="${esc(a.email)}" data-ta-pw="${esc(a.password || "1234")}">
            <span class="ta-avatar">${esc(initials(a.name))}</span>
            <span class="ta-main"><span class="ta-name">${esc(a.name)}</span><span class="ta-email">${esc(a.email)}</span></span>
            <span class="ta-role">${esc(roleWord(a.role))}${a.status ? `<span class="ta-status">${esc(a.status)}</span>` : ""}</span>
          </button>`).join("")}
        </div>
      </div>`
        : `<div class="demo-note">Use the email and password your administrator gave you. First time in? You'll set your own password.</div>`}
    </div>
  </div>
</div>`;
    const emailEl = document.getElementById("emailInput");
    const pinEl = document.getElementById("pinInput");
    const doLogin = async () => {
      const err = document.getElementById("loginErr");
      const email = emailEl.value.trim();
      if (!email) { err.style.color = "var(--danger)"; err.textContent = "Enter your email."; emailEl.focus(); return; }
      err.style.color = "var(--muted)"; err.textContent = "Signing in…";
      // S.login may be wrapped by the sync layer and return a promise
      const fail = await Promise.resolve(S.login(email, pinEl.value));
      if (fail) { err.style.color = "var(--danger)"; err.textContent = fail; return; }
      // A brief branded splash marks the transition, then the app appears.
      showSplash(() => { location.hash = "#/dashboard"; render(); });
    };
    document.getElementById("loginBtn").addEventListener("click", doLogin);
    [emailEl, pinEl].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); }));
    // Clicking a test account fills the form so a tester can just press Sign in.
    document.querySelectorAll(".ta-row").forEach((row) => row.addEventListener("click", () => {
      emailEl.value = row.getAttribute("data-ta-email") || "";
      pinEl.value = row.getAttribute("data-ta-pw") || "";
      const err = document.getElementById("loginErr"); if (err) err.textContent = "";
      document.getElementById("loginBtn").focus();
    }));
    const back = document.getElementById("backToLanding");
    if (back) back.addEventListener("click", () => { showLogin = false; if (location.hash && location.hash !== "#/") location.hash = "#/"; else render(); });
    if (googleClientId) mountGoogleButton(googleClientId);
    emailEl.focus();
  }

  /* Render Google's "Sign in with Google" button into the login card and wire
     its callback. On success the server verifies the returned ID token, maps the
     email to a role (allowlist), and hands back a session — then we splash into
     the app, exactly like a password sign-in. The GIS library is loaded once. */
  /* Make sure the GIS library is loaded and initialized, wherever we are in the
     app — mountGoogleButton only runs on the login card, so by the time someone
     signs a note the library may never have been initialized at all.
     Calls back with true once google.accounts.id is ready to render a button. */
  function ensureGis(clientId, cb) {
    const ready = () => !!(window.google && google.accounts && google.accounts.id);
    if (!clientId) return cb(false);
    if (ready()) return cb(true);
    if (!document.getElementById("gsiScript")) {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true; s.defer = true; s.id = "gsiScript";
      s.onload = () => cb(ready());
      s.onerror = () => cb(false);
      document.head.appendChild(s);
      return;
    }
    // script tag present but the library is still initialising
    const t = setInterval(() => { if (ready()) { clearInterval(t); cb(true); } }, 150);
    setTimeout(() => { clearInterval(t); if (!ready()) cb(false); }, 5000);
  }

  /** Does this account sign in with Google (and so have no password to re-enter)? */
  const isGoogleAccount = (u) => !!u && u.authProvider === "google" && !u.passwordHash && !u.pin;

  /* Render a Google button inside a modal that yields a FRESH id token and
     verifies it against the signed-in account server-side. This is how a
     Google user re-authenticates to e-sign: they have no password, so
     /api/verify-password can never pass for them.
     onResult receives { ok } or { ok:false, error }. */
  function mountGoogleReauth(el, onResult) {
    const clientId = (window.TheraSync && window.TheraSync.googleClientId) || "";
    el.textContent = "Loading Google…";
    ensureGis(clientId, (ok) => {
      if (!ok) {
        el.innerHTML = '<div class="banner warn" style="margin:0">Couldn\'t load Google sign-in, so this signature can\'t be confirmed right now. Check your connection and reopen this dialog.</div>';
        return;
      }
      google.accounts.id.initialize({
        client_id: clientId,
        callback: async (resp) => {
          el.textContent = "Confirming with Google…";
          const r = await window.TheraSync.verifyGoogle(resp.credential);
          onResult(r);
        },
      });
      el.innerHTML = "";
      google.accounts.id.renderButton(el, { theme: "outline", size: "large", text: "continue_with", width: 280 });
    });
  }

  function mountGoogleButton(clientId) {
    const onCredential = async (resp) => {
      const err = document.getElementById("loginErr");
      if (err) { err.style.color = "var(--muted)"; err.textContent = "Signing in with Google…"; }
      const fail = await window.TheraSync.googleLogin(resp.credential);
      if (fail) { if (err) { err.style.color = "var(--danger)"; err.textContent = fail; } return; }
      showSplash(() => { location.hash = "#/dashboard"; render(); });
    };
    const draw = () => {
      const wrap = document.getElementById("googleBtnWrap");
      if (!wrap || !(window.google && google.accounts && google.accounts.id)) return false;
      google.accounts.id.initialize({ client_id: clientId, callback: onCredential });
      wrap.innerHTML = "";
      google.accounts.id.renderButton(wrap, { theme: "outline", size: "large", text: "signin_with", width: 320 });
      return true;
    };
    if (draw()) return;
    if (!document.getElementById("gsiScript")) {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true; s.defer = true; s.id = "gsiScript";
      s.onload = draw;
      document.head.appendChild(s);
    } else {
      // tag present but library still initialising — poll briefly, then give up
      const t = setInterval(() => { if (draw()) clearInterval(t); }, 150);
      setTimeout(() => clearInterval(t), 5000);
    }
  }

  /* ================= DASHBOARD ================= */

  function dashboardView(user) {
    const patients = S.patients();
    const due = patients.filter((p) => S.progressDue(p.id));
    const drafts = S.documents().filter((d) => d.status === "draft");
    const todays = S.apptsOn(todayIso()).sort((a, b) => (a.start < b.start ? -1 : 1));
    const expSoon = S.staff().filter((u) => u.active && S.licenseExpiresSoon(u));
    const upcoming = S.appointments().filter((a) => a.status === "booked" && a.start >= new Date().toISOString()).length;

    // A single "needs attention" list for the whole clinic — same organizing
    // idea as the patient chart's Overview, so the important things surface
    // instead of being spread across banners.
    const attn = [];
    expSoon.forEach((u) => attn.push({ level: "warn", text: `${u.name} — license ${u.license.number} expires ${fmtDate(u.license.expires)}`, href: "#/facility", action: "Staff" }));
    due.forEach((p) => attn.push({ level: "warn", text: `${S.patientName(p)} — progress report due (${S.visitCount(p.id)} visits)`, href: `#/patient/${p.id}`, action: "Open chart" }));
    if (drafts.length) attn.push({ level: "info", text: `${drafts.length} unsigned draft${drafts.length > 1 ? "s" : ""} across the clinic`, href: "#/drafts", action: "Review" });

    const tile = (num, label, href, accent) => {
      const inner = `<div class="stat-num">${num}</div><div class="stat-label">${label}</div>`;
      return href ? `<a class="stat-tile ${accent && num ? "accent" : ""}" href="${href}">${inner}</a>`
        : `<div class="stat-tile ${accent && num ? "accent" : ""}">${inner}</div>`;
    };

    return `
<div class="page-head">
  <div><h1>Good day, ${esc(user.name.split(",")[0].split(" ")[0])}</h1>
  <div class="sub">${fmtDate(new Date().toISOString())} · ${esc(S.currentClinicName())}</div></div>
</div>

<div class="stat-tiles">
  ${tile(patients.length, "Patients on file", "#/patients", false)}
  ${tile(todays.length, "Visits today", "#/calendar", false)}
  ${tile(drafts.length, "Unsigned drafts", "#/drafts", true)}
  ${tile(due.length, "Progress reports due", null, true)}
</div>

<div class="card">
  <h2>Needs attention</h2>
  ${attn.length ? `<div class="attn-list">${attn.map((it) => `
    <a class="attn-item ${it.level}" href="${it.href}">
      <span class="attn-dot"></span>
      <span class="attn-text">${esc(it.text)}</span>
      <span class="attn-go">${esc(it.action)} →</span>
    </a>`).join("")}</div>`
    : `<div class="empty-state" style="padding:12px">✓ Nothing outstanding — licenses current, progress reports up to date.</div>`}
</div>

<div class="cards-2">
  <div class="card">
    <h2>Today's schedule</h2>
    ${todays.length ? `<div class="table-scroll"><table class="list"><thead><tr><th>Time</th><th>Patient</th><th>Therapist</th></tr></thead><tbody>
      ${todays.map((a) => `<tr class="rowlink" data-href="#/patient/${a.patientId}">
        <td class="num">${fmtTime(a.start)}</td>
        <td>${esc(S.patientName(S.getPatient(a.patientId)))}</td>
        <td>${esc((S.getUser(a.therapistId) || {}).name || "—")}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty-state">No visits scheduled today. <a href="#/calendar">Open the calendar</a> to book one.</div>`}
  </div>
  <div class="card">
    <h2>Unsigned drafts</h2>
    ${drafts.length
      ? `<a class="jumbo-link" href="#/drafts">
           <div><b>${drafts.length} draft${drafts.length > 1 ? "s" : ""} waiting</b><small>Review and sign across the clinic</small></div>
           <span class="jumbo-arrow">→</span>
         </a>`
      : `<div class="empty-state">Everything is signed. ✓</div>`}
  </div>
</div>`;
  }

  function bindDashboard() { bindRowLinks(); }

  /* ================= UNSIGNED DRAFTS (clinic-wide) ================= */

  const draftFilter = { type: "all", therapist: "all", patient: "all", from: "", to: "" };

  function draftsView(user) {
    const all = S.documents()
      .filter((d) => d.status === "draft")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first

    // dropdown options built only from who/what actually has drafts
    const therapistOpts = [...new Map(all.map((d) => [d.createdBy, (S.getUser(d.createdBy) || {}).name || d.createdBy])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));
    const patientOpts = [...new Map(all.map((d) => [d.patientId, S.patientName(S.getPatient(d.patientId))])).entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1));

    const f = draftFilter;
    const drafts = all.filter((d) =>
      (f.type === "all" || d.type === f.type) &&
      (f.therapist === "all" || d.createdBy === f.therapist) &&
      (f.patient === "all" || d.patientId === f.patient) &&
      (!f.from || d.createdAt.slice(0, 10) >= f.from) &&
      (!f.to || d.createdAt.slice(0, 10) <= f.to));

    const typeChip = (val, label) => `<button class="fchip ft-type ft-${val} ${f.type === val ? "on" : ""}" data-dtype="${val}">${val === "all" ? "" : '<i class="fdot"></i>'}${label}</button>`;
    const filterBar = `
      <div class="doc-filters">
        <div class="fgroup"><span class="fglabel">Type</span>
          <div class="fchips">${typeChip("all", "All")}${typeChip("eval", "Eval")}${typeChip("daily", "Daily")}${typeChip("progress", "Progress")}${typeChip("discharge", "Discharge")}</div></div>
        <div class="fgroup"><span class="fglabel">Started by</span>
          <select class="fsel" id="dTherapist"><option value="all">All therapists</option>${therapistOpts.map(([id, name]) => `<option value="${esc(id)}"${f.therapist === id ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></div>
        <div class="fgroup"><span class="fglabel">Patient</span>
          <select class="fsel" id="dPatient"><option value="all">All patients</option>${patientOpts.map(([id, name]) => `<option value="${esc(id)}"${f.patient === id ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></div>
        <div class="fgroup fgroup-date"><span class="fglabel">Date</span>
          <input type="date" class="fdate" id="dFrom" value="${f.from}" aria-label="From date" />
          <span class="fgsep">–</span>
          <input type="date" class="fdate" id="dTo" value="${f.to}" aria-label="To date" />
          <button class="btn small" id="dClear">Clear</button></div>
      </div>`;

    return `
<div class="page-head">
  <div>
    <a class="btn small back-inline" href="#/dashboard">${ICON.back} Dashboard</a>
    <h1>Unsigned drafts</h1>
    <div class="sub">${all.length} draft${all.length === 1 ? "" : "s"} across the clinic — resume, review, and sign</div>
  </div>
</div>
<div class="card">
  ${filterBar}
  ${drafts.length ? `<div class="table-scroll"><table class="list">
    <thead><tr><th>Document</th><th>Patient</th><th>Started by</th><th>Started</th><th></th></tr></thead>
    <tbody>${drafts.map((d) => `
      <tr class="rowlink" data-href="#/doc/${d.id}">
        <td><span class="doc-tag ${docMeta(d.type).cls}">${docMeta(d.type).short}</span><b>${esc(d.title)}</b></td>
        <td>${esc(S.patientName(S.getPatient(d.patientId)))}</td>
        <td>${esc((S.getUser(d.createdBy) || {}).name || "—")}</td>
        <td class="num">${fmtDate(d.createdAt)}</td>
        <td><span class="chip warn">draft</span></td>
      </tr>`).join("")}</tbody>
  </table></div>`
    : `<div class="empty-state">${all.length ? "No drafts match these filters." : "Everything is signed. ✓ No unsigned drafts across the clinic."}</div>`}
</div>`;
  }

  function bindDrafts(user) {
    bindRowLinks();
    const rerender = () => renderShell(location.hash, draftsView(user), user, bindDrafts);
    document.querySelectorAll("[data-dtype]").forEach((b) => b.addEventListener("click", () => { draftFilter.type = b.dataset.dtype; rerender(); }));
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on("dTherapist", "change", (e) => { draftFilter.therapist = e.target.value; rerender(); });
    on("dPatient", "change", (e) => { draftFilter.patient = e.target.value; rerender(); });
    on("dFrom", "change", (e) => { draftFilter.from = e.target.value; rerender(); });
    on("dTo", "change", (e) => { draftFilter.to = e.target.value; rerender(); });
    on("dClear", "click", () => { draftFilter.type = "all"; draftFilter.therapist = "all"; draftFilter.patient = "all"; draftFilter.from = ""; draftFilter.to = ""; rerender(); });
  }

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
    const ec = (k) => esc(p && p.emergencyContact ? p.emergencyContact[k] || "" : "");
    const au = (k) => esc(p && p.authorization ? (p.authorization[k] === 0 ? "" : p.authorization[k] || "") : "");
    return `
<div class="page-head">
  <div><h1>${p ? "Edit patient information" : "New patient intake"}</h1>
  <div class="sub">Completed by front desk staff — stored in your clinic's own database, not a shared vendor system</div></div>
</div>
<div class="card" style="max-width:760px">
  <h2>Personal information</h2>
  <div class="field-row">
    <div class="field"><label>First name *</label><input id="in-first" value="${v("firstName")}" /></div>
    <div class="field"><label>Last name *</label><input id="in-last" value="${v("lastName")}" /></div>
  </div>
  <div class="field-row">
    <div class="field"><label>Date of birth *</label><input id="in-dob" type="date" max="${todayIso()}" value="${v("dob")}" /></div>
    <div class="field"><label>Sex</label><select id="in-sex">
      <option value="">—</option><option ${p && p.sex === "F" ? "selected" : ""}>F</option><option ${p && p.sex === "M" ? "selected" : ""}>M</option>
    </select></div>
  </div>
  <div class="field"><label>Address</label><input id="in-address" value="${v("address")}" /></div>
  <div class="field-row">
    <div class="field"><label>Phone number *</label><input id="in-phone" value="${v("phone")}" placeholder="0917 555 0101" />
      <div class="field-hint">Mobile 0917 555 0101 · landline (02) 8123 4567 · a number from abroad starts with +</div></div>
    <div class="field"><label>Email</label><input id="in-email" type="email" value="${v("email")}" placeholder="name@example.com" /></div>
  </div>
  <div class="field"><label>Referring physician</label><input id="in-ref" value="${v("referringPhysician")}" placeholder="Name and specialty" /></div>

  <h2 style="margin-top:16px">Safety &amp; emergency contact</h2>
  <div class="field"><label>Allergies</label><input id="in-allergies" value="${v("allergies")}" placeholder="Drug, latex, adhesive… or leave blank if none known" /></div>
  <div class="field-row">
    <div class="field"><label>Emergency contact</label><input id="in-ecname" value="${ec("name")}" placeholder="Full name" /></div>
    <div class="field"><label>Relationship</label><input id="in-ecrel" value="${ec("relationship")}" placeholder="Spouse, son, friend…" /></div>
  </div>
  <div class="field"><label>Emergency contact phone</label><input id="in-ecphone" value="${ec("phone")}" placeholder="0917 555 0101" /></div>

  <h2 style="margin-top:16px">Insurance / payment</h2>
  <div class="field-row">
    <div class="field"><label>Provider</label><input id="in-prov" value="${ins("provider")}" placeholder="PhilHealth, HMO, self-pay…" /></div>
    <div class="field"><label>Member / policy ID</label><input id="in-member" value="${ins("memberId")}" /></div>
  </div>
  <div class="field"><label>Payment notes</label><input id="in-paynotes" value="${ins("notes")}" placeholder="Co-pay, approvals, etc." /></div>
  <div class="field-row">
    <div class="field"><label>Visits authorised</label><input id="in-authvisits" type="number" min="0" value="${au("visitsAuthorized")}" placeholder="e.g. 12" /></div>
    <div class="field"><label>Authorisation expires</label><input id="in-authexp" type="date" value="${au("expiresOn")}" /></div>
  </div>
  <div class="field"><label>Authorisation reference</label><input id="in-authref" value="${au("reference")}" placeholder="Approval / reference number" /></div>
  <div id="intakeWarn"></div>
  <div style="display:flex; gap:8px; margin-top:6px">
    <button class="btn primary" id="intakeSave">${p ? "Save changes" : "Register patient"}</button>
    <a class="btn" href="${p ? `#/patient/${p.id}` : "#/patients"}">Cancel</a>
  </div>
  <div class="error" id="intakeErr" style="color:var(--danger); font-size:13px; min-height:16px; margin-top:8px"></div>
</div>`;
  }

  /* Which DOM input each validate.js field key belongs to. Keeping the map
     here — rather than naming the inputs after the keys — leaves the existing
     `in-*` ids alone, and lets the patient edit windows reuse the same
     validator against a completely different set of ids. */
  const INTAKE_IDS = {
    firstName: "in-first", lastName: "in-last", dob: "in-dob", address: "in-address",
    phone: "in-phone", email: "in-email", referringPhysician: "in-ref", allergies: "in-allergies",
    ecName: "in-ecname", ecRelationship: "in-ecrel", ecPhone: "in-ecphone",
    provider: "in-prov", memberId: "in-member", paymentNotes: "in-paynotes",
    visitsAuthorized: "in-authvisits", authExpires: "in-authexp", authReference: "in-authref",
  };

  /* The same keys again for the patient edit windows, which show one section
     at a time under their own `pe-*` ids. A key missing from the map is a
     field this window doesn't show — applyValidation skips it. */
  const PERSONAL_IDS = {
    firstName: "pe-first", lastName: "pe-last", dob: "pe-dob",
    address: "pe-address", phone: "pe-phone", email: "pe-email", referringPhysician: "pe-ref",
  };
  const SAFETY_IDS = {
    allergies: "pe-allergies", ecName: "pe-ecname", ecRelationship: "pe-ecrel", ecPhone: "pe-ecphone",
  };
  const INSURANCE_IDS = {
    provider: "pe-prov", memberId: "pe-member", paymentNotes: "pe-paynotes",
    visitsAuthorized: "pe-authvisits", authExpires: "pe-authexp", authReference: "pe-authref",
  };

  function bindIntake(user) {
    const form = document.getElementById("intakeSave").closest(".card");
    const errEl = document.getElementById("intakeErr");
    wirePhoneMasks(form, ["in-phone", "in-ecphone"]);

    /* Warnings are acknowledged per attempt: any edit after the prompt appears
       re-opens the question, so "save anyway" can never be inherited by a
       different set of values than the one it was shown for. */
    let acknowledged = false;
    form.addEventListener("input", () => { acknowledged = false; });

    document.getElementById("intakeSave").addEventListener("click", () => {
      const g = (id) => document.getElementById(id).value.trim();
      const editId = (location.hash.split("?edit=")[1] || "").trim();
      const raw = {
        firstName: g("in-first"), lastName: g("in-last"), dob: g("in-dob"),
        sex: g("in-sex"), address: g("in-address"), phone: g("in-phone"),
        email: g("in-email"), referringPhysician: g("in-ref"),
        allergies: g("in-allergies"),
        emergencyContact: { name: g("in-ecname"), relationship: g("in-ecrel"), phone: g("in-ecphone") },
        insurance: { provider: g("in-prov"), memberId: g("in-member"), notes: g("in-paynotes") },
        authorization: {
          visitsAuthorized: g("in-authvisits"), expiresOn: g("in-authexp"), reference: g("in-authref"),
        },
      };
      const result = VD.validatePatient(raw, {
        today: todayIso(),
        existingPatients: S.patients(),
        patientId: editId || null,
      });
      const verdict = applyValidation(form, result, INTAKE_IDS, {
        summaryEl: errEl,
        confirmEl: document.getElementById("intakeWarn"),
        warningsAcknowledged: acknowledged,
        saveLabel: editId ? "Save changes" : "Register patient",
      });
      if (verdict === "errors") return;
      if (verdict === "confirm") { acknowledged = true; return; }

      // Store the cleaned values, not what was typed: a phone entered as
      // +63 917 555 0101 is filed as 0917 555 0101 like every other one.
      const p = editId
        ? S.updatePatient(editId, result.cleaned, user.id)
        : S.addPatient(result.cleaned, user.id);
      location.hash = `#/patient/${p.id}`;
    });
  }

  /* ---------- Patient edit: pick a section, edit it in a focused window ---------- */

  // "Edit info" first asks WHICH set of details is changing, then opens just
  // that window — so personal and insurance edits never blur together, and the
  // user is warned before discarding anything unsaved.
  function openEditChooser(p, user) {
    const m = showModal(`
      <h2>Edit patient details</h2>
      <p style="font-size:13px; color:var(--muted); margin:0 0 14px">Choose what you're changing. Nothing saves until you press Save inside that window.</p>
      <div class="edit-choice-grid">
        <button class="edit-choice" data-sec="personal" type="button">
          <span class="edit-choice-ico ec-personal">📇</span>
          <b>Personal information</b>
          <small>Name, birth date, contact, referring physician</small>
        </button>
        <button class="edit-choice" data-sec="safety" type="button">
          <span class="edit-choice-ico ec-safety">⚠️</span>
          <b>Allergies &amp; emergency contact</b>
          <small>Shown on the patient banner before anyone treats them</small>
        </button>
        <button class="edit-choice" data-sec="insurance" type="button">
          <span class="edit-choice-ico ec-insurance">💳</span>
          <b>Insurance &amp; authorisation</b>
          <small>Provider, member ID, authorised visits, expiry</small>
        </button>
      </div>
      <div class="modal-actions"><button class="btn" id="ecClose">Cancel</button></div>`);
    m.querySelector("#ecClose").addEventListener("click", closeModal);
    m.querySelectorAll("[data-sec]").forEach((b) =>
      b.addEventListener("click", () => openPatientSectionEdit(p, user, b.dataset.sec)));
  }

  function openPatientSectionEdit(p, user, section) {
    const isPersonal = section === "personal";
    const isSafety = section === "safety";
    const insur = p.insurance || {};
    const ec = p.emergencyContact || {};
    const au = p.authorization || {};
    const TITLES = { personal: "Edit personal information", safety: "Edit allergies & emergency contact", insurance: "Edit insurance & authorisation" };
    const SAVE_LABELS = { personal: "Save personal info", safety: "Save safety details", insurance: "Save insurance" };
    const SECTION_NAMES = { personal: "personal information", safety: "allergies & emergency contact", insurance: "insurance & authorisation" };
    const fieldsHtml = isPersonal ? `
      <div class="field-row">
        <div class="field"><label>First name *</label><input id="pe-first" value="${esc(p.firstName || "")}" /></div>
        <div class="field"><label>Last name *</label><input id="pe-last" value="${esc(p.lastName || "")}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Date of birth *</label><input id="pe-dob" type="date" max="${todayIso()}" value="${esc(p.dob || "")}" /></div>
        <div class="field"><label>Sex</label><select id="pe-sex">
          <option value="">—</option><option ${p.sex === "F" ? "selected" : ""}>F</option><option ${p.sex === "M" ? "selected" : ""}>M</option></select></div>
      </div>
      <div class="field"><label>Address</label><input id="pe-address" value="${esc(p.address || "")}" /></div>
      <div class="field-row">
        <div class="field"><label>Phone number *</label><input id="pe-phone" value="${esc(p.phone || "")}" placeholder="0917 555 0101" />
          <div class="field-hint">Mobile 0917 555 0101 · landline (02) 8123 4567</div></div>
        <div class="field"><label>Email</label><input id="pe-email" type="email" value="${esc(p.email || "")}" placeholder="name@example.com" /></div>
      </div>
      <div class="field"><label>Referring physician</label><input id="pe-ref" value="${esc(p.referringPhysician || "")}" /></div>`
    : isSafety ? `
      <div class="field"><label>Allergies</label>
        <input id="pe-allergies" value="${esc(p.allergies || "")}" placeholder="Drug, latex, adhesive… leave blank if none known" /></div>
      <p style="font-size:12.5px; color:var(--muted); margin:-4px 0 10px">Anything entered here shows on the patient banner, on every screen in the chart.</p>
      <div class="field-row">
        <div class="field"><label>Emergency contact</label><input id="pe-ecname" value="${esc(ec.name || "")}" placeholder="Full name" /></div>
        <div class="field"><label>Relationship</label><input id="pe-ecrel" value="${esc(ec.relationship || "")}" placeholder="Spouse, son, friend…" /></div>
      </div>
      <div class="field"><label>Emergency contact phone</label><input id="pe-ecphone" value="${esc(ec.phone || "")}" placeholder="0917 555 0101" /></div>`
    : `
      <div class="field-row">
        <div class="field"><label>Provider</label><input id="pe-prov" value="${esc(insur.provider || "")}" placeholder="PhilHealth, HMO, self-pay…" /></div>
        <div class="field"><label>Member / policy ID</label><input id="pe-member" value="${esc(insur.memberId || "")}" /></div>
      </div>
      <div class="field"><label>Payment notes</label><input id="pe-paynotes" value="${esc(insur.notes || "")}" placeholder="Co-pay, approvals, etc." /></div>
      <div class="field-row">
        <div class="field"><label>Visits authorised</label><input id="pe-authvisits" type="number" min="0" value="${au.visitsAuthorized || ""}" placeholder="e.g. 12" /></div>
        <div class="field"><label>Authorisation expires</label><input id="pe-authexp" type="date" value="${esc(au.expiresOn || "")}" /></div>
      </div>
      <div class="field"><label>Authorisation reference</label><input id="pe-authref" value="${esc(au.reference || "")}" placeholder="Approval / reference number" /></div>`;

    const m = showModal(`
      <h2>${TITLES[section] || TITLES.insurance}</h2>
      ${fieldsHtml}
      <div id="pe-warn"></div>
      <div class="error" id="pe-err" style="color:var(--danger); font-size:12.5px; min-height:16px; margin-top:6px"></div>
      <div class="modal-actions" id="pe-actions"></div>`);

    const ids = isPersonal ? ["pe-first", "pe-last", "pe-dob", "pe-sex", "pe-address", "pe-phone", "pe-email", "pe-ref"]
              : isSafety ? ["pe-allergies", "pe-ecname", "pe-ecrel", "pe-ecphone"]
                         : ["pe-prov", "pe-member", "pe-paynotes", "pe-authvisits", "pe-authexp", "pe-authref"];
    const snap = () => ids.map((id) => m.querySelector("#" + id).value).join("");
    const initial = snap();
    const isDirty = () => snap() !== initial;
    const actions = m.querySelector("#pe-actions");
    const defaultActions = `<button class="btn" id="pe-cancel">Cancel</button><button class="btn primary" id="pe-save">${SAVE_LABELS[section] || SAVE_LABELS.insurance}</button>`;

    wirePhoneMasks(m, isPersonal ? ["pe-phone"] : isSafety ? ["pe-ecphone"] : []);
    let acknowledged = false;
    m.addEventListener("input", () => { acknowledged = false; });

    const doSave = () => {
      const g = (id) => (m.querySelector("#" + id).value || "").trim();
      let edited, idFor;
      if (isPersonal) {
        idFor = PERSONAL_IDS;
        edited = { firstName: g("pe-first"), lastName: g("pe-last"), dob: g("pe-dob"), sex: g("pe-sex"),
                   address: g("pe-address"), phone: g("pe-phone"), email: g("pe-email"), referringPhysician: g("pe-ref") };
      } else if (isSafety) {
        idFor = SAFETY_IDS;
        edited = {
          allergies: g("pe-allergies"),
          emergencyContact: { name: g("pe-ecname"), relationship: g("pe-ecrel"), phone: g("pe-ecphone") },
        };
      } else {
        idFor = INSURANCE_IDS;
        edited = {
          insurance: { provider: g("pe-prov"), memberId: g("pe-member"), notes: g("pe-paynotes") },
          authorization: {
            visitsAuthorized: g("pe-authvisits"), expiresOn: g("pe-authexp"), reference: g("pe-authref"),
          },
        };
      }

      /* Validate the whole patient, not just this window: the duplicate check
         needs the name and birth date even when insurance is what's open. Only
         this section's fields are surfaced or blocked on, so a record that
         predates these rules can still have its insurance corrected without
         first being made to fix a phone number that isn't on screen. */
      const result = VD.validatePatient({ ...p, ...edited }, {
        today: todayIso(),
        existingPatients: S.patients(),
        patientId: p.id,
      });
      const verdict = applyValidation(m, result, idFor, {
        summaryEl: m.querySelector("#pe-err"),
        confirmEl: m.querySelector("#pe-warn"),
        warningsAcknowledged: acknowledged,
        saveLabel: SAVE_LABELS[section] || SAVE_LABELS.insurance,
      });
      if (verdict === "errors") return;
      if (verdict === "confirm") { acknowledged = true; return; }

      // Write back only this section, taking the cleaned values so a phone
      // corrected here is stored in the same shape as one typed at intake.
      const c = result.cleaned;
      const fields = isPersonal
        ? { firstName: c.firstName, lastName: c.lastName, dob: c.dob, sex: c.sex,
            address: c.address, phone: c.phone, email: c.email, referringPhysician: c.referringPhysician }
        : isSafety
          ? { allergies: c.allergies, emergencyContact: c.emergencyContact }
          : { insurance: c.insurance, authorization: c.authorization };

      S.updatePatient(p.id, fields, user.id);
      closeModal();
      alertBanner(`${cap(SECTION_NAMES[section] || SECTION_NAMES.insurance)} saved.`);
      renderShell(location.hash, patientView(user), user, bindPatient);
    };
    const onCancel = () => {
      if (!isDirty()) return closeModal();
      actions.innerHTML = `<div class="unsaved-warn">⚠ Unsaved changes to ${SECTION_NAMES[section] || SECTION_NAMES.insurance} won't be saved if you leave.</div>
        <button class="btn" id="pe-keep">Keep editing</button>
        <button class="btn danger" id="pe-discard">Discard changes</button>`;
      m.querySelector("#pe-discard").addEventListener("click", closeModal);
      m.querySelector("#pe-keep").addEventListener("click", () => { actions.innerHTML = defaultActions; wire(); });
    };
    const wire = () => {
      m.querySelector("#pe-cancel").addEventListener("click", onCancel);
      m.querySelector("#pe-save").addEventListener("click", doSave);
    };
    actions.innerHTML = defaultActions;
    wire();
  }

  /* ================= PATIENT CENTER ================= */

  const currentPatientId = () => (location.hash.split("/")[2] || "").split("?")[0];

  /* The patient chart is split into tabs so the busy document list isn't the
     first thing you see. Overview leads with what needs attention; the full
     document list, files, info and scheduling each get their own tab. */
  let patientTab = "overview";
  let patientTabFor = null; // the patient id the tab/filter state belongs to
  const docFilter = { type: "all", status: "all", from: "", to: "" };
  const aiReviewRuns = {}; // patientId -> true while an AI review request is in flight
  let completingItemId = null; // action item currently showing its "done + note" form

  // Patient assistant drawer (left slide-in): open state + conversation survive
  // full re-renders (tab switches) so the chat isn't lost mid-conversation.
  let assistantOpen = false;
  let assistantFor = null;   // patient id the open-state/conversation belongs to
  const assistantConvos = {}; // patientId -> [turns]

  const PATIENT_TABS = [
    { id: "overview", label: "Overview" },
    { id: "documents", label: "Documents" },
    { id: "files", label: "Files" },
    { id: "info", label: "Info" },
    { id: "schedule", label: "Schedule" },
  ];

  const NEWDOC_TYPES = [
    { type: "eval", label: "Evaluation", cls: "doc-eval" },
    { type: "daily", label: "Daily note", cls: "doc-daily" },
    { type: "progress", label: "Progress report", cls: "doc-progress" },
    { type: "discharge", label: "Discharge", cls: "doc-discharge" },
  ];

  const docRow = (d) => `
    <tr class="rowlink" data-href="#/doc/${d.id}">
      <td><span class="doc-tag ${docMeta(d.type).cls}">${docMeta(d.type).short}</span><b>${esc(d.title)}</b></td>
      <td>${d.status === "signed" ? '<span class="chip good">signed & locked</span>' : '<span class="chip warn">draft</span>'}${d.imported ? ' <span class="chip muted">imported</span>' : ""}${d.amendments.length ? ` <span class="chip info">${d.amendments.length} amendment${d.amendments.length > 1 ? "s" : ""}</span>` : ""}</td>
      <td>${esc((S.getUser(d.createdBy) || {}).name || "—")}</td>
      <td class="num">${fmtDate(d.createdAt)}</td>
    </tr>`;

  function patientView(user) {
    const p = S.getPatient(currentPatientId());
    if (!p) return `<div class="card"><div class="empty-state">Patient not found.</div></div>`;
    // reset per-patient view state when a different chart is opened
    if (patientTabFor !== p.id) {
      patientTab = "overview"; patientTabFor = p.id;
      docFilter.type = "all"; docFilter.status = "all"; docFilter.from = ""; docFilter.to = "";
      completingItemId = null;
    }
    const tab = patientTab;
    const tabStrip = `<div class="ptabs" role="tablist">
      ${PATIENT_TABS.map((t) => `<button class="ptab ${tab === t.id ? "active" : ""}" data-ptab="${t.id}" role="tab" aria-selected="${tab === t.id}">${t.label}</button>`).join("")}
    </div>`;

    const sexBits = p.sex ? ` · ${esc(p.sex)}` : "";
    // Allergies belong on the banner, not three clicks into a tab — they're
    // the one thing that has to be seen before anyone touches the patient.
    const allergyChip = (p.allergies || "").trim()
      ? `<span class="pb-chip allergy" title="${esc(p.allergies)}"><span class="pb-k">⚠ Allergies</span>${esc(p.allergies)}</span>`
      : `<span class="pb-chip"><span class="pb-k">Allergies</span>None recorded</span>`;
    return `
<div class="patient-banner">
  <div class="pb-avatar" aria-hidden="true">${esc(initials(S.patientName(p)))}</div>
  <div class="pb-id">
    <h1 class="pb-name">${esc(S.patientName(p))}</h1>
    <div class="pb-meta">
      <span class="pb-chip"><span class="pb-k">Age</span>${age(p.dob)} · ${esc(p.dob)}${sexBits}</span>
      <span class="pb-chip"><span class="pb-k">Phone</span>${esc(p.phone || "—")}</span>
      <span class="pb-chip"><span class="pb-k">Referral</span>${esc(p.referringPhysician || "—")}</span>
      ${allergyChip}
    </div>
  </div>
  <div class="pb-actions">
    <button class="btn only-mobile" id="assistantLaunchM" type="button">${ICON.spark} Ask about patient</button>
    <button class="btn" id="printChartBtn">Print / export chart (PDF)</button>
    <button class="btn" id="editInfoBtn" type="button">Edit info</button>
  </div>
</div>
${tabStrip}
<div class="ptab-panel">${patientTabContent(tab, p, user)}</div>`;
  }

  function patientTabContent(tab, p, user) {
    if (tab === "documents") return documentsPanel(p, user);
    if (tab === "files") return filesPanel(p, user);
    if (tab === "info") return infoPanel(p);
    if (tab === "schedule") return schedulePanel(p, user);
    return overviewPanel(p, user);
  }

  /* ---------- Overview: what needs attention + AI review ---------- */

  // Deterministic, instant checklist of documentation/workflow gaps.
  function needsAttention(p) {
    const items = [];
    const docs = S.docsFor(p.id);
    const drafts = docs.filter((d) => d.status === "draft");
    const today = todayIso();

    if (drafts.length) items.push({ level: "warn", text: `${drafts.length} unsigned draft${drafts.length > 1 ? "s" : ""} to finish and sign`, tab: "documents", status: "draft", action: "Review drafts" });
    if (S.progressDue(p.id)) items.push({ level: "warn", text: `Progress report due — ${S.visitCount(p.id)} visits completed`, tab: "documents", action: "Open documents" });
    const hasEval = docs.some((d) => d.type === "eval");
    if (!hasEval && docs.some((d) => d.type === "daily")) items.push({ level: "warn", text: "Daily notes on file but no initial evaluation", tab: "documents", action: "Open documents" });

    const visitToday = S.apptsOn(today).some((a) => a.patientId === p.id && a.status !== "cancelled");
    const noteToday = docs.some((d) => d.type === "daily" && d.createdAt.slice(0, 10) === today);
    if (visitToday && !noteToday) items.push({ level: "info", text: "Visit booked today — no note started yet", tab: "documents", action: "Start a note" });

    // Insurance authorisation — the clinic stops getting paid the moment this
    // runs out, and nobody notices until the claim is denied.
    const auth = S.authStatus(p);
    if (auth.expired) items.push({ level: "warn", text: `Authorisation expired ${auth.expiresOn} — ${auth.used} visits delivered`, tab: "info", action: "Open info" });
    else if (auth.exhausted) items.push({ level: "warn", text: `All ${auth.authorized} authorised visits used`, tab: "info", action: "Open info" });
    else if (auth.low) items.push({ level: "warn", text: `${auth.remaining} authorised visit${auth.remaining === 1 ? "" : "s"} left — request more`, tab: "info", action: "Open info" });

    // Goals past their target date still sitting open
    const goals = CL.goalSummary(S.goalsFor(p.id), today);
    if (goals.overdue) items.push({ level: "warn", text: `${goals.overdue} goal${goals.overdue > 1 ? "s" : ""} past the target date`, tab: "documents", action: "Open documents" });
    if (!goals.total && hasEval) items.push({ level: "info", text: "No plan-of-care goals set", tab: "documents", action: "Open documents" });

    // A signed visit with no charges never becomes a claim
    const unbilled = docs.filter((d) => d.status === "signed" && d.type !== "discharge" && !((d.data.charges || []).length));
    if (unbilled.length) items.push({ level: "warn", text: `${unbilled.length} signed note${unbilled.length > 1 ? "s have" : " has"} no billing codes`, tab: "documents", status: "signed", action: "Open documents" });

    if (!(p.attachments || []).length) items.push({ level: "info", text: "No referral or imaging files uploaded", tab: "files", action: "Add files" });

    const upcoming = S.appointments().some((a) => a.patientId === p.id && a.status === "booked" && a.start >= new Date().toISOString());
    if (!upcoming && !docs.some((d) => d.type === "discharge")) items.push({ level: "info", text: "No upcoming visits booked", tab: "schedule", action: "Book visits" });

    return items;
  }

  function overviewPanel(p, user) {
    const gaps = needsAttention(p);        // deterministic documentation / workflow gaps
    const tasks = S.actionItems(p.id);     // accepted AI recommendations + manual tasks

    // An accepted recommendation: complete it (with an optional note) or drop it.
    const taskRow = (it) => {
      if (completingItemId === it.id) {
        return `<div class="attn-item task completing" data-item="${it.id}">
            <span class="attn-dot"></span>
            <div class="task-body">
              <span class="attn-text">${esc(it.text)}</span>
              <div class="task-complete-form">
                <input type="text" id="taskNote-${it.id}" class="task-note-input" placeholder="Note (optional): what was done…" />
                <button class="btn small primary" data-complete-save="${it.id}">Save as done</button>
                <button class="btn small" data-complete-cancel="${it.id}">Cancel</button>
              </div>
            </div>
          </div>`;
      }
      return `<div class="attn-item task" data-item="${it.id}">
          <span class="attn-dot"></span>
          <span class="attn-text">${esc(it.text)}${it.source === "ai" ? ` <span class="task-tag">AI</span>` : ""}${it.rationale ? `<span class="task-why"> — ${esc(it.rationale)}</span>` : ""}</span>
          <span class="task-actions">
            <button class="btn small good" data-complete="${it.id}" title="Mark done">✓ Done</button>
            <button class="btn small ghost" data-del-item="${it.id}" title="Remove — not needed">✕</button>
          </span>
        </div>`;
    };
    const gapRow = (it) => `<div class="attn-item ${it.level}">
        <span class="attn-dot"></span>
        <span class="attn-text">${esc(it.text)}</span>
        <button class="btn small" data-goto-tab="${it.tab}"${it.status ? ` data-goto-status="${it.status}"` : ""}>${esc(it.action)}</button>
      </div>`;

    const attnBody = (tasks.length || gaps.length)
      ? `<div class="attn-list">${tasks.map(taskRow).join("")}${gaps.map(gapRow).join("")}</div>`
      : `<div class="empty-state" style="padding:12px">✓ Nothing outstanding — drafts are signed and documentation looks complete.</div>`;
    const attentionCard = `
      <div class="card">
        <div class="ins-head"><h2>Needs attention</h2></div>
        ${attnBody}
      </div>`;

    // "At a glance" quick facts
    const docs = S.docsFor(p.id);
    const last = docs.length ? docs[docs.length - 1] : null;
    const nextAppt = S.appointments()
      .filter((a) => a.patientId === p.id && a.status === "booked" && a.start >= new Date().toISOString())
      .sort((a, b) => (a.start < b.start ? -1 : 1))[0];
    const every = S.settings().progressEvery || 5;
    const toward = S.visitCount(p.id) % every;
    const auth = S.authStatus(p);
    const authRow = auth.hasAuth
      ? `<tr><td style="color:var(--muted)">Visits authorised</td><td>
          <span class="num">${auth.used}/${auth.authorized || "—"}</span>
          ${auth.exhausted ? '<span class="chip bad">exhausted</span>'
            : auth.low ? `<span class="chip warn">${auth.remaining} left</span>` : ""}
          ${auth.expired ? `<span class="chip bad">expired ${esc(auth.expiresOn)}</span>`
            : auth.expiresOn ? `<span style="color:var(--muted)"> · to ${esc(auth.expiresOn)}</span>` : ""}
        </td></tr>`
      : "";
    const glance = `
      <div class="card">
        <h2>At a glance</h2>
        <table class="list"><tbody>
          <tr><td style="color:var(--muted)">Last document</td><td>${last ? `<span class="doc-tag ${docMeta(last.type).cls}">${docMeta(last.type).short}</span> ${fmtDate(last.createdAt)}` : "—"}</td></tr>
          <tr><td style="color:var(--muted)">Next visit</td><td>${nextAppt ? fmtDT(nextAppt.start) : "None booked"}</td></tr>
          <tr><td style="color:var(--muted)">Visits documented</td><td class="num">${S.visitCount(p.id)}</td></tr>
          ${authRow}
          <tr><td style="color:var(--muted)">Toward next progress report</td><td class="num">${toward}/${every}</td></tr>
        </tbody></table>
      </div>`;

    const goalsCard = goalsOverviewCard(p);
    const outcomesCard = outcomesOverviewCard(p);

    // Recommendation history: AI recommendations (or manual tasks) that were
    // accepted and then carried out — a record of what was recommended and done.
    const history = S.careHistory(p.id).slice().reverse();
    const historyCard = history.length ? `
      <div class="card">
        <div class="ins-head"><h2>Recommendation history</h2><span class="chip muted">${history.length} completed</span></div>
        <div class="care-log">${history.map((h) => `
          <div class="care-entry">
            <span class="care-check">✓</span>
            <div class="care-main">
              <div class="care-text">${esc(h.text)}${h.source === "ai" ? ` <span class="task-tag">AI</span>` : ""}</div>
              ${h.note ? `<div class="care-note">“${esc(h.note)}”</div>` : ""}
              <div class="care-meta">Done by ${esc((S.getUser(h.completedBy) || {}).name || h.completedBy || "—")} · ${fmtDate(h.completedAt)}</div>
            </div>
          </div>`).join("")}</div>
      </div>` : "";

    // AI chart review sits after the instant checklist and quick facts; the
    // record of completed recommendations closes out the overview.
    // (The Q&A assistant lives in the left-side drawer, "Ask about patient".)
    return `${attentionCard}
      ${glance}
      ${goalsCard}
      ${outcomesCard}
      <div class="card" id="patientAiReview"></div>
      ${historyCard}`;
  }

  /* ---------- Overview cards: goals and outcome-measure trends ---------- */

  function goalsOverviewCard(p) {
    const sum = CL.goalSummary(S.goalsFor(p.id), todayIso());
    if (!sum.total) return "";
    // met goals sink to the bottom; what's overdue floats up
    const order = { overdue: 0, "due-soon": 1, "on-track": 2, "no-date": 3, met: 4, closed: 5 };
    const items = sum.items.slice().sort((a, b) => (order[a.status.state] ?? 9) - (order[b.status.state] ?? 9));
    return `
      <div class="card">
        <div class="ins-head"><h2>Plan-of-care goals</h2>
          <span class="chip ${sum.overdue ? "bad" : "muted"}">${sum.met}/${sum.total} met${sum.overdue ? ` · ${sum.overdue} overdue` : ""}</span>
        </div>
        <div class="goal-list">
          ${items.map(({ goal, status }) => `
            <div class="goal-row">
              <span class="goal-state ${status.state}">${esc(status.label)}</span>
              <div class="goal-main">
                <div class="goal-text">${esc(goal.text)}<span class="goal-term">${goal.term === "long" ? "long-term" : "short-term"}</span></div>
                ${goal.baseline || goal.target ? `<div class="goal-bt">${goal.baseline ? `from <b>${esc(goal.baseline)}</b>` : ""}${goal.baseline && goal.target ? " → " : ""}${goal.target ? `to <b>${esc(goal.target)}</b>` : ""}</div>` : ""}
              </div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  /* A sparkline plus the one number a payer asks for: did the change clear
     the tool's minimal clinically important difference? */
  function outcomesOverviewCard(p) {
    const trends = CL.outcomeTrends(S.outcomeSeries(p.id));
    if (!trends.length) return "";
    const spark = (t) => {
      if (t.n < 2) return "";
      const vals = t.points.map((x) => x.score);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const span = hi - lo || 1;
      const w = 84, h = 24;
      const pts = vals.map((v, i) => {
        const x = (i / (vals.length - 1)) * w;
        // always draw "up" as improvement, whichever way the scale runs
        const norm = t.mcid && CL.findTool(t.toolId).better === "down" ? (hi - v) / span : (v - lo) / span;
        return `${x.toFixed(1)},${(h - norm * h).toFixed(1)}`;
      });
      const [lastX, lastY] = pts[pts.length - 1].split(",");
      return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
        <polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${lastX}" cy="${lastY}" r="2.5" fill="currentColor" />
      </svg>`;
    };
    return `
      <div class="card">
        <div class="ins-head"><h2>Outcome measures</h2><span class="chip muted">${trends.length} tracked</span></div>
        <div class="outcome-trends">
          ${trends.map((t) => `
            <div class="otrend ${t.direction}">
              <div class="otrend-head">
                <b title="${esc(t.full)}">${esc(t.name)}</b>
                ${t.meaningful ? `<span class="chip ${t.direction === "better" ? "good" : "bad"}">${t.direction === "better" ? "clinically meaningful" : "meaningful decline"}</span>` : ""}
              </div>
              <div class="otrend-nums">
                <span class="otrend-from">${t.first}${esc(t.unit)}</span>
                <span class="otrend-arrow">→</span>
                <span class="otrend-to">${t.latest}${esc(t.unit)}</span>
                ${spark(t)}
              </div>
              <div class="otrend-foot">${t.n < 2
                ? "Baseline only — repeat it to show change."
                : `${t.improvement > 0 ? "+" : ""}${Math.round(t.improvement * 10) / 10} toward better · MCID ${t.mcid}`}</div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  // Complete / delete accepted action items in the Needs-attention card.
  function bindOverviewActions(p, user) {
    const refresh = () => render();
    document.querySelectorAll("[data-complete]").forEach((b) => b.addEventListener("click", () => {
      completingItemId = b.dataset.complete; refresh();
    }));
    document.querySelectorAll("[data-complete-cancel]").forEach((b) => b.addEventListener("click", () => {
      completingItemId = null; refresh();
    }));
    document.querySelectorAll("[data-complete-save]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.completeSave;
      const inp = document.getElementById("taskNote-" + id);
      const res = S.completeActionItem(p.id, id, inp ? inp.value : "", user);
      if (res && res.error) return alertBanner(res.error);
      completingItemId = null; refresh();
    }));
    document.querySelectorAll("[data-del-item]").forEach((b) => b.addEventListener("click", () => {
      S.deleteActionItem(p.id, b.dataset.delItem, user); refresh();
    }));
    if (completingItemId) {
      const inp = document.getElementById("taskNote-" + completingItemId);
      if (inp) { inp.focus(); inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { const sv = document.querySelector(`[data-complete-save="${completingItemId}"]`); if (sv) sv.click(); } }); }
    }
  }

  /* ---------- AI chart review (async, once per day) ---------- */

  function aiReviewAvailable() {
    return !!((window.TheraSync && window.TheraSync.getInsights) ||
      (window.TheraInsights && window.TheraInsights.buildInsights));
  }

  // Decide what to show and, on the first open of the day, kick off the review.
  function mountAiReview(p, user) {
    const el = document.getElementById("patientAiReview");
    if (!el) return;
    if (!S.docsFor(p.id).length) {
      el.innerHTML = `<div class="ins-head"><h2>✦ AI chart review</h2></div>
        <div class="empty-state" style="padding:12px">No documents yet — the AI review appears once this chart has an evaluation or notes.</div>`;
      return;
    }
    if (!aiReviewAvailable()) {
      el.innerHTML = `<div class="ins-head"><h2>✦ AI chart review</h2></div>
        <div class="banner warn" style="margin-top:6px">AI review is unavailable — configure Google Gemini / Vertex AI on the server, or use the on-device reviewer inside a note.</div>`;
      return;
    }
    if (aiReviewRuns[p.id]) return renderAiReviewCard(el, p, user, "running");
    if (p.aiReview && p.aiReview.ranOn === todayIso()) {
      return renderAiReviewCard(el, p, user, p.aiReview.error ? "error" : "done");
    }
    startAiReview(p, user); // first open today → auto-run
  }

  function renderAiReviewCard(el, p, user, state) {
    const review = p.aiReview || {};
    const note = `<p class="ins-disclaimer">Runs automatically the first time you open this chart each day${review.ranAt ? ` · last run ${fmtTime(review.ranAt)}` : ""}. Decision support for a licensed PT — <b>verify before acting</b>.</p>`;
    let body;
    if (state === "running") {
      body = `<div class="empty-state" style="padding:16px">
        <span class="asst-typing">Reviewing this chart…</span>
        <div style="margin-top:8px; font-size:12px; color:var(--muted)">Running in the background — the rest of the chart is ready to use.</div></div>`;
    } else if (state === "error") {
      body = `<div class="banner bad">AI review couldn't finish: ${esc(review.error || "unknown error")}. Try again with Re-run.</div>`;
    } else {
      body = review.result ? insightsHtml(review.result, { recMode: "chart", filterKeys: S.resolvedRecKeys(p.id) }) : `<div class="empty-state" style="padding:12px">No review yet.</div>`;
    }
    el.innerHTML = `
      <div class="ins-head">
        <h2>✦ AI chart review</h2>
        <button class="btn small ai" id="aiReviewBtn" ${state === "running" ? "disabled" : ""}>${state === "running" ? "Reviewing…" : "Re-run review"}</button>
      </div>
      ${note}
      <div id="aiReviewBody">${body}</div>`;
    const btn = el.querySelector("#aiReviewBtn");
    if (btn) btn.addEventListener("click", () => startAiReview(p, user));
    const recAt = (b) => (review.result && review.result.recommendations || [])[Number(b.dataset.recidx)];
    el.querySelectorAll(".rec-accept").forEach((b) => b.addEventListener("click", () => {
      const rec = recAt(b); if (!rec) return;
      const res = S.acceptRecommendation(p.id, rec, user);
      if (res && res.error) return alertBanner(res.error);
      render(); // refresh Needs attention + AI review together
    }));
    el.querySelectorAll(".rec-dismiss").forEach((b) => b.addEventListener("click", () => {
      const rec = recAt(b); if (!rec) return;
      S.dismissRecommendation(p.id, rec, user);
      render();
    }));
  }

  async function startAiReview(p, user) {
    if (aiReviewRuns[p.id]) return;
    aiReviewRuns[p.id] = true;
    const el0 = document.getElementById("patientAiReview");
    if (el0) renderAiReviewCard(el0, p, user, "running");

    let result = null, error = null;
    try {
      const latest = S.docsFor(p.id).slice().sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0];
      const ctx = gatherInsightContext(latest);
      const sync = window.TheraSync || {};
      result = sync.getInsights ? await sync.getInsights(ctx) : window.TheraInsights.buildInsights(ctx);
    } catch (e) { error = e.message || "review failed"; }

    delete aiReviewRuns[p.id];
    const review = { ranOn: todayIso(), ranAt: new Date().toISOString() };
    if (error) review.error = error; else review.result = result;
    S.saveAiReview(p.id, review);
    if (!error) S.audit(user.id, "ai-chart-review", `${S.patientName(p)}: ${(result.connections || []).length} connections, ${(result.recommendations || []).length} recs`);

    // sync may have swapped the state object during the await — re-fetch, and
    // only repaint if the review card is still mounted (user still on Overview)
    const cur = S.getPatient(p.id) || p;
    const el = document.getElementById("patientAiReview");
    if (el) renderAiReviewCard(el, cur, user, error ? "error" : "done");
  }

  /* ---------- Documents tab: new-doc picker + filters ---------- */

  function documentsPanel(p, user) {
    const canDoc = S.canDocument(user);
    const due = S.progressDue(p.id);
    return `
      <div class="card" id="documentsCard">
        <div class="ins-head"><h2>Therapy documents</h2></div>
        ${canDoc ? `<div class="newdoc">
          <div class="newdoc-btns">
            ${NEWDOC_TYPES.map((t) => `<button class="btn small newdoc-btn ${t.cls} ${t.type === "progress" && due ? "primary" : ""}" data-newdoc-type="${t.type}"><i class="dt-swatch"></i>+ ${t.label}${t.type === "progress" && due ? " (due)" : ""}</button>`).join("")}
          </div>
          <div class="newdoc-picker" id="newdocPicker" hidden></div>
        </div>` : `<div class="banner warn" style="margin-bottom:12px">Your account can view this chart but cannot create or edit clinical documents.</div>`}
        ${docFilterBar()}
        <div class="table-scroll" id="docListWrap">${docListHtml(p)}</div>
      </div>`;
  }

  function docFilterBar() {
    // per-type / per-status classes let each chip carry its own accent colour
    // so the groups read as colour-coded sets instead of one blob of pills.
    const typeChip = (val, label) => `<button class="fchip ft-type ft-${val} ${docFilter.type === val ? "on" : ""}" data-ftype="${val}">${val === "all" ? "" : '<i class="fdot"></i>'}${label}</button>`;
    const statChip = (val, label) => `<button class="fchip fs-${val} ${docFilter.status === val ? "on" : ""}" data-fstatus="${val}">${label}</button>`;
    return `
      <div class="doc-filters">
        <div class="fgroup"><span class="fglabel">Type</span>
          <div class="fchips">${typeChip("all", "All")}${typeChip("eval", "Eval")}${typeChip("daily", "Daily")}${typeChip("progress", "Progress")}${typeChip("discharge", "Discharge")}</div></div>
        <div class="fgroup"><span class="fglabel">Status</span>
          <div class="fchips">${statChip("all", "All")}${statChip("draft", "Draft")}${statChip("signed", "Signed")}</div></div>
        <div class="fgroup fgroup-date"><span class="fglabel">Date</span>
          <input type="date" class="fdate" id="fFrom" value="${docFilter.from}" aria-label="From date" />
          <span class="fgsep">–</span>
          <input type="date" class="fdate" id="fTo" value="${docFilter.to}" aria-label="To date" />
          <button class="btn small" id="fClear">Clear</button></div>
      </div>`;
  }

  function filteredDocs(p) {
    let docs = S.docsFor(p.id).slice().reverse(); // newest first
    if (docFilter.type !== "all") docs = docs.filter((d) => d.type === docFilter.type);
    if (docFilter.status !== "all") docs = docs.filter((d) => d.status === docFilter.status);
    if (docFilter.from) docs = docs.filter((d) => d.createdAt.slice(0, 10) >= docFilter.from);
    if (docFilter.to) docs = docs.filter((d) => d.createdAt.slice(0, 10) <= docFilter.to);
    return docs;
  }

  function docListHtml(p) {
    const docs = filteredDocs(p);
    const anyDocs = S.docsFor(p.id).length;
    if (!docs.length) {
      return `<div class="empty-state">${anyDocs ? "No documents match these filters." : `No documents yet.${S.canDocument(S.currentUser()) ? " Start with an <b>Evaluation</b> above." : ""}`}</div>`;
    }
    return `<table class="list"><thead><tr><th>Document</th><th>Status</th><th>Therapist</th><th>Date</th></tr></thead>
      <tbody>${docs.map(docRow).join("")}</tbody></table>`;
  }

  // The picker that replaces auto-creating a draft: shows existing unsigned
  // drafts of the chosen type to resume, plus an explicit "start a new one".
  function draftPickerHtml(p, type) {
    const meta = docMeta(type);
    const label = NEWDOC_TYPES.find((t) => t.type === type).label.toLowerCase();
    const drafts = S.docsFor(p.id).filter((d) => d.type === type && d.status === "draft").slice().reverse();
    const rows = drafts.length ? drafts.map((d) => `
      <div class="draft-row">
        <div><span class="doc-tag ${meta.cls}">${meta.short}</span> <b>${esc(d.title)}</b>
          <small style="color:var(--muted)"> · started ${fmtDT(d.createdAt)}</small></div>
        <a class="btn small" href="#/doc/${d.id}">Resume</a>
      </div>`).join("") : `<div class="empty-state" style="padding:8px">No unsigned ${label} drafts in progress.</div>`;
    return `
      <div class="draft-picker-head">${esc(NEWDOC_TYPES.find((t) => t.type === type).label)} drafts in progress</div>
      ${rows}
      <div class="draft-picker-actions">
        <button class="btn small primary" data-startdoc="${type}">+ Start a new ${label}</button>
        <button class="btn small" data-closepicker>Cancel</button>
      </div>`;
  }

  /* ---------- Files tab ---------- */

  function filesPanel(p, user) {
    const canDoc = S.canDocument(user);
    return `
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
      </div>`;
  }

  /* ---------- Info tab ---------- */

  function infoPanel(p) {
    return `
      <div class="cards-2">
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
            ${authInfoRows(p)}
          </tbody></table>
        </div>
        <div class="card">
          <h2>Allergies</h2>
          ${(p.allergies || "").trim()
            ? `<div class="allergy-box">⚠ ${esc(p.allergies)}</div>`
            : `<div class="empty-state" style="padding:12px">None recorded. If the patient has none, that's worth writing down explicitly.</div>`}
        </div>
        <div class="card">
          <h2>Emergency contact</h2>
          ${(p.emergencyContact || {}).name
            ? `<table class="list"><tbody>
                <tr><td style="color:var(--muted)">Name</td><td>${esc(p.emergencyContact.name)}</td></tr>
                <tr><td style="color:var(--muted)">Relationship</td><td>${esc(p.emergencyContact.relationship || "—")}</td></tr>
                <tr><td style="color:var(--muted)">Phone</td><td class="num">${esc(p.emergencyContact.phone || "—")}</td></tr>
              </tbody></table>`
            : `<div class="empty-state" style="padding:12px">No emergency contact on file.</div>`}
        </div>
      </div>`;
  }

  /* Authorisation is only meaningful next to what's been used, so the two are
     always shown together rather than as a static number on a form. */
  function authInfoRows(p) {
    const a = S.authStatus(p);
    if (!a.hasAuth) return `<tr><td style="color:var(--muted)">Visit authorisation</td><td>None recorded</td></tr>`;
    return `
      <tr><td style="color:var(--muted)">Visits authorised</td><td>
        <span class="num">${a.used} of ${a.authorized || "—"} used</span>
        ${a.exhausted ? '<span class="chip bad">exhausted</span>' : a.low ? `<span class="chip warn">${a.remaining} left</span>` : ""}
      </td></tr>
      <tr><td style="color:var(--muted)">Authorisation expires</td><td>
        ${a.expiresOn ? esc(a.expiresOn) : "—"} ${a.expired ? '<span class="chip bad">expired</span>' : ""}
      </td></tr>
      ${a.reference ? `<tr><td style="color:var(--muted)">Reference</td><td class="num">${esc(a.reference)}</td></tr>` : ""}`;
  }

  /* ---------- Schedule tab: bulk booking + upcoming visits ---------- */

  // Clock labels for the time <select>, generated from the facility's hours.
  function bulkTimeOptions() {
    const s = S.settings();
    const opts = [];
    for (let m = s.dayStartHour * 60; m < s.dayEndHour * 60; m += s.slotMinutes) {
      const hh = Math.floor(m / 60), mm = m % 60;
      const value = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      const label = fmtTime(new Date(2000, 0, 1, hh, mm).toISOString());
      opts.push(`<option value="${value}"${hh === s.dayStartHour && mm === 0 ? " selected" : ""}>${label}</option>`);
    }
    return opts.join("");
  }

  // From a start date + chosen weekdays + time, produce `count` ISO slot times,
  // skipping days the facility is closed. Deterministic, so preview == confirm.
  function generateSeries({ startIso, weekdays, time, count }) {
    const [hh, mm] = time.split(":").map(Number);
    const workDays = S.settings().workDays;
    const starts = [];
    const d = new Date(startIso + "T00:00:00");
    let guard = 0;
    while (starts.length < count && guard < 730) {
      guard++;
      const dow = d.getDay();
      if (weekdays.includes(dow) && workDays.includes(dow)) {
        const slot = new Date(d); slot.setHours(hh, mm, 0, 0);
        starts.push(slot.toISOString());
      }
      d.setDate(d.getDate() + 1);
    }
    return starts;
  }

  function schedulePanel(p, user) {
    const ths = therapists();
    const dow = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
    const defaults = [1, 3, 5]; // Mon/Wed/Fri
    const upcoming = S.appointments()
      .filter((a) => a.patientId === p.id && a.status === "booked" && a.start >= new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
      .sort((a, b) => (a.start < b.start ? -1 : 1));

    const form = ths.length ? `
      <div class="bulk-form">
        <div class="field"><label>Therapist</label><select id="bkTherapist">${ths.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Start date</label><input type="date" id="bkStart" value="${todayIso()}" /></div>
        <div class="field"><label>Time</label><select id="bkTime">${bulkTimeOptions()}</select></div>
        <div class="field"><label>Number of visits</label><input type="number" id="bkCount" min="1" max="60" value="12" /></div>
        <div class="field bulk-days"><label>Days of week</label>
          <div class="dow-picker">${dow.map(([v, l]) => `<label class="dow"><input type="checkbox" value="${v}" ${defaults.includes(v) ? "checked" : ""} />${l}</label>`).join("")}</div>
        </div>
        <div class="field"><label>Note (optional)</label><input id="bkNote" placeholder="e.g. Post-op ROM course" /></div>
        <div class="bulk-actions"><button class="btn primary" id="bkPreviewBtn">Preview schedule</button></div>
      </div>
      <div id="bulkPreview"></div>`
      : `<div class="banner warn">No active licensed therapists to schedule — update staff licenses in Facility Admin.</div>`;

    return `
      <div class="card sched-card sched-book">
        <div class="sched-cardhead"><span class="sched-ico">🗓️</span>
          <div><h2>Schedule recurring visits</h2>
          <p class="sched-cardsub">Generate a recurring schedule in one step — preview every visit (and any conflicts) before it's booked. Each visit gets the usual automatic reminders.</p></div>
        </div>
        ${form}
      </div>
      <div class="card sched-card sched-upcoming">
        <div class="sched-cardhead"><span class="sched-ico">📆</span>
          <div><h2>Upcoming visits</h2><p class="sched-cardsub">Booked and on the calendar${upcoming.length ? ` · ${upcoming.length}` : ""}.</p></div>
        </div>
        ${upcoming.length ? `<div class="table-scroll"><table class="list"><thead><tr><th>When</th><th>Therapist</th><th>Note</th><th></th></tr></thead><tbody>
          ${upcoming.map((a) => `<tr><td class="num">${fmtDT(a.start)}</td><td>${esc((S.getUser(a.therapistId) || {}).name || "—")}</td><td>${esc(a.note || "")}</td>
            <td style="text-align:right"><button class="btn small" data-cancelappt="${a.id}">Cancel</button></td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty-state">No upcoming visits booked.</div>`}
      </div>
      <div class="card sched-card sched-history">
        <div class="sched-cardhead"><span class="sched-ico">🧾</span>
          <div><h2>Visit history</h2><p class="sched-cardsub">What's been documented and booked so far.</p></div>
        </div>
        <table class="list"><tbody>
          <tr><td>Daily visits documented</td><td class="num">${S.visitCount(p.id)}</td></tr>
          <tr><td>Upcoming bookings</td><td class="num">${upcoming.length}</td></tr>
        </tbody></table>
      </div>`;
  }

  function readBulkForm() {
    const therapistId = document.getElementById("bkTherapist").value;
    const startIso = document.getElementById("bkStart").value;
    const time = document.getElementById("bkTime").value;
    const count = Math.max(1, Math.min(60, parseInt(document.getElementById("bkCount").value, 10) || 0));
    const weekdays = Array.from(document.querySelectorAll(".dow-picker input:checked")).map((c) => Number(c.value));
    const note = (document.getElementById("bkNote") || {}).value || "";
    return { therapistId, startIso, time, count, weekdays, note };
  }

  function renderBulkPreview(p, user) {
    const wrap = document.getElementById("bulkPreview");
    if (!wrap) return;
    const f = readBulkForm();
    if (!f.startIso) { wrap.innerHTML = `<div class="banner warn">Pick a start date.</div>`; return; }
    if (!f.weekdays.length) { wrap.innerHTML = `<div class="banner warn">Pick at least one day of the week.</div>`; return; }

    const starts = generateSeries({ startIso: f.startIso, weekdays: f.weekdays, time: f.time, count: f.count });
    const existing = S.appointments().filter((a) => a.status !== "cancelled" && a.therapistId === f.therapistId);
    const rows = starts.map((s) => ({ start: s, clash: existing.some((a) => a.start === s) }));
    const bookable = rows.filter((r) => !r.clash).length;

    wrap.innerHTML = `
      <div class="bulk-preview">
        <div class="bulk-preview-head">${bookable} visit${bookable === 1 ? "" : "s"} will be booked${rows.length - bookable ? ` · ${rows.length - bookable} skipped (conflict)` : ""}</div>
        <div class="table-scroll" style="max-height:260px; overflow:auto"><table class="list"><tbody>
          ${rows.map((r) => `<tr><td class="num">${fmtDT(r.start)}</td><td style="text-align:right">${r.clash ? '<span class="chip bad">conflict — skipped</span>' : '<span class="chip good">available</span>'}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="bulk-actions">
          <button class="btn primary" id="bkConfirmBtn" ${bookable ? "" : "disabled"}>Book ${bookable} visit${bookable === 1 ? "" : "s"}</button>
          <button class="btn" id="bkCancelPreview">Cancel</button>
        </div>
      </div>`;

    document.getElementById("bkCancelPreview").addEventListener("click", () => { wrap.innerHTML = ""; });
    document.getElementById("bkConfirmBtn").addEventListener("click", () => {
      const res = S.bookSeries({ patientId: p.id, therapistId: f.therapistId, starts, note: f.note }, user);
      const msg = `${res.booked.length} visit${res.booked.length === 1 ? "" : "s"} booked${res.skipped.length ? `, ${res.skipped.length} skipped for conflicts` : ""}.`;
      alertBanner(msg);
      renderShell(location.hash, patientView(user), user, bindPatient);
    });
  }

  /* ---------- patient bindings ---------- */

  function bindPatient(user) {
    bindRowLinks();
    const p = S.getPatient(currentPatientId());
    if (!p) return;

    // tab switching
    document.querySelectorAll("[data-ptab]").forEach((b) =>
      b.addEventListener("click", () => {
        patientTab = b.dataset.ptab;
        renderShell(location.hash, patientView(user), user, bindPatient);
      }));
    // "needs attention" jump-to-tab actions (may also set a document filter)
    document.querySelectorAll("[data-goto-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        patientTab = b.dataset.gotoTab;
        if (b.dataset.gotoStatus) docFilter.status = b.dataset.gotoStatus;
        renderShell(location.hash, patientView(user), user, bindPatient);
      }));

    const pr = document.getElementById("printChartBtn");
    if (pr) pr.addEventListener("click", () => printPatientChart(p));

    const ei = document.getElementById("editInfoBtn");
    if (ei) ei.addEventListener("click", () => openEditChooser(p, user));

    if (patientTab === "overview") { bindOverviewActions(p, user); mountAiReview(p, user); }
    if (patientTab === "documents") { bindNewDoc(p, user); bindDocFilters(p, user); }
    if (patientTab === "files") bindFiles(p, user);
    if (patientTab === "schedule") bindSchedule(p, user);
  }

  function bindNewDoc(p, user) {
    const picker = document.getElementById("newdocPicker");
    if (!picker) return;
    let openType = null;
    const closePicker = () => { picker.hidden = true; picker.innerHTML = ""; openType = null; document.querySelectorAll("[data-newdoc-type]").forEach((b) => b.classList.remove("active")); };
    const wirePicker = () => {
      const start = picker.querySelector("[data-startdoc]");
      if (start) start.addEventListener("click", () => {
        const res = S.createDoc(p.id, start.dataset.startdoc, user);
        if (res.error) return alertBanner(res.error);
        // watch this fresh draft so it self-discards if backed out untouched
        pristineDraft = { id: res.doc.id, snapshot: JSON.stringify(res.doc.data) };
        location.hash = `#/doc/${res.doc.id}`;
      });
      const close = picker.querySelector("[data-closepicker]");
      if (close) close.addEventListener("click", closePicker);
      bindRowLinks();
    };
    document.querySelectorAll("[data-newdoc-type]").forEach((b) =>
      b.addEventListener("click", () => {
        const type = b.dataset.newdocType;
        if (openType === type) return closePicker();
        openType = type;
        document.querySelectorAll("[data-newdoc-type]").forEach((x) => x.classList.toggle("active", x === b));
        picker.innerHTML = draftPickerHtml(p, type);
        picker.hidden = false;
        wirePicker();
      }));
  }

  function bindDocFilters(p, user) {
    const refresh = () => { const w = document.getElementById("docListWrap"); if (w) { w.innerHTML = docListHtml(p); bindRowLinks(); } };
    document.querySelectorAll("[data-ftype]").forEach((b) =>
      b.addEventListener("click", () => {
        docFilter.type = b.dataset.ftype;
        document.querySelectorAll("[data-ftype]").forEach((x) => x.classList.toggle("on", x.dataset.ftype === docFilter.type));
        refresh();
      }));
    document.querySelectorAll("[data-fstatus]").forEach((b) =>
      b.addEventListener("click", () => {
        docFilter.status = b.dataset.fstatus;
        document.querySelectorAll("[data-fstatus]").forEach((x) => x.classList.toggle("on", x.dataset.fstatus === docFilter.status));
        refresh();
      }));
    const from = document.getElementById("fFrom"), to = document.getElementById("fTo"), clr = document.getElementById("fClear");
    if (from) from.addEventListener("change", () => { docFilter.from = from.value; refresh(); });
    if (to) to.addEventListener("change", () => { docFilter.to = to.value; refresh(); });
    if (clr) clr.addEventListener("click", () => {
      docFilter.type = "all"; docFilter.status = "all"; docFilter.from = ""; docFilter.to = "";
      renderShell(location.hash, patientView(user), user, bindPatient);
    });
  }

  function bindFiles(p, user) {
    const up = document.getElementById("fileUpload");
    if (up) up.addEventListener("change", async () => {
      const f = up.files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) return alertBanner("File is too large (limit 20 MB).");
      try {
        // bytes go to storage (GCS/local); only a small reference is kept on the patient
        const ref = await window.TheraSync.uploadFile(f);
        // re-fetch: a background sync pull during the upload swaps the state
        // object, and a push to the stale copy would be silently lost
        const cur = S.getPatient(p.id) || p;
        (cur.attachments || (cur.attachments = [])).push({
          id: S.uid("a"), name: f.name, type: f.type, size: f.size,
          ...ref, uploadedBy: user.id, uploadedAt: new Date().toISOString(),
        });
        S.save();
        S.audit(user.id, "attachment-added", `${f.name} → ${S.patientName(cur)}`);
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
  }

  function bindSchedule(p, user) {
    const prev = document.getElementById("bkPreviewBtn");
    if (prev) prev.addEventListener("click", () => renderBulkPreview(p, user));
    document.querySelectorAll("[data-cancelappt]").forEach((b) =>
      b.addEventListener("click", () => {
        const res = S.cancelAppointment(b.dataset.cancelappt, user);
        if (res.error) return alertBanner(res.error);
        renderShell(location.hash, patientView(user), user, bindPatient);
      }));
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
            ${v.mmt.map((r, j) => measRow(i, "mmt", j, `MMT ${r.side ? r.side + " " : ""}${r.context || ""}`,
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
      mmt: kept(v.mmt).map(({ side, context, grade }) => ({ side: side || null, context, grade })),
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
        const cur = S.getPatient(p.id) || p; // re-fetch after await (sync pull may have swapped state)
        (cur.attachments || (cur.attachments = [])).push({
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
    const mmt = (d.mmt || []).length ? `<h3>Manual muscle testing</h3><table><tr><th>Side</th><th>Muscle / context</th><th>Grade</th></tr>
      ${d.mmt.map((r) => `<tr><td>${esc(r.side || "—")}</td><td>${esc(r.context || "—")}</td><td>${esc(r.grade)}</td></tr>`).join("")}</table>` : "";
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
      put("Assessment", d.assessment); put("Plan", d.plan);
    } else if (doc.type === "progress") {
      put("Baseline subjective (from evaluation)", d.baselineSubjective);
      put("Current status", d.currentStatus); put("Updated findings", d.updatedFindings);
      secs.push(measurementTables(d));
      put("Progress toward goals", d.goalsProgress); put("Assessment", d.assessment);
    } else if (doc.type === "discharge") {
      put("Summary of care", d.summary); put("Outcome", d.outcome); put("Recommendations", d.recommendations);
    }
    // Outcome scores and the charge sheet are what a payer or referring
    // physician reads for proof and for the claim, so both print.
    if ((d.outcomes || []).length) {
      secs.push(`<h3>Outcome measures</h3><table><tr><th>Measure</th><th>Score</th></tr>
        ${d.outcomes.map((o) => {
          const tool = CL.findTool(o.toolId);
          return tool ? `<tr><td>${esc(tool.name)} — ${esc(tool.full)}</td><td>${o.score}${esc(tool.unit)}</td></tr>` : "";
        }).join("")}</table>`);
    }
    if ((d.charges || []).length) {
      const sum = CL.billingSummary(d.charges);
      secs.push(`<h3>Billing</h3><table><tr><th>CPT</th><th>Description</th><th>Minutes</th><th>Units</th></tr>
        ${d.charges.map((c) => {
          const known = CL.findCode(c.code);
          return `<tr><td>${esc(c.code)}</td><td>${esc(c.desc || (known || {}).desc || "")}</td>
            <td>${known && !known.timed ? "—" : Number(c.minutes) || 0}</td><td>${Number(c.units) || 0}</td></tr>`;
        }).join("")}
        <tr><th colspan="2">Total</th><th>${sum.timedMinutes} timed min</th><th>${sum.totalUnits} units</th></tr></table>`);
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
<h1>${esc(S.currentClinicName())}</h1>
<div class="print-muted">Patient chart — printed ${fmtDT(new Date().toISOString())}</div>
<h2>Patient information</h2>
<table>
  <tr><th>Name</th><td>${esc(S.patientName(p))}</td><th>DOB</th><td>${esc(p.dob)} (age ${age(p.dob)})</td></tr>
  <tr><th>Phone</th><td>${esc(p.phone)}</td><th>Email</th><td>${esc(p.email || "—")}</td></tr>
  <tr><th>Address</th><td colspan="3">${esc(p.address || "—")}</td></tr>
  <tr><th>Referring physician</th><td>${esc(p.referringPhysician || "—")}</td>
      <th>Insurance</th><td>${esc((p.insurance || {}).provider || "—")} ${esc((p.insurance || {}).memberId || "")}</td></tr>
  <tr><th>Allergies</th><td>${esc(p.allergies || "None recorded")}</td>
      <th>Emergency contact</th><td>${esc((p.emergencyContact || {}).name || "—")}${(p.emergencyContact || {}).phone ? ` · ${esc(p.emergencyContact.phone)}` : ""}</td></tr>
  ${(() => {
    const a = S.authStatus(p);
    return a.hasAuth
      ? `<tr><th>Visits authorised</th><td>${a.used} of ${a.authorized || "—"} used</td>
             <th>Authorisation expires</th><td>${esc(a.expiresOn || "—")}${a.expired ? " (expired)" : ""}</td></tr>`
      : "";
  })()}
</table>
${(() => {
  const goals = S.goalsFor(p.id);
  if (!goals.length) return "";
  const sum = CL.goalSummary(goals, todayIso());
  return `<h2>Plan of care — goals (${sum.met}/${sum.total} met)</h2>
    <table><tr><th>Goal</th><th>Baseline</th><th>Target</th><th>Target date</th><th>Status</th></tr>
    ${sum.items.map(({ goal, status }) => `<tr>
      <td>${esc(goal.text)} <span class="print-muted">(${goal.term === "long" ? "long" : "short"}-term)</span></td>
      <td>${esc(goal.baseline || "—")}</td><td>${esc(goal.target || "—")}</td>
      <td>${esc(goal.targetDate || "—")}</td><td>${esc(status.label)}</td></tr>`).join("")}</table>`;
})()}
${(() => {
  const trends = CL.outcomeTrends(S.outcomeSeries(p.id));
  if (!trends.length) return "";
  return `<h2>Outcome measures — change over the episode</h2>
    <table><tr><th>Measure</th><th>Baseline</th><th>Latest</th><th>Change</th><th>MCID</th><th>Clinically meaningful?</th></tr>
    ${trends.map((t) => `<tr>
      <td>${esc(t.name)} — ${esc(t.full)}</td>
      <td>${t.first}${esc(t.unit)} <span class="print-muted">${esc(t.firstDate)}</span></td>
      <td>${t.latest}${esc(t.unit)} <span class="print-muted">${esc(t.latestDate)}</span></td>
      <td>${t.improvement > 0 ? "+" : ""}${Math.round(t.improvement * 10) / 10} toward better</td>
      <td>${t.mcid}</td>
      <td>${t.n < 2 ? "baseline only" : t.meaningful ? "Yes" : "No"}</td></tr>`).join("")}</table>`;
})()}
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
        outcomeEditor(doc, editable) +
        ta("assessment", "Assessment", "Clinical impression") +
        ta("plan", "Plan", "Frequency, duration, interventions") +
        goalsEditor(doc, editable) +
        billingEditor(doc, editable);
    } else if (doc.type === "daily") {
      sections = ta("subjective", "Subjective", "Patient-reported status today") +
        ta("summary", "Treatment summary", "Treatments performed this visit — dictation files treatment sentences here") +
        measurementEditor(doc, editable) +
        ta("assessment", "Assessment", "Response to treatment, clinical reasoning, progress toward goals", 2) +
        ta("plan", "Plan", "Next visit, frequency, HEP, progressions", 2) +
        billingEditor(doc, editable);
    } else if (doc.type === "progress") {
      sections = `<div class="field"><label>Baseline subjective — carried over from the evaluation</label>
          <textarea rows="2" disabled>${esc(doc.data.baselineSubjective || "(no signed evaluation found)")}</textarea></div>` +
        ta("currentStatus", "Current status", "How the patient presents now") +
        ta("updatedFindings", "Updated findings", "New objective findings — measured values go to the tables below") +
        measurementEditor(doc, editable) +
        outcomeEditor(doc, editable) +
        goalsEditor(doc, editable) +
        ta("goalsProgress", "Progress toward goals — narrative", "") +
        ta("assessment", "Assessment", "") +
        billingEditor(doc, editable);
    } else if (doc.type === "discharge") {
      sections = ta("summary", "Summary of care", "") +
        outcomeEditor(doc, editable) +
        goalsEditor(doc, editable) +
        ta("outcome", "Outcome", "") +
        ta("recommendations", "Recommendations", "") +
        billingEditor(doc, editable);
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
      <select id="langSel" title="Speech language" ${editable ? "" : "disabled"}>
        <option value="en-US">English</option>
        <option value="fil-PH">Tagalog / Filipino</option>
        <option value="ceb-PH">Cebuano</option>
      </select>
      <select id="engineSel" title="Dictation engine" ${editable ? "" : "disabled"}>
        <option value="browser">Dictation: Browser — on this device</option>
        <option value="cloud:standard">Dictation: Google Cloud — Standard</option>
        <option value="cloud:chirp">Dictation: Google Cloud — Chirp</option>
        <option value="cloud:chirp2">Dictation: Google Cloud — Chirp 2 (best for Taglish)</option>
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
    ${editable ? `<div class="typed-dictation">
      <label for="typedDictation">Type it out — anything the mic missed</label>
      <textarea id="typedDictation" rows="3" placeholder="No mic, or dictation missed something? Type here and press Enter to file it into the note (Shift+Enter for a new line)…"></textarea>
      <div class="typed-dictation-actions"><span class="hint">Enter files it · Shift+Enter = new line</span><button class="btn small ai" id="typedDictationAdd" type="button">＋ Add to note</button></div>
    </div>` : ""}
    <div class="route-log" id="routeLog"></div>
  </div>
  <div class="card doc-fields ${meta.cls}">
    ${sections}
    ${sigBlock}
  </div>
</div>
<div class="card" id="insightsCard"></div>
<div class="card asst-card" id="docAssistant"></div>`;

    // ------- shared dictation/map state -------
    const dstate = { selectedKey: null, editable };
    currentDocState = dstate;
    drawAllPoints(doc);
    drawMapNotes(doc, dstate);
    drawTranscript(doc, null, dstate);
    renderCleanupSummary(doc);
    renderInsightsCard(doc, user);
    renderAssistant(document.getElementById("docAssistant"), doc.patientId, user, { compact: true });
    if (S.settings().audioReview) bindAudioReview(doc, user, editable);
    const refineBtn = document.getElementById("refineBtn");
    if (refineBtn) refineBtn.addEventListener("click", () => runRefine(doc, user, dstate));
    document.getElementById("printDocBtn").addEventListener("click", () => {
      printHTML(`<h1>${esc(S.currentClinicName())}</h1>
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
      bindBillingEditor(doc, user);
      bindOutcomeEditor(doc, user);
    }
    // goal status is part of the plan of care, not the note body: a locked
    // note still shows the goals, but only an editable one can change them
    if (editable) bindGoalsEditor(doc, user);

    // sign / amend
    const signBtn = document.getElementById("signBtn");
    if (signBtn) signBtn.addEventListener("click", () => signModal(doc, user));
    const amendBtn = document.getElementById("amendBtn");
    if (amendBtn) amendBtn.addEventListener("click", () => amendModal(doc, user));

    // ------- speech -------
    if (editable) {
      startDictation(doc, user, dstate);
      const typed = document.getElementById("typedDictation");
      const submitTyped = () => {
        const text = typed.value.trim();
        if (!text) return;
        // route each non-empty line as its own utterance so multi-line entries
        // file cleanly, the same way separate dictated sentences would
        text.split("\n").map((l) => l.trim()).filter(Boolean).forEach((line) => routeUtterance(doc, user, line, dstate));
        typed.value = "";
        typed.focus();
      };
      // Enter files it; Shift+Enter inserts a newline so longer notes stay visible
      typed.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitTyped(); }
      });
      const typedAdd = document.getElementById("typedDictationAdd");
      if (typedAdd) typedAdd.addEventListener("click", submitTyped);
    }
  }

  /* ---- measurement tables ---- */

  function measurementEditor(doc, editable) {
    const d = doc.data;
    const del = (kind, i) => editable ? `<button class="btn small" data-delmeas="${kind}:${i}" title="Remove">✕</button>` : "";
    const rows = [];
    (d.rom || []).forEach((r, i) => rows.push(`<tr><td>ROM</td><td>${esc(r.side || "—")} ${esc(r.joint)} ${esc(r.motion)}</td><td class="num">${r.degrees}°</td><td>${del("rom", i)}</td></tr>`));
    (d.mmt || []).forEach((r, i) => rows.push(`<tr><td>MMT</td><td>${esc(r.side ? r.side + " " : "")}${esc(r.context || "—")}</td><td class="num">${esc(r.grade)}</td><td>${del("mmt", i)}</td></tr>`));
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

  /* ---------- Billing: CPT codes, minutes, units ---------- */

  /* A visit only becomes a claim once the interventions carry codes. The
     8-minute rule is computed live from the minutes so the therapist can see
     the claim balance before signing, rather than hearing about it from
     billing a week later. */
  function billingEditor(doc, editable) {
    const charges = doc.data.charges || [];
    const sum = CL.billingSummary(charges);
    const codeOptions = (sel) => CL.CPT_CODES.map((c) =>
      `<option value="${c.code}" ${c.code === sel ? "selected" : ""}>${c.code} — ${esc(c.desc)}${c.timed ? "" : " (untimed)"}</option>`).join("");

    const rows = charges.map((c, i) => {
      const known = CL.findCode(c.code);
      const timed = known ? known.timed : false;
      return `<tr>
        <td>${editable
          ? `<select data-charge="${i}" data-k="code" class="charge-code">${codeOptions(c.code)}</select>`
          : `<b>${esc(c.code)}</b> ${esc(c.desc || (known || {}).desc || "")}`}</td>
        <td class="num">${timed
          ? (editable ? `<input type="number" min="0" max="240" data-charge="${i}" data-k="minutes" value="${Number(c.minutes) || 0}" class="charge-num" />` : `${Number(c.minutes) || 0}`)
          : `<span class="charge-na" title="Untimed code — minutes don't affect the units">—</span>`}</td>
        <td class="num">${editable
          ? `<input type="number" min="0" max="20" data-charge="${i}" data-k="units" value="${Number(c.units) || 0}" class="charge-num" />`
          : `${Number(c.units) || 0}`}</td>
        <td>${editable ? `<button class="btn small" data-delcharge="${i}" title="Remove">✕</button>` : ""}</td>
      </tr>`;
    }).join("");

    const issues = sum.issues.map((i) =>
      `<div class="bill-issue ${i.level}">${i.level === "bad" ? "✕" : i.level === "warn" ? "△" : "ⓘ"} ${esc(i.text)}</div>`).join("");

    return `
<div class="field billing-field">
  <label>Billing — CPT codes, treatment minutes and units</label>
  <div class="table-scroll"><table class="list bill-table">
    <colgroup><col /><col class="c-min" /><col class="c-unit" /><col class="c-del" /></colgroup>
    <thead><tr><th>Code</th><th class="num">Min</th><th class="num">Units</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4"><div class="empty-state" style="padding:10px">No charges yet.${editable ? " Add the interventions performed, or pull them from the treatment text." : ""}</div></td></tr>`}</tbody>
  </table></div>
  ${editable ? `<div class="bill-actions">
    <button class="btn small" id="addChargeBtn" type="button">＋ Add charge</button>
    <button class="btn small" id="suggestChargeBtn" type="button" title="Read the treatment summary and add the codes it describes">✦ Suggest from treatment</button>
  </div>` : ""}
  <div class="bill-totals">
    <span><b>${sum.timedMinutes}</b> timed min</span>
    <span><b>${sum.timedUnitsClaimed}</b>/${sum.timedUnitsAllowed} timed units</span>
    <span><b>${sum.untimedUnits}</b> untimed</span>
    <span class="bill-total-units ${sum.balanced ? "ok" : "off"}"><b>${sum.totalUnits}</b> total units</span>
  </div>
  ${issues ? `<div class="bill-issues">${issues}</div>` : ""}
</div>`;
  }

  function bindBillingEditor(doc, user) {
    const persist = () => { S.updateDocData(doc.id, doc.data, user); render(); };

    document.querySelectorAll("[data-delcharge]").forEach((b) =>
      b.addEventListener("click", () => {
        doc.data.charges.splice(Number(b.dataset.delcharge), 1);
        persist();
      }));

    document.querySelectorAll("[data-charge]").forEach((el) =>
      el.addEventListener("change", () => {
        const c = doc.data.charges[Number(el.dataset.charge)];
        if (!c) return;
        const k = el.dataset.k;
        if (k === "code") {
          const known = CL.findCode(el.value);
          c.code = el.value;
          c.desc = known ? known.desc : "";
          if (known && !known.timed) c.minutes = 0;
        } else {
          c[k] = Math.max(0, Number(el.value) || 0);
        }
        persist();
      }));

    const add = document.getElementById("addChargeBtn");
    if (add) add.addEventListener("click", () => {
      if (!doc.data.charges) doc.data.charges = [];
      const first = CL.CPT_CODES.find((c) => c.code === "97110") || CL.CPT_CODES[0];
      doc.data.charges.push({ code: first.code, desc: first.desc, minutes: first.timed ? 15 : 0, units: 1 });
      persist();
    });

    const sug = document.getElementById("suggestChargeBtn");
    if (sug) sug.addEventListener("click", () => {
      // every field a treatment sentence could have landed in, per note type
      const text = [doc.data.summary, doc.data.plan, doc.data.currentStatus,
                    doc.data.updatedFindings, doc.data.objectiveText, doc.data.recommendations]
        .filter(Boolean).join(". ");
      const found = CL.suggestCodes(text);
      if (!found.length) return alertBanner("Nothing in the treatment text matched a billable code — add them by hand.");
      if (!doc.data.charges) doc.data.charges = [];
      let added = 0;
      found.forEach((f) => {
        if (doc.data.charges.some((c) => c.code === f.code)) return;
        // minutes and units stay at zero: only the clinician knows how long
        // each intervention actually took, and guessing would be a false claim
        doc.data.charges.push({ code: f.code, desc: f.desc, minutes: 0, units: 0 });
        added++;
      });
      if (!added) return alertBanner("Those codes are already on the charge sheet.");
      persist();
      alertBanner(`${added} code${added > 1 ? "s" : ""} added — set the minutes and units for each.`);
    });
  }

  /* ---------- Outcome measures ---------- */

  /* Standardised scores are what a payer or referrer actually reads as proof
     of progress. Recorded here per visit; trended across the episode on the
     patient's Overview. */
  function outcomeEditor(doc, editable) {
    const list = doc.data.outcomes || [];
    const rows = list.map((o, i) => {
      const tool = CL.findTool(o.toolId);
      if (!tool) return "";
      return `<tr>
        <td><b>${esc(tool.name)}</b> <span style="color:var(--muted)">${esc(tool.full)}</span></td>
        <td class="num"><span class="score-cell">${editable
          ? `<input type="number" step="0.5" min="${tool.min}" max="${tool.max}" data-outcome="${i}" value="${o.score}" class="charge-num" />`
          : `${o.score}`}<span class="score-unit">${esc(tool.unit)}</span></span></td>
        <td>${editable ? `<button class="btn small" data-deloutcome="${i}" title="Remove">✕</button>` : ""}</td>
      </tr>`;
    }).join("");

    return `
<div class="field">
  <label>Outcome measures</label>
  <div class="table-scroll"><table class="list">
    <thead><tr><th>Measure</th><th class="num">Score</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3"><div class="empty-state" style="padding:10px">None recorded${editable ? " — add one below, or dictate e.g. “LEFS 52 out of 80”." : "."}</div></td></tr>`}</tbody>
  </table></div>
  ${editable ? `<div class="outcome-add">
    <select id="outcomeTool">${CL.OUTCOME_TOOLS.map((t) => `<option value="${t.id}">${t.name} — ${esc(t.full)}</option>`).join("")}</select>
    <input type="number" step="0.5" id="outcomeScore" placeholder="Score" class="charge-num" />
    <button class="btn small" id="addOutcomeBtn" type="button">＋ Record</button>
    <span class="outcome-err" id="outcomeErr"></span>
  </div>` : ""}
</div>`;
  }

  function bindOutcomeEditor(doc, user) {
    const persist = () => { S.updateDocData(doc.id, doc.data, user); render(); };

    document.querySelectorAll("[data-deloutcome]").forEach((b) =>
      b.addEventListener("click", () => {
        doc.data.outcomes.splice(Number(b.dataset.deloutcome), 1);
        persist();
      }));

    document.querySelectorAll("[data-outcome]").forEach((el) =>
      el.addEventListener("change", () => {
        const o = doc.data.outcomes[Number(el.dataset.outcome)];
        if (!o) return;
        const v = CL.validateScore(o.toolId, el.value);
        if (!v.ok) return alertBanner(v.error);
        o.score = v.value;
        persist();
      }));

    const add = document.getElementById("addOutcomeBtn");
    if (add) add.addEventListener("click", () => {
      const toolId = document.getElementById("outcomeTool").value;
      const raw = document.getElementById("outcomeScore").value;
      const err = document.getElementById("outcomeErr");
      const v = CL.validateScore(toolId, raw);
      if (!v.ok) { err.textContent = v.error; return; }
      if (!doc.data.outcomes) doc.data.outcomes = [];
      const existing = doc.data.outcomes.find((o) => o.toolId === toolId);
      // one score per tool per visit — re-recording replaces rather than stacks
      if (existing) existing.score = v.value;
      else doc.data.outcomes.push({ toolId, score: v.value });
      persist();
    });
  }

  /* ---------- Plan-of-care goals (patient-level, edited from a note) ---------- */

  function goalsEditor(doc, editable) {
    const p = S.getPatient(doc.patientId);
    const goals = S.goalsFor(doc.patientId);
    const sum = CL.goalSummary(goals, todayIso());
    const canEdit = editable && !!p;

    /* Stacked rows, not a table: this sits in the note's narrow right-hand
       column, where four columns squeeze goal text down to one word a line. */
    const rows = sum.items.map(({ goal, status }) => `
      <div class="goal-edit-row">
        <div class="goal-edit-main">
          <div class="goal-text">${esc(goal.text)}<span class="goal-term">${goal.term === "long" ? "long-term" : "short-term"}</span></div>
          ${goal.baseline || goal.target ? `<div class="goal-bt">${goal.baseline ? `from <b>${esc(goal.baseline)}</b>` : ""}${goal.baseline && goal.target ? " → " : ""}${goal.target ? `to <b>${esc(goal.target)}</b>` : ""}</div>` : ""}
        </div>
        <div class="goal-edit-controls">
          <span class="goal-state ${status.state}">${esc(status.label)}</span>
          ${canEdit
            ? `<select data-goal="${goal.id}" class="goal-status-sel">${CL.GOAL_STATUS.map((s) => `<option value="${s.id}" ${(goal.status || "active") === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select>
               <button class="btn small" data-delgoal="${goal.id}" title="Remove goal">✕</button>`
            : `<span class="goal-state closed">${esc((CL.GOAL_STATUS.find((s) => s.id === (goal.status || "active")) || {}).label || "")}</span>`}
        </div>
      </div>`).join("");

    return `
<div class="field">
  <label>Plan-of-care goals${sum.total ? ` — ${sum.met}/${sum.total} met` : ""}</label>
  <div class="goal-edit-list">${rows || `<div class="empty-state" style="padding:10px">No goals set${canEdit ? " — add the first one below." : "."}</div>`}</div>
  ${canEdit ? `<div class="goal-add">
    <input id="goalText" placeholder="Goal — e.g. “Climb a flight of stairs without the rail”" />
    <div class="goal-add-row">
      <input id="goalBaseline" placeholder="Baseline now" />
      <input id="goalTarget" placeholder="Target" />
      <input id="goalDate" type="date" title="Target date" />
      <select id="goalTerm"><option value="short">Short-term</option><option value="long">Long-term</option></select>
      <button class="btn small" id="addGoalBtn" type="button">＋ Add goal</button>
    </div>
    <span class="outcome-err" id="goalErr"></span>
  </div>` : ""}
</div>`;
  }

  function bindGoalsEditor(doc, user) {
    const redraw = () => render();

    document.querySelectorAll("[data-goal]").forEach((sel) =>
      sel.addEventListener("change", () => {
        const res = S.updateGoal(doc.patientId, sel.dataset.goal, { status: sel.value }, user);
        if (res.error) return alertBanner(res.error);
        redraw();
      }));

    document.querySelectorAll("[data-delgoal]").forEach((b) =>
      b.addEventListener("click", () => {
        const res = S.deleteGoal(doc.patientId, b.dataset.delgoal, user);
        if (res.error) return alertBanner(res.error);
        redraw();
      }));

    const add = document.getElementById("addGoalBtn");
    if (add) add.addEventListener("click", () => {
      const g = (id) => (document.getElementById(id).value || "").trim();
      const res = S.addGoal(doc.patientId, {
        text: g("goalText"), baseline: g("goalBaseline"), target: g("goalTarget"),
        targetDate: g("goalDate"), term: g("goalTerm"),
      }, user);
      if (res.error) { document.getElementById("goalErr").textContent = res.error; return; }
      redraw();
    });
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

  /* One score per tool per note: saying a number twice in a session is a
     correction, not a second data point. */
  function mergeOutcomes(doc, found) {
    if (!found || !found.length) return 0;
    if (!doc.data.outcomes) doc.data.outcomes = [];
    let n = 0;
    for (const o of found) {
      const existing = doc.data.outcomes.find((x) => x.toolId === o.toolId);
      if (existing) { if (existing.score !== o.score) { existing.score = o.score; n++; } }
      else { doc.data.outcomes.push({ toolId: o.toolId, score: o.score }); n++; }
    }
    return n;
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
        // drop any trailing "(…)" qualifier, then say why the option is greyed
        o.textContent = o.textContent.replace(/\s*\([^)]*\)\s*$/, "") + " · needs Google Cloud setup";
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
      // route into the LIVE doc object — a sync pull may have replaced the
      // state since this engine was created (writes to the captured copy
      // would be lost); the doc can also have been signed in the meantime
      const live = S.getDoc(doc.id);
      if (!live || live.status === "signed") return;
      routeUtterance(live, user, text, open ? currentDocState : null, !open);
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
      a.onended = a.onerror = () => URL.revokeObjectURL(url); // release either way
      try { await a.play(); } catch (e) { URL.revokeObjectURL(url); throw e; }
    } catch (_) { /* ignore */ } finally { btn.textContent = old; btn.disabled = false; }
  }

  function appendField(doc, field, sentence, silent) {
    const cur = (doc.data[field] || "").trim();
    doc.data[field] = cur ? cur + (cur.endsWith(".") ? " " : ". ") + sentence : sentence;
    if (silent) return; // data only — the open view belongs to another doc
    const t = document.querySelector(`textarea[data-field="${field}"]`);
    if (t) t.value = doc.data[field];
  }

  /* One spoken breath usually carries several documentation sentences. Split
     on sentence enders so each lands in its own section; a paragraph with no
     punctuation at all stays whole rather than being chopped arbitrarily. */
  function splitSentences(text) {
    const out = String(text || "").match(/[^.!?;]+[.!?;]*/g) || [];
    const parts = out.map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [text];
  }

  /** Which field of `type` one sentence belongs in — null means "table only". */
  function fieldForSentence(type, sentence) {
    // A standardised score is data, not narrative: "LEFS is now 58 out of 80"
    // belongs in the outcome table the same way a ROM reading does, and
    // repeating it in Subjective just pads the note.
    if (CL.extractOutcomes(sentence).length) return null;
    if (type === "discharge") return "summary";
    const meas = PR.extractMeasurements(sentence);
    if (type === "daily") {
      // ROM/MMT/special tests live in the measurement table only; pain ratings
      // are patient-reported, so those sentences still belong in Subjective
      const objMeas = meas.rom.length + meas.mmt.length + meas.special.length;
      if (objMeas) return null;
      if (/\bplan\b|\bnext (?:visit|session)\b|\bcontinue\b|\bfollow[- ]up\b|\btimes? a week\b|\bx\/week\b/i.test(sentence)) return "plan";
      if (/\b(assessment|impression|consistent with|tolerated|progressing|responding)\b/i.test(sentence)) return "assessment";
      return TREAT_RE.test(sentence) ? "summary" : "subjective";
    }
    const section = PR.classifyUtterance(sentence, PR.parseUtterance(sentence), meas);
    if (type === "eval") {
      return { reason: "reason", precautions: "precautions", pmh: "pmh", assessment: "assessment", objective: "objectiveText", subjective: "subjective" }[section];
    }
    if (type === "progress") {
      return { reason: "currentStatus", precautions: "currentStatus", pmh: "currentStatus", assessment: "assessment", objective: "updatedFindings", subjective: "currentStatus" }[section];
    }
    return null;
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

    // standardised scores ("LEFS 52 out of 80") file into the outcome table
    const nOut = mergeOutcomes(doc, CL.extractOutcomes(parsed.text));
    if (nOut) routed.push(`${nOut} outcome measure${nOut > 1 ? "s" : ""} → Outcomes`);

    // map points — skip mentions that are only part of a measurement
    // ("shoulder flexion 130 degrees" is data, not a complaint) or of a
    // treatment narration ("we did manual therapy on the shoulder")
    const treatment = PR.guessSpeaker(parsed.text) === "clinician";
    const pinnable = parsed.mentions.filter(
      (m) => !((nMeas || treatment) && m.summary.startsWith("Mentioned this area"))
    );
    for (const m of pinnable) addDocMapPoint(doc, m, uttId, time);
    if (!parsed.mentions.length && parsed.loose && (doc.data.mapPoints || []).length) {
      const pt = doc.data.mapPoints[doc.data.mapPoints.length - 1];
      pt.notes.push({ time, summary: parsed.loose.summary, quote: parsed.loose.quote, uttId, marks: [[0, parsed.text.length, false]] });
      routed.push(`follow-up → ${pt.part}`);
    } else if (pinnable.length) {
      routed.push(`${pinnable.length} body area${pinnable.length > 1 ? "s" : ""} → map`);
    }

    // text routing — sentence by sentence. Therapists talk in paragraphs
    // ("shoulder still hurts, flexion is 140, we did scaption"), and routing
    // the whole utterance to one field meant everything but the first match
    // was dropped: a daily note that mentioned any measurement lost its
    // subjective and treatment text entirely.
    const filedTo = [];
    for (const sentence of splitSentences(parsed.text)) {
      const field = fieldForSentence(doc.type, sentence);
      if (!field) continue;
      appendField(doc, field, cap(sentence), silent);
      if (!filedTo.includes(field)) filedTo.push(field);
    }
    for (const f of filedTo) routed.push(`text → ${fieldLabel(doc.type, f)}`);

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
      subjective: "Subjective", objectiveText: "Objective", assessment: "Assessment", plan: "Plan",
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
      ...meas.mmt.map((r) => `MMT · ${r.side ? r.side + " " : ""}${r.context || ""} ${r.grade}`),
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

  /* ================= Patient AI assistant (grounded Q&A) =================
     A NotebookLM-style helper scoped to a single patient. The corpus is built
     ONLY from that patient's own documents, so nothing bleeds between charts;
     the model is instructed to answer only from that corpus (see ai.js). */

  // Narrative fields differ by document type; collect the useful ones.
  const docObjective = (d) => d.data.objectiveText || d.data.updatedFindings || "";
  const docPlan = (d) => d.data.plan || d.data.summary || d.data.recommendations || d.data.goalsProgress || d.data.outcome || "";

  // Assemble a single patient's full chart as the assistant's grounding corpus.
  function gatherPatientCorpus(patientId) {
    const p = S.getPatient(patientId);
    const evalDoc = S.docsFor(patientId).find((d) => d.type === "eval");
    const all = S.docsFor(patientId)
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .map((d) => ({
        date: d.createdAt.slice(0, 10), type: docMeta(d.type).label,
        subjective: docSubjective(d), objective: docObjective(d),
        assessment: d.data.assessment || "", plan: docPlan(d),
        findings: findingsFromPoints(d.data.mapPoints), measurements: measOf(d),
      }));
    // 12 most-recent visits in full; anything older compressed to a digest so
    // the corpus stays about a page even for years of imported records.
    const docs = all.slice(0, 12);
    const historyDigest = all.length > 12 ? window.TheraInsights.buildHistoryDigest(all.slice(12)) : null;
    return {
      patient: p ? { age: age(p.dob), sex: p.sex || "" } : {},
      referral: (evalDoc && evalDoc.data.reason) || (p && p.referringPhysician) || "",
      pmh: (evalDoc && evalDoc.data.pmh) || "",
      docs, historyDigest,
    };
  }

  const assistantAvailable = () =>
    !!(window.TheraSync && window.TheraSync.ai && window.TheraSync.ai.assistant !== "unavailable");

  const ASSISTANT_STARTERS = [
    "Summarize this patient's history",
    "What were the most recent measurements?",
    "Any red flags or precautions noted?",
    "How has pain changed across visits?",
  ];

  // Render an assistant chat panel into `container` for one patient. `compact`
  // trims the intro for the in-note placement. Conversation is kept in memory
  // for the life of the view (not persisted to the chart).
  function renderAssistant(container, patientId, user, opts) {
    opts = opts || {};
    if (!container) return;
    const p = S.getPatient(patientId);
    if (!assistantAvailable()) {
      container.innerHTML = `
        <div class="asst-head"><h2>✦ Ask about this patient <span class="chip muted">grounded in this chart</span></h2></div>
        <div class="banner warn" style="margin-top:6px">The AI assistant needs Google Gemini / Vertex AI configured on the server. It's currently unavailable — clinical notes and dictation still work as normal.</div>`;
      return;
    }
    // when a persistKey is given, reuse the stored conversation so it survives
    // re-renders (drawer stays mid-chat across patient-tab switches)
    const turns = opts.persistKey ? (assistantConvos[opts.persistKey] || (assistantConvos[opts.persistKey] = [])) : [];
    container.innerHTML = `
      <div class="asst-head">
        <h2>✦ Ask about this patient <span class="chip info">Gemini</span><span class="chip muted">grounded in this chart</span></h2>
      </div>
      ${opts.compact ? "" : `<p class="asst-disclaimer">Answers come <b>only</b> from ${esc(p ? S.patientName(p) : "this patient")}'s own records — notes, visits, and imported history. If something isn't documented, it will say so. Decision support for a licensed PT — <b>verify before acting</b>.</p>`}
      <div class="asst-log" id="asstLog">
        <div class="asst-empty">Ask a question about this patient's history, findings, or progress.</div>
        <div class="asst-starters">${ASSISTANT_STARTERS.map((s) => `<button class="chip asst-starter" type="button">${esc(s)}</button>`).join("")}</div>
      </div>
      <div class="asst-input">
        <textarea id="asstInput" rows="1" placeholder="Ask about this patient…"></textarea>
        <button class="btn ai" id="asstSend" title="Ask">Ask</button>
      </div>`;

    const log = container.querySelector("#asstLog");
    const input = container.querySelector("#asstInput");
    const sendBtn = container.querySelector("#asstSend");

    const bubble = (role, html, cls) =>
      `<div class="asst-msg ${role}${cls ? " " + cls : ""}">${html}</div>`;

    const redraw = (thinking) => {
      const rows = turns.map((t) => {
        if (t.role === "user") return bubble("user", esc(t.text));
        const cites = (t.citations || []).length
          ? `<div class="asst-cites">${t.citations.map((c) => `<span class="chip muted" title="${esc(c.quote || "")}">${esc(c.source)}</span>`).join("")}</div>` : "";
        return bubble("assistant", `${esc(t.text)}${cites}`, t.answered === false ? "unanswered" : "");
      }).join("");
      log.innerHTML = rows + (thinking ? bubble("assistant", `<span class="asst-typing">Reading the chart…</span>`, "thinking") : "");
      log.scrollTop = log.scrollHeight;
    };

    const ask = async (question) => {
      const q = String(question || "").trim();
      if (!q) return;
      input.value = ""; autosize();
      const history = turns.slice();
      turns.push({ role: "user", text: q });
      redraw(true);
      sendBtn.disabled = true;
      try {
        const r = await window.TheraSync.askPatient({ chart: gatherPatientCorpus(patientId), question: q, history });
        turns.push({ role: "assistant", text: r.answer || "(no answer)", answered: r.answered, citations: r.citations || [] });
        S.audit(user.id, "assistant-query", `${p ? S.patientName(p) : patientId}: "${q.slice(0, 80)}"`);
      } catch (e) {
        turns.push({ role: "assistant", text: `Couldn't answer that: ${e.message}`, answered: false, citations: [] });
      }
      sendBtn.disabled = false;
      redraw(false);
      input.focus();
    };

    const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); }
    });
    sendBtn.addEventListener("click", () => ask(input.value));
    container.querySelectorAll(".asst-starter").forEach((b) =>
      b.addEventListener("click", () => ask(b.textContent)));
    if (turns.length) redraw(false); // restore a persisted conversation
  }

  const planFieldFor = (type) =>
    ({ eval: "plan", daily: "plan", progress: "assessment", discharge: "recommendations" })[type];

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

  function insightsHtml(ins, opts) {
    opts = opts || {};
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
    // "chart" mode (the patient's AI chart review) lets the therapist accept a
    // recommendation onto Needs attention or dismiss it; already-actioned recs
    // are filtered out via opts.filterKeys so they don't reappear.
    const chart = opts.recMode === "chart";
    const resolved = new Set(opts.filterKeys || []);
    const hadRecs = (ins.recommendations || []).length;
    const recs = (ins.recommendations || []).map((r, i) => ({ r, i }))
      .filter(({ r }) => !(chart && resolved.has((r.action || "").trim().toLowerCase())))
      .map(({ r, i }) => {
        const actions = chart
          ? `<span class="rec-actions">
              <button class="btn small good rec-accept" data-recidx="${i}" title="Add to Needs attention">✓ Accept</button>
              <button class="btn small ghost rec-dismiss" data-recidx="${i}" title="Dismiss this suggestion">✕</button></span>`
          : (opts.withAdd === false ? "" : `<button class="btn small ins-add" data-rec="${i}" title="Append to the note's plan/assessment">＋ Add to note</button>`);
        return `
      <div class="ins-item rec-item">
        <div class="ins-item-head"><b>${esc(r.action)}</b>${prioChip(r.priority)}${actions}</div>
        ${r.rationale ? `<div class="ins-detail">${esc(r.rationale)}</div>` : ""}
      </div>`;
      }).join("");
    const recsEmpty = (chart && hadRecs)
      ? `<div class="empty-state" style="padding:8px">✓ Every recommendation has been accepted or dismissed — accepted items move to <b>Needs attention</b> above.</div>`
      : `<div class="empty-state" style="padding:8px">No specific recommendations.</div>`;
    return `
      ${flags ? `<div class="ins-section"><h3 class="ins-h">Red flags</h3>${flags}</div>` : ""}
      <div class="ins-section"><h3 class="ins-h">Possible connections</h3>${conns || `<div class="empty-state" style="padding:8px">No cross-visit connections detected.</div>`}</div>
      <div class="ins-section"><h3 class="ins-h">Recommendations — what to do now</h3>${recs || recsEmpty}</div>`;
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

  /* The sections a reviewer or payer expects to find filled in. Signing locks
     the note, so a blank one can only be corrected by amendment — worth a look
     before committing, though it stays the clinician's call. */
  const REQUIRED_SECTIONS = {
    eval: [["subjective", "Subjective"], ["objectiveText", "Objective findings"], ["assessment", "Assessment"], ["plan", "Plan"]],
    daily: [["subjective", "Subjective"], ["summary", "Treatment summary"], ["assessment", "Assessment"], ["plan", "Plan"]],
    progress: [["currentStatus", "Current status"], ["goalsProgress", "Progress toward goals"], ["assessment", "Assessment"]],
    discharge: [["summary", "Summary of care"], ["outcome", "Outcome"], ["recommendations", "Recommendations"]],
  };

  const emptySections = (doc) =>
    (REQUIRED_SECTIONS[doc.type] || [])
      .filter(([field]) => !String(doc.data[field] || "").trim())
      .map(([, label]) => label);

  function signModal(doc, user) {
    const pending = window.__theraDict && window.__theraDict.pending ? window.__theraDict.pending() : 0;
    const blanks = emptySections(doc);
    const m = showModal(`
<h2>E-sign &amp; lock — ${esc(doc.title)}</h2>
${pending ? `<div class="banner warn">△ ${pending} dictated segment${pending > 1 ? "s are" : " is"} still being transcribed — wait for them to land before signing, or they will need an amendment.</div>` : ""}
${blanks.length ? `<div class="banner warn">△ Still empty: <b>${blanks.map(esc).join(", ")}</b>. You can sign anyway, but filling these in now avoids an amendment later.</div>` : ""}
<p style="font-size:13px; color:var(--muted)">Signing certifies this documentation is accurate and complete. The document will lock; later changes require a signed amendment with an authorization reason.</p>
<div class="field"><label>Type your full registered name (${esc(user.name)})</label><input id="sigName" autocomplete="off" /></div>
${isGoogleAccount(user)
  ? `<div class="field"><label>Confirm it's you</label>
       <div style="font-size:12.5px; color:var(--muted); margin-bottom:6px">You sign in with Google, so confirm with Google instead of a password.</div>
       <div id="sigGoogle"></div></div>`
  : `<div class="field"><label>Password</label><input id="sigPin" type="password" autocomplete="current-password" /></div>`}
<div class="error" id="sigErr"></div>
<div class="modal-actions">
  <button class="btn" id="sigCancel">Cancel</button>
  <button class="btn primary" id="sigOk"${isGoogleAccount(user) ? " disabled" : ""}>✒ Sign &amp; lock</button>
</div>`);
    // A Google account has no password, so /api/verify-password can never pass
    // for one. Re-confirm with the same provider they signed in with, then
    // enable the sign button.
    let googleConfirmed = false;
    if (isGoogleAccount(user)) {
      mountGoogleReauth(m.querySelector("#sigGoogle"), (r) => {
        const err = m.querySelector("#sigErr");
        if (!r.ok) { err.textContent = r.error || "Google verification failed."; return; }
        googleConfirmed = true;
        err.style.color = "var(--ok, green)";
        err.textContent = "✓ Confirmed with Google — you can sign now.";
        m.querySelector("#sigGoogle").innerHTML = '<div class="chip good">Confirmed</div>';
        m.querySelector("#sigOk").disabled = false;
      });
    }
    m.querySelector("#sigCancel").addEventListener("click", closeModal);
    m.querySelector("#sigOk").addEventListener("click", async () => {
      const err = m.querySelector("#sigErr");
      err.style.color = "";
      if (isGoogleAccount(user)) {
        if (!googleConfirmed) { err.textContent = "Confirm with Google first."; return; }
      } else if (!(await window.TheraSync.verifyPassword(m.querySelector("#sigPin").value))) { err.textContent = "Incorrect password."; return; }
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
${isGoogleAccount(user)
  ? `<div class="field"><label>Confirm it's you</label>
       <div style="font-size:12.5px; color:var(--muted); margin-bottom:6px">You sign in with Google, so confirm with Google instead of a password.</div>
       <div id="amGoogle"></div></div>`
  : `<div class="field"><label>Password</label><input id="amPin" type="password" autocomplete="current-password" /></div>`}
<div class="error" id="amErr"></div>
<div class="modal-actions">
  <button class="btn" id="amCancel">Cancel</button>
  <button class="btn primary" id="amOk"${isGoogleAccount(user) ? " disabled" : ""}>✒ Sign amendment</button>
</div>`);
    // same reasoning as signModal: a Google account has no password to re-enter
    let amGoogleConfirmed = false;
    if (isGoogleAccount(user)) {
      mountGoogleReauth(m.querySelector("#amGoogle"), (r) => {
        const err = m.querySelector("#amErr");
        if (!r.ok) { err.textContent = r.error || "Google verification failed."; return; }
        amGoogleConfirmed = true;
        err.style.color = "var(--ok, green)";
        err.textContent = "✓ Confirmed with Google — you can sign the amendment now.";
        m.querySelector("#amGoogle").innerHTML = '<div class="chip good">Confirmed</div>';
        m.querySelector("#amOk").disabled = false;
      });
    }
    m.querySelector("#amCancel").addEventListener("click", closeModal);
    m.querySelector("#amOk").addEventListener("click", async () => {
      const err = m.querySelector("#amErr");
      err.style.color = "";
      if (isGoogleAccount(user)) {
        if (!amGoogleConfirmed) { err.textContent = "Confirm with Google first."; return; }
      } else if (!(await window.TheraSync.verifyPassword(m.querySelector("#amPin").value))) { err.textContent = "Incorrect password."; return; }
      const res = S.amendDoc(doc.id, user, m.querySelector("#amName").value,
        m.querySelector("#amText").value, m.querySelector("#amReason").value);
      if (res.error) { err.textContent = res.error; return; }
      closeModal();
      render();
    });
  }

  /* ================= CALENDAR ================= */

  let calDate = todayIso();
  const calHidden = new Set(); // therapist ids whose column is hidden on the board

  function therapists() {
    return S.staff().filter((u) => u.active && (u.role === "therapist" || u.role === "admin") && u.license);
  }

  /* Bookings don't always sit exactly on the generated grid: the facility can
     change slot length or opening hours after visits were booked, and a visit
     agreed over the phone rarely lands on a round slot. Matching slot times
     exactly made those bookings invisible — the toolbar said "2 booked" over a
     board of empty slots. Drop each appointment into the slot whose window
     contains it, and hand back anything outside the day's hours so it can be
     listed rather than lost. */
  function bucketAppointments(appts, slots, slotMinutes) {
    const byKey = new Map(); // `${therapistId}|${slotIso}` → [appt]
    const outside = [];
    const starts = slots.map((s) => new Date(s).getTime());
    const span = (slotMinutes || 45) * 60000;
    for (const a of appts) {
      const t = new Date(a.start).getTime();
      const i = starts.findIndex((s) => t >= s && t < s + span);
      if (i === -1) { outside.push(a); continue; }
      const key = `${a.therapistId}|${slots[i]}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    }
    return { byKey, outside };
  }

  function calendarView(user) {
    const ths = therapists();
    // forget any hidden ids for providers that no longer exist
    [...calHidden].forEach((id) => { if (!ths.some((t) => t.id === id)) calHidden.delete(id); });
    const slots = S.slotsForDay(calDate);
    const appts = S.apptsOn(calDate);
    const { byKey: apptsBySlot, outside: offHours } = bucketAppointments(appts, slots, S.settings().slotMinutes);
    const cols = ths.filter((t) => !calHidden.has(t.id));
    const minW = Math.max(480, 72 + cols.length * 168); // keep columns readable; scroll when many

    // hidden providers keep their bookings off the board on purpose; a hidden
    // column is the user's own doing, so those don't belong in the overflow list
    const stranded = offHours.concat(
      slots.length ? appts.filter((a) => calHidden.has(a.therapistId)) : []
    );

    const board = !ths.length
      ? `<div class="empty-state" style="padding:22px">No PTs to schedule yet — use <b>+ Add PT</b> above to add a provider column.</div>`
      : !cols.length
      ? `<div class="empty-state" style="padding:22px">All PTs are hidden — tap a name under “Providers” to show their column.</div>`
      : !slots.length
      ? `<div class="empty-state" style="padding:22px">The facility is closed on this day.</div>`
      : `
<div class="cal-scroll">
  <div class="cal-grid" style="grid-template-columns: 72px repeat(${cols.length}, minmax(168px, 1fr)); min-width: ${minW}px">
    <div class="cal-cell cal-head cal-corner">Time</div>
    ${cols.map((t) => `<div class="cal-cell cal-head">${esc(t.name)}${S.licenseExpired(t) ? ' <span class="chip bad">expired</span>' : ""}</div>`).join("")}
    ${slots.map((slot) => `
      <div class="cal-cell cal-time">${fmtTime(slot)}</div>
      ${cols.map((t) => {
        const here = apptsBySlot.get(`${t.id}|${slot}`) || [];
        if (here.length) return `<div class="cal-cell">${here.map((a) => `
          <div class="slot-appt" data-appt="${a.id}">${a.start !== slot ? `<b>${fmtTime(a.start)}</b> ` : ""}${esc(S.patientName(S.getPatient(a.patientId)))}
          <small>${esc(a.note || "")}</small></div>`).join("")}</div>`;
        return `<div class="cal-cell"><span class="slot-free" data-slot="${slot}" data-ther="${t.id}">+ available</span></div>`;
      }).join("")}`).join("")}
  </div>
</div>`;

    // Anything the board can't show still has to be visible somewhere, or the
    // toolbar's "N booked" count contradicts an apparently empty day.
    const grid = board + (stranded.length ? `<div class="cal-offhours">
  <p><b>Booked, but not on this board</b> — outside the day's opening hours, or a provider without a column.</p>
  <div class="cal-offhours-list">
    ${stranded.map((a) => `<div class="slot-appt" data-appt="${a.id}">${fmtTime(a.start)} · ${esc(S.patientName(S.getPatient(a.patientId)))}
      <small>${esc((S.getUser(a.therapistId) || {}).name || "")}${a.note ? ` — ${esc(a.note)}` : ""}</small></div>`).join("")}
  </div>
</div>` : "");

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
    <span class="dict-status">${slots.length ? `${slots.length} slots · ${appts.length} booked` : "closed"}</span>
    <span class="cal-toolbar-spacer"></span>
    <button class="btn small soft" id="calAddPt">+ Add PT</button>
  </div>
  ${ths.length ? `<div class="cal-ptbar">
    <span class="cal-ptbar-label">Providers</span>
    ${ths.map((t) => `<button class="calpt-chip ${calHidden.has(t.id) ? "off" : "on"}" data-toggle-pt="${t.id}" title="Show or hide ${esc(t.name)}"><span class="calpt-dot"></span>${esc(t.name)}</button>`).join("")}
    ${calHidden.size ? `<button class="btn small" id="calShowAll">Show all</button>` : ""}
  </div>` : ""}
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
    document.getElementById("printSchedBtn").addEventListener("click", () => printSchedule(user));

    const addPt = document.getElementById("calAddPt");
    if (addPt) addPt.addEventListener("click", () => addProviderModal(user, redraw));
    const showAll = document.getElementById("calShowAll");
    if (showAll) showAll.addEventListener("click", () => { calHidden.clear(); redraw(); });
    document.querySelectorAll("[data-toggle-pt]").forEach((c) =>
      c.addEventListener("click", () => {
        const id = c.dataset.togglePt;
        if (calHidden.has(id)) calHidden.delete(id); else calHidden.add(id);
        redraw();
      }));

    document.querySelectorAll(".slot-free").forEach((s) =>
      s.addEventListener("click", () => bookingModal(user, s.dataset.slot, s.dataset.ther))
    );
    document.querySelectorAll(".slot-appt").forEach((s) =>
      s.addEventListener("click", () => apptModal(user, s.dataset.appt))
    );
  }

  // Add a schedule-only PT column straight from the calendar.
  function addProviderModal(user, done) {
    const m = showModal(`
<h2>Add a PT</h2>
<p style="font-size:12.5px; color:var(--muted); margin-top:0">Adds a therapist column to the calendar so you can book against them. An admin can attach a login later in Facility Admin.</p>
<div class="field"><label>Full name *</label><input id="ptName" placeholder="e.g. Alex Cruz, PT" autocomplete="off" /></div>
<div class="field"><label>License number (optional)</label><input id="ptLic" placeholder="e.g. PT-0012345" autocomplete="off" /></div>
<div class="error" id="ptErr"></div>
<div class="modal-actions">
  <button class="btn" id="ptCancel">Cancel</button>
  <button class="btn primary" id="ptOk">Add PT</button>
</div>`);
    m.querySelector("#ptCancel").addEventListener("click", closeModal);
    m.querySelector("#ptOk").addEventListener("click", () => {
      const res = S.addProvider(m.querySelector("#ptName").value, m.querySelector("#ptLic").value, user);
      if (res.error) { m.querySelector("#ptErr").textContent = res.error; return; }
      closeModal();
      if (done) done(); else render();
    });
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

  /* Print what is on the board, not everything.
     This read `calTherapist`, a variable removed when the therapist dropdown
     became the per-column chips in e92d02f. app.js runs under "use strict", so
     reading it threw a ReferenceError and the button did nothing at all — no
     print dialog, no message. Reading `calHidden` instead both fixes it and
     makes the printout match the filtered board the user is looking at. */
  function printSchedule(user) {
    const shown = therapists().filter((t) => !calHidden.has(t.id));
    const ths = shown.length ? shown : therapists(); // never print a blank page
    const scope = calHidden.size && shown.length
      ? " — " + ths.map((t) => t.name).join(", ")
      : " — all therapists";
    const appts = S.apptsOn(calDate).sort((a, b) => (a.start < b.start ? -1 : 1));
    const html = `
<h1>${esc(S.currentClinicName())}</h1>
<div class="print-muted">Schedule for ${fmtDate(calDate + "T00:00:00")}${esc(scope)} · printed ${fmtDT(new Date().toISOString())} by ${esc(user.name)}</div>
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

  // Maps each audit action to a human phrase, a category tone (drives the badge
  // colour) and a glyph, so the activity log reads like a feed instead of a
  // spreadsheet of raw event codes.
  const AUDIT_META = {
    login: { emoji: "🔓", label: "signed in", tone: "tone-auth" },
    "login-offline": { emoji: "📴", label: "signed in (offline)", tone: "tone-auth" },
    "login-denied": { emoji: "⛔", label: "sign-in denied", tone: "tone-danger" },
    logout: { emoji: "🔒", label: "signed out", tone: "tone-auth" },
    "password-changed": { emoji: "🔑", label: "changed a password", tone: "tone-auth" },
    "doc-created": { emoji: "📝", label: "started a document", tone: "tone-doc" },
    "doc-signed": { emoji: "✒️", label: "signed a document", tone: "tone-doc" },
    "doc-amended": { emoji: "✏️", label: "amended a document", tone: "tone-doc" },
    "doc-imported": { emoji: "📥", label: "imported a document", tone: "tone-doc" },
    "doc-discarded": { emoji: "🗑", label: "discarded an empty draft", tone: "tone-doc" },
    "chart-printed": { emoji: "🖨", label: "printed a chart", tone: "tone-doc" },
    "schedule-printed": { emoji: "🖨", label: "printed the schedule", tone: "tone-doc" },
    "ai-chart-review": { emoji: "✦", label: "ran an AI chart review", tone: "tone-ai" },
    "transcript-refined": { emoji: "✦", label: "cleaned up a transcript", tone: "tone-ai" },
    "insights-generated": { emoji: "✦", label: "generated insights", tone: "tone-ai" },
    "pdf-import-applied": { emoji: "📄", label: "applied a scanned import", tone: "tone-ai" },
    "assistant-query": { emoji: "💬", label: "asked the assistant", tone: "tone-ai" },
    "patient-created": { emoji: "🩺", label: "added a patient", tone: "tone-patient" },
    "patient-updated": { emoji: "🩺", label: "updated a patient", tone: "tone-patient" },
    "attachment-added": { emoji: "📎", label: "added an attachment", tone: "tone-patient" },
    "file-uploaded": { emoji: "📎", label: "uploaded a file", tone: "tone-patient" },
    "appointment-created": { emoji: "📅", label: "booked an appointment", tone: "tone-sched" },
    "appointment-cancelled": { emoji: "🚫", label: "cancelled an appointment", tone: "tone-sched" },
    "appointment-series": { emoji: "📅", label: "scheduled a series", tone: "tone-sched" },
    "reminder-sent": { emoji: "🔔", label: "sent a reminder", tone: "tone-sched" },
    "user-created": { emoji: "🪪", label: "created an account", tone: "tone-admin" },
    "user-updated": { emoji: "🪪", label: "updated an account", tone: "tone-admin" },
    "user-deleted": { emoji: "🪪", label: "removed an account", tone: "tone-admin" },
    "settings-updated": { emoji: "⚙️", label: "updated facility settings", tone: "tone-admin" },
    "access-requested": { emoji: "✋", label: "requested access", tone: "tone-admin" },
    "access-approved": { emoji: "✅", label: "approved an access request", tone: "tone-admin" },
    "access-declined": { emoji: "✖️", label: "declined an access request", tone: "tone-admin" },
    "data-exported": { emoji: "💾", label: "exported a backup", tone: "tone-security" },
    "audio-purged": { emoji: "🎤", label: "purged session audio", tone: "tone-security" },
    "audio-deleted": { emoji: "🎤", label: "deleted session audio", tone: "tone-security" },
    "audio-consent-granted": { emoji: "🎤", label: "recorded audio consent", tone: "tone-security" },
    "audio-consent-revoked": { emoji: "🎤", label: "revoked audio consent", tone: "tone-security" },
    "sync-conflict": { emoji: "🔀", label: "resolved a sync conflict", tone: "tone-security" },
  };
  const auditMeta = (a) => AUDIT_META[a] || { emoji: "•", label: String(a || "activity").replace(/-/g, " "), tone: "tone-default" };

  function auditDayLabel(key) {
    if (!key || key === "unknown") return "Earlier";
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (key === todayIso()) return "Today";
    if (key === localIso(y)) return "Yesterday";
    return fmtDate(key);
  }

  // Each audit tone rolls up to a filterable category chip in the activity log.
  const TONE_CAT = {
    "tone-auth": "auth", "tone-doc": "doc", "tone-ai": "ai", "tone-patient": "patient",
    "tone-sched": "sched", "tone-admin": "admin", "tone-security": "security", "tone-danger": "security",
  };
  const AUDIT_CAT_FILTERS = [
    { key: "all", label: "All" },
    { key: "auth", label: "Sign-ins" },
    { key: "doc", label: "Documents" },
    { key: "ai", label: "AI" },
    { key: "patient", label: "Patients" },
    { key: "sched", label: "Scheduling" },
    { key: "admin", label: "Admin" },
    { key: "security", label: "Security" },
  ];

  // The collapsed "how it works" accordion: each protection topic behind its own
  // disclosure so the page leads with the activity log instead of a wall of text.
  //
  // This copy is a compliance document, not marketing. Under RA 10173 a clinic
  // is the personal information controller and has to be able to tell a patient
  // — and the National Privacy Commission — which processors touch their health
  // data and where. So it names them, and it names the regions, rather than
  // reaching for a comforting absolute.
  //
  // Two claims were removed rather than softened, because they were false:
  // "never a third-party cloud" (Google is a third party, and the whole stack
  // runs there) and "PHI kept in-region" (Gemini 3.x is served from Vertex's
  // GLOBAL endpoint, and Speech-to-Text and the database sit in a US region by
  // default). A prospect's IT person would have found both in an afternoon.
  //
  // The regions are read from /api/ai-status at runtime instead of written into
  // the copy, so redeploying to an Asia region updates the page rather than
  // making it lie. See server.js GEMINI_LOCATION / STT_LOCATION.
  function privacyInfoAccordion(geminiOn) {
    const ai = (window.TheraSync && window.TheraSync.ai) || {};
    const sttLoc = (ai.stt && ai.stt.location) || "us-central1";
    const geminiLoc = (String(ai.engine || "").match(/·\s*([^)]+)\)/) || [])[1] || "global";
    const where = (loc) => loc === "global"
      ? "Google's <b>global</b> Vertex endpoint (Google routes the request; it is not pinned to one country)"
      : `Google's <b>${esc(loc)}</b> region`;

    const items = [
      { emoji: "🔐", title: "Where your data lives & your controls", body: `
        <p>TheraChart runs on <b>your clinic's own Google Cloud project</b> — your database, your storage, your billing account. It is not a shared vendor system where every clinic's records sit in one pile: your data is yours, and each clinic's records are walled off from every other clinic's by a check on the server, not just in the screen.</p>
        <p>Records are kept in an <b>encrypted managed database</b> (Cloud SQL for PostgreSQL). Encrypted in transit and at rest, backed up by Google, and reachable only by this application — never over the open internet.</p>
        <p><b>Where, exactly.</b> Unless your clinic chose otherwise at setup, the application and database run in a <b>United States</b> region. For a Philippine clinic that is a <b>cross-border transfer of sensitive personal information</b>, which RA 10173 permits but requires you to disclose and remain accountable for. A closer region (Singapore or Jakarta) can be chosen at deployment — ask your administrator which one you are on.</p>
        <p style="margin-bottom:0">You stay in control: <b>Export backup</b> takes the whole record set with you in an open format, and <b>Erase all data</b> removes it. Neither needs our permission — there is no lock-in.</p>` },
      { emoji: "🎤", title: "Voice dictation", body: `
        <p>When you dictate, the audio streams to <b>Google Cloud Speech-to-Text</b> in ${where(sttLoc)}, which turns it into text and sends it straight back. It is a paid Google Cloud service under your own project — <b>not</b> a free consumer speech service, and not a phone's built-in dictation.</p>
        <p><b>By default the audio is held only in memory and discarded</b> the moment it is transcribed. Only the transcript is saved to the chart.</p>
        <p style="margin-bottom:0"><b>Optional session-audio review.</b> A clinic can turn on a feature — <b>off by default</b> — that briefly keeps dictation audio <b>for patients who have consented</b>, so a clinician can replay it to check the transcript. Kept audio is <b>deleted the moment the note is signed</b>, or after the clinic's retention window, whichever comes first. The patient's consent is recorded in their chart.</p>` },
      { emoji: "✦", title: `AI cleanup & insights${geminiOn ? " (Gemini)" : ""}`, body: geminiOn
        ? `<p>When you press <b>✦ Review &amp; clean up</b>, ask for <b>insights</b>, or use the <b>patient assistant</b>, the note's <b>text</b> — never the audio — is sent to <b>Google Gemini on Vertex AI</b>, served from ${where(geminiLoc)}. <b>Importing a scanned PDF</b> of past visits sends that document the same way.</p>
        <p>That text can include the patient's name and clinical detail, so treat it as what it is: <b>health information leaving your clinic's region for processing</b>. Google's Vertex AI service terms state that customer prompts and responses are <b>not used to train Google's models</b> and are not sold. Your administrator should keep a copy of those terms with your clinic's records of processing.</p>
        <p style="margin-bottom:0">The AI only ever suggests. Every result is shown for your review, and <b>nothing enters the chart until a licensed clinician approves and signs it</b>.</p>`
        : `<p>Cleanup and insights run on a built-in reviewer <b>right on this device</b> — no clinical text leaves the clinic at all.</p>
        <p style="margin-bottom:0">A clinic can connect <b>Google Gemini on Vertex AI</b> for stronger results and scanned-PDF import; this installation has not. That would send note text out for processing — the page above would then say so. Either way, a licensed clinician reviews and signs everything.</p>` },
      { emoji: "🛡", title: "Who can see what", body: `
        <ul style="margin:0; padding-left:18px; line-height:1.9">
          <li>Everyone signs in with their own account and sees only what their role needs (therapist / front desk / admin)</li>
          <li>Expired licenses and voided accounts lose access automatically</li>
          <li>Signed documents lock — later changes need a signed, authorised amendment, and the original stays readable</li>
          <li>Every notable action is recorded in the activity log below, including who read what</li>
        </ul>` },
      { emoji: "🏛", title: "What your clinic still has to do", body: `
        <p>Software cannot make a clinic compliant on its own. Under the <b>Data Privacy Act of 2012 (RA 10173)</b> your clinic is the <b>personal information controller</b> for these records, and that carries obligations this app can support but not discharge for you:</p>
        <ul style="margin:0 0 10px; padding-left:18px; line-height:1.9">
          <li>Appoint a <b>Data Protection Officer</b> and register your data processing system with the <b>National Privacy Commission</b> if you meet the thresholds</li>
          <li>Obtain and record <b>patient consent</b> covering the cross-border processing described above</li>
          <li>Keep a record of processing activities, and notify the NPC and affected patients of a breach within the required period</li>
          <li>Retain records for the period required of a Philippine health facility</li>
        </ul>
        <p style="margin-bottom:0">If your clinic also serves US patients or bills a US payer, <b>HIPAA</b> applies as well and needs a signed <b>Business Associate Agreement</b> with Google — a contract you execute in your own Google Cloud account, not something this software provides. <b>Have your own counsel or DPO confirm all of this</b>; the descriptions here are of what the software does, not legal advice.</p>` },
    ];
    return `<div class="info-acc">${items.map((it) => `
      <details class="info-acc-item">
        <summary><span class="info-acc-ico">${it.emoji}</span><span class="info-acc-title">${it.title}</span><span class="info-acc-chev">›</span></summary>
        <div class="info-acc-body">${it.body}</div>
      </details>`).join("")}</div>`;
  }

  // Activity-log date window: defaults to today, pageable by day / week / month.
  let auditRange = "day";
  let auditDate = todayIso();      // anchor day (YYYY-MM-DD) inside the window

  function auditWindow() {
    const anchor = new Date(auditDate + "T00:00:00");
    if (auditRange === "week") {
      const dow = (anchor.getDay() + 6) % 7;               // Monday = 0
      const s = new Date(anchor); s.setDate(s.getDate() - dow);
      const e = new Date(s); e.setDate(e.getDate() + 6);
      return { from: localIso(s), to: localIso(e), label: `Week of ${fmtDate(localIso(s) + "T12:00:00")}` };
    }
    if (auditRange === "month") {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const e = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      return { from: localIso(s), to: localIso(e), label: anchor.toLocaleDateString([], { month: "long", year: "numeric" }) };
    }
    return { from: auditDate, to: auditDate, label: auditDayLabel(auditDate) };
  }

  function shiftAudit(dir) {
    const anchor = new Date(auditDate + "T00:00:00");
    if (auditRange === "week") anchor.setDate(anchor.getDate() + dir * 7);
    else if (auditRange === "month") anchor.setMonth(anchor.getMonth() + dir);
    else anchor.setDate(anchor.getDate() + dir);
    auditDate = localIso(anchor);
  }

  function privacyView(user) {
    const win = auditWindow();
    const log = S.auditLog().slice().reverse().filter((e) => {
      const d = e.time ? localIso(new Date(e.time)) : "unknown";
      return d >= win.from && d <= win.to;
    });
    const atToday = win.to >= todayIso();
    const geminiOn = window.TheraSync && window.TheraSync.refine === "gemini";

    // group the feed by calendar day (already newest-first)
    const groups = [];
    const byDay = new Map();
    for (const e of log) {
      const key = e.time ? localIso(new Date(e.time)) : "unknown";
      if (!byDay.has(key)) { const arr = []; byDay.set(key, arr); groups.push({ key, events: arr }); }
      byDay.get(key).push(e);
    }
    const feedRow = (e, dayLabel) => {
      const m = auditMeta(e.action);
      const actor = (S.getUser(e.userId) || {}).name || e.userId || "System";
      const cat = TONE_CAT[m.tone] || "other";
      // day label + full date fold into the search text so typing "today" or a
      // date filters just like the day-group headers read.
      const search = `${actor} ${m.label} ${e.action} ${e.detail || ""} ${dayLabel} ${e.time ? fmtDT(e.time) : ""}`.toLowerCase();
      return `<div class="feed-row" data-search="${esc(search)}" data-cat="${cat}">
        <div class="feed-ico ${m.tone}" title="${esc(e.action)}">${m.emoji}</div>
        <div class="feed-main">
          <div class="feed-line"><b>${esc(actor)}</b> <span class="feed-action">${esc(m.label)}</span></div>
          ${e.detail ? `<div class="feed-detail">${esc(e.detail)}</div>` : ""}
        </div>
        <div class="feed-time" title="${esc(fmtDT(e.time))}">${e.time ? esc(fmtTime(e.time)) : ""}</div>
      </div>`;
    };

    return `
<div class="page-head">
  <div><h1>Privacy &amp; Security</h1><div class="sub">Your clinic's activity log, plus how TheraChart keeps information safe</div></div>
  <div class="page-head-actions">
    ${user.role === "admin" ? `
    <button class="btn small" id="exportDataBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Export backup</button>
    <button class="btn small danger" id="wipeBtn">Erase all data</button>` : ""}
  </div>
</div>

${privacyInfoAccordion(geminiOn)}

<div class="card activity-card">
  <div class="activity-head">
    <div><h2 style="margin:0">Activity log</h2><div class="activity-sub">Newest first · showing <b>${esc(win.label)}</b></div></div>
    <div class="activity-tools">
      <input id="logSearch" type="search" placeholder="Filter within this range…" autocomplete="off" />
      <span class="chip muted" id="logCount">${log.length} events</span>
    </div>
  </div>
  <div class="activity-datenav">
    <div class="datenav-left">
      <button class="btn small dn-arrow" id="auditPrev" title="Previous ${auditRange}" aria-label="Previous ${auditRange}">‹</button>
      <button class="btn small dn-arrow" id="auditNext" title="Next ${auditRange}" aria-label="Next ${auditRange}" ${atToday ? "disabled" : ""}>›</button>
      <button class="btn small" id="auditToday" ${auditRange === "day" && auditDate === todayIso() ? "disabled" : ""}>Today</button>
      <span class="datenav-label">${esc(win.label)}</span>
    </div>
    <div class="rangeseg" id="auditRangeSeg">
      ${["day", "week", "month"].map((r) => `<button class="segbtn ${auditRange === r ? "on" : ""}" data-range="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join("")}
    </div>
  </div>
  <div class="activity-catbar" id="activityCatbar">
    ${AUDIT_CAT_FILTERS.map((c) => `<button class="catchip ${c.key === "all" ? "on" : ""}" data-cat="${c.key}">${c.label}</button>`).join("")}
  </div>
  <div class="activity-feed" id="activityFeed">
    ${groups.map((g) => `
      <div class="feed-day">
        <div class="feed-day-label">${esc(auditDayLabel(g.key))}<span>${g.events.length}</span></div>
        <div class="feed-day-rows">${g.events.map((e) => feedRow(e, auditDayLabel(g.key))).join("")}</div>
      </div>`).join("") || `<div class="empty-state">No events recorded yet.</div>`}
    <div class="feed-empty" id="feedEmpty" hidden><div class="empty-state">No events match your filter.</div></div>
  </div>
</div>`;
  }

  function bindPrivacy(user) {
    // Export and Erase render for admins only, so every binding here has to
    // tolerate a missing element rather than throwing and taking the rest of
    // the page's handlers — audit paging, filtering — down with it.
    const onId = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    onId("exportDataBtn", "click", () => {
      const blob = new Blob([S.exportAll()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `therachart-backup-${todayIso()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      S.audit(user.id, "data-exported", "full backup");
    });
    /* Erase is the most destructive control in the product and it used to sit
       one click from Export, available to every role, describing itself as a
       device-local action. It is not: S.wipeAll() reseeds the whole store and
       the next sync pushes that to the clinic server, so one front-desk click
       destroyed every clinic's records for everyone. Now: admin only (the
       button isn't rendered otherwise), honest about the blast radius, and it
       takes a typed confirmation rather than a second click in the same spot. */
    onId("wipeBtn", "click", () => {
      const m = showModal(`<h2>Erase all data?</h2>
        <p style="font-size:13.5px">This permanently deletes <b>every patient, document, and schedule</b> and restores the demo seed data.</p>
        <p style="font-size:13.5px; color:var(--danger)"><b>This is not limited to this device.</b> The change syncs to the clinic server, so it removes the records for everyone, on every device. It cannot be undone — export a backup first if you might want the data back.</p>
        <div class="field"><label>Type ERASE to confirm</label><input id="wConfirm" autocomplete="off" placeholder="ERASE" /></div>
        <div class="error" id="wErr" style="color:var(--danger); font-size:12.5px; min-height:16px"></div>
        <div class="modal-actions"><button class="btn" id="wCancel">Cancel</button>
        <button class="btn danger" id="wOk">Erase everything</button></div>`);
      m.querySelector("#wCancel").addEventListener("click", closeModal);
      m.querySelector("#wConfirm").focus();
      m.querySelector("#wOk").addEventListener("click", () => {
        if (m.querySelector("#wConfirm").value.trim().toUpperCase() !== "ERASE") {
          m.querySelector("#wErr").textContent = "Type ERASE in the box to confirm.";
          return;
        }
        S.audit(user.id, "data-erased", "all clinic data erased and reseeded");
        S.wipeAll();
        closeModal();
        location.hash = "#/dashboard";
        render();
      });
    });

    // date-window navigation (day / week / month), defaulting to today
    const rerenderPrivacy = () => renderShell(location.hash, privacyView(user), user, bindPrivacy);
    onId("auditPrev", "click", () => { shiftAudit(-1); rerenderPrivacy(); });
    onId("auditNext", "click", () => { shiftAudit(1); rerenderPrivacy(); });
    onId("auditToday", "click", () => { auditRange = "day"; auditDate = todayIso(); rerenderPrivacy(); });
    const seg = document.getElementById("auditRangeSeg");
    if (seg) seg.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      auditRange = b.dataset.range;
      if (auditDate > todayIso()) auditDate = todayIso();
      rerenderPrivacy();
    }));

    // live filter of the activity feed — combines the category chips with the
    // search box (AND), hides any day group that empties out, and updates the
    // count / "no matches" note.
    const search = document.getElementById("logSearch");
    const feed = document.getElementById("activityFeed");
    if (feed) {
      const emptyNote = document.getElementById("feedEmpty");
      const countChip = document.getElementById("logCount");
      const catbar = document.getElementById("activityCatbar");
      const total = feed.querySelectorAll(".feed-row").length;
      let activeCat = "all";
      const apply = () => {
        const q = (search ? search.value : "").trim().toLowerCase();
        let shown = 0;
        feed.querySelectorAll(".feed-row").forEach((row) => {
          const catHit = activeCat === "all" || row.dataset.cat === activeCat;
          const textHit = !q || (row.dataset.search || "").includes(q);
          const hit = catHit && textHit;
          row.hidden = !hit;
          if (hit) shown++;
        });
        feed.querySelectorAll(".feed-day").forEach((day) => {
          day.hidden = !day.querySelector(".feed-row:not([hidden])");
        });
        if (emptyNote) emptyNote.hidden = shown !== 0;
        if (countChip) countChip.textContent = (q || activeCat !== "all") ? `${shown} of ${total}` : `${total} events`;
      };
      if (search) search.addEventListener("input", apply);
      if (catbar) catbar.querySelectorAll(".catchip").forEach((chip) =>
        chip.addEventListener("click", () => {
          activeCat = chip.dataset.cat;
          catbar.querySelectorAll(".catchip").forEach((c) => c.classList.toggle("on", c === chip));
          apply();
        }));
    }
  }

  /* ================= FACILITY ADMIN ================= */

  function accessRequestsCard(user) {
    const pending = S.accessRequests().filter((r) => r.status === "pending")
      .slice().sort((a, b) => ((a.createdAt || "") < (b.createdAt || "") ? 1 : -1));
    return `
<div class="card access-card">
  <div class="access-head">
    <div><h2 style="margin:0">Access requests${pending.length ? ` <span class="chip warn">${pending.length} waiting</span>` : ""}</h2>
      <div class="access-sub">People who tried to sign in with an account that isn't authorized yet. Approve to grant access, or decline.</div></div>
  </div>
  ${pending.length ? `<div class="access-list">${pending.map((r) => `
    <div class="access-req" data-ar="${esc(r.id)}">
      <div class="access-avatar">${esc(initials(r.name || r.email))}</div>
      <div class="access-info">
        <div class="access-name">${esc(r.name || "—")} <span class="chip muted">${esc(r.source || "google")}</span></div>
        <div class="access-email">${esc(r.email)}</div>
        ${r.note ? `<div class="access-note">${esc(r.note)}</div>` : ""}
        <div class="access-meta">Requested ${esc(fmtDT(r.createdAt))}${r.attempts > 1 ? ` · ${r.attempts} attempts` : ""}</div>
      </div>
      <div class="access-actions">
        <select class="access-role" aria-label="Role for ${esc(r.email)}">
          <option value="therapist">Therapist</option>
          <option value="frontdesk">Front desk</option>
          <option value="admin">Administrator</option>
        </select>
        <div style="display:flex; gap:6px">
          <button class="btn small primary" data-approve="${esc(r.id)}">Approve</button>
          <button class="btn small" data-decline="${esc(r.id)}">Decline</button>
        </div>
        <div class="access-msg" data-ar-msg="${esc(r.id)}"></div>
      </div>
    </div>`).join("")}</div>`
    : `<div class="empty-state">No access requests waiting. New requests appear here when someone tries to sign in with an account that hasn't been authorized yet.</div>`}
</div>`;
  }

  function facilityView(user) {
    const st = S.settings();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `
<div class="page-head"><div><h1>Facility Admin</h1><div class="sub">Approvals, settings and staff licenses</div></div></div>
${accessRequestsCard(user)}
<div class="cards-2">
  <div class="card">
    <h2>Facility settings</h2>
    <div class="field"><label>Clinic name</label><input id="st-name" value="${esc(S.currentClinicName())}" /></div>
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
        <div class="field"><label>Email (this is their login)</label><input id="nu-email" type="email" autocapitalize="off" spellcheck="false" placeholder="ana@clinic.com" /></div>
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
    ${S.staff().map((u) => `
      <div style="border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:10px">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
          <b>${esc(u.name)}</b> <span class="chip muted">${esc(roleLabel(u))}</span>
          ${!u.active ? '<span class="chip bad">voided</span>' : S.licenseExpired(u) ? '<span class="chip bad">expired</span>' : S.licenseExpiresSoon(u) ? '<span class="chip warn">expiring soon</span>' : u.license ? '<span class="chip good">active</span>' : ""}
          ${u.mustChangePassword ? '<span class="chip warn">must set password</span>' : ""}
        </div>
        <div style="margin-top:6px"><div class="field" style="margin-bottom:4px"><label>Login email</label><input data-email="${u.id}" type="email" autocapitalize="off" spellcheck="false" value="${esc(u.email || "")}" /></div></div>
        ${u.role !== "frontdesk" ? `<div class="field-row" style="margin-top:8px">
          <div class="field" style="margin-bottom:4px"><label>License number</label><input data-lic-num="${u.id}" value="${esc((u.license && u.license.number) || "")}" placeholder="e.g. PT-0012345" /></div>
          <div class="field" style="margin-bottom:4px"><label>Expires</label><input data-lic-exp="${u.id}" type="date" value="${esc((u.license && u.license.expires) || "")}" /></div>
        </div>
        ${!u.license ? '<div class="banner warn" style="margin-top:6px">No license on file — this account can open charts but cannot create or sign clinical documents until one is added.</div>' : ""}` : ""}
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
      S.renameClinic(document.getElementById("st-name").value.trim() || "TheraChart Clinic", user);
      S.updateSettings({
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
        const emailEl = document.querySelector(`[data-email="${id}"]`);
        const patch = {};
        if (num && exp) patch.license = { number: num.value.trim(), expires: exp.value };
        if (emailEl) patch.email = emailEl.value.trim();
        const res = S.updateUser(id, patch, user);
        if (res && res.error) { const m = document.querySelector(`[data-msg="${id}"]`); if (m) { m.style.color = "var(--danger)"; m.textContent = res.error; } return; }
        render();
      })
    );
    document.querySelectorAll("[data-toggle-user]").forEach((b) =>
      b.addEventListener("click", () => {
        const u = S.getUser(b.dataset.toggleUser);
        const res = S.updateUser(u.id, { active: !u.active }, user);
        if (res && res.error) { const m = document.querySelector(`[data-msg="${u.id}"]`); if (m) { m.style.color = "var(--danger)"; m.textContent = res.error; } return; }
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
        email: document.getElementById("nu-email").value.trim(),
        role,
        password: document.getElementById("nu-pw").value,
        license: role === "frontdesk" ? null : { number: document.getElementById("nu-lic-num").value.trim(), expires: document.getElementById("nu-lic-exp").value },
      };
      if (!fields.name) return fail("Enter a name.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email)) return fail("Enter a valid login email.");
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

    // access-request approvals: approving provisions an account (so the next
    // sign-in works) and re-renders so the new staffer drops into the list.
    const arMsg = (id, text) => { const el = document.querySelector(`[data-ar-msg="${id}"]`); if (el) { el.style.color = "var(--danger)"; el.textContent = text; } };
    document.querySelectorAll("[data-approve]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.approve;
        const card = b.closest(".access-req");
        const role = card ? card.querySelector(".access-role").value : "therapist";
        b.disabled = true;
        const res = S.approveAccessRequest(id, { role }, user);
        if (res.error) { b.disabled = false; return arMsg(id, res.error); }
        render();
      })
    );
    document.querySelectorAll("[data-decline]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.decline;
        b.disabled = true;
        const res = S.declineAccessRequest(id, user);
        if (res.error) { b.disabled = false; return arMsg(id, res.error); }
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
    <h2>Sign-in &amp; security</h2>
    <table class="list"><tbody>
      <tr><td style="color:var(--muted)">Login email</td><td>${esc(user.email || "—")}</td></tr>
      <tr><td style="color:var(--muted)">Sign-in method</td><td>${user.authProvider === "google" ? '<span class="chip muted">Google account</span>' : "Email &amp; password"}</td></tr>
      ${user.authProvider === "google" ? "" : `<tr><td style="color:var(--muted)">Password</td><td>••••••••</td></tr>`}
    </tbody></table>
    ${user.authProvider === "google"
      ? `<p style="font-size:12.5px; color:var(--muted); margin:12px 0 0">You sign in with your Google account, so there's no separate TheraChart password to manage here.</p>`
      : `<button class="btn" id="openPwBtn" style="margin-top:12px">Change password</button>`}
  </div>
</div>`;
  }

  function bindProfile(user) {
    const openBtn = document.getElementById("openPwBtn");
    if (!openBtn) return; // Google accounts have no local password to change
    openBtn.addEventListener("click", () => {
      const m = showModal(`
        <h2>Change password</h2>
        <div class="field"><label>Current password</label><input id="curPw" type="password" autocomplete="current-password" /></div>
        <div class="field"><label>New password (at least 8 characters)</label><input id="newPw" type="password" autocomplete="new-password" /></div>
        <div class="field"><label>Confirm new password</label><input id="confPw" type="password" autocomplete="new-password" /></div>
        <div id="pwMsg" style="font-size:12.5px; min-height:18px; margin:2px 0 4px"></div>
        <div class="modal-actions">
          <button class="btn" id="pwCancel">Cancel</button>
          <button class="btn primary" id="pwSave">Update password</button>
        </div>`);
      m.querySelector("#pwCancel").addEventListener("click", closeModal);
      const curEl = m.querySelector("#curPw");
      curEl.focus();
      const btn = m.querySelector("#pwSave");
      const submit = async () => {
        const cur = m.querySelector("#curPw").value;
        const nw = m.querySelector("#newPw").value;
        const cf = m.querySelector("#confPw").value;
        const msg = m.querySelector("#pwMsg");
        const fail = (t) => { msg.style.color = "var(--danger)"; msg.textContent = t; };
        if (nw.length < 8) return fail("New password must be at least 8 characters.");
        if (nw !== cf) return fail("New passwords don't match.");
        msg.style.color = "var(--muted)"; msg.textContent = "Updating…"; btn.disabled = true;
        const err = await window.TheraSync.changePassword({ currentPassword: cur, newPassword: nw });
        btn.disabled = false;
        if (err) return fail(err);
        msg.style.color = "var(--good)"; msg.textContent = "Password updated.";
        setTimeout(closeModal, 900);
      };
      btn.addEventListener("click", submit);
      m.querySelector("#confPw").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    });
  }

  /* ================= boot ================= */

  window.TheraRender = render; // the sync layer re-renders after remote pulls
  window.addEventListener("hashchange", () => { render(); });
  // remember scroll position per screen so Back returns you where you were
  window.addEventListener("scroll", () => { scrollMem[location.hash || "#/dashboard"] = window.scrollY; }, { passive: true });
  render();
})();
