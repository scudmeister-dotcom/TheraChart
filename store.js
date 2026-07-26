/* TheraChart EMR data layer.
   All records live on this device only (browser localStorage) — there is no
   server and nothing is uploaded. UMD so the same logic is testable in node
   (test/store.test.js) with an injected storage shim. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraStore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KEY = "therachart-emr-v1";

  let storage;
  if (typeof globalThis !== "undefined" && globalThis.THERACHART_STORAGE) {
    storage = globalThis.THERACHART_STORAGE; // server injects file-backed storage
  } else {
    try {
      storage = typeof localStorage !== "undefined" ? localStorage : null;
    } catch (_) {
      storage = null; // storage blocked: fall back to in-memory (session only)
    }
  }
  const memory = {};
  const backend = storage || {
    getItem: (k) => (k in memory ? memory[k] : null),
    setItem: (k, v) => { memory[k] = String(v); },
    removeItem: (k) => { delete memory[k]; },
  };

  /* ---------------------------------------------------------------- *
   *  Seed data — a believable demo clinic so the app is understandable
   *  the moment it opens. PIN for every demo user: 1234.
   * ---------------------------------------------------------------- */

  // local calendar date — a UTC slice lands on the wrong day for part of
  // every day in non-UTC timezones (licenses, "today", day filters)
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const daysFromNow = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  };

  function seed() {
    const today = new Date();
    const t = (n, h, mi) => {
      const d = new Date(today);
      d.setDate(d.getDate() + n);
      d.setHours(h, mi || 0, 0, 0);
      return d.toISOString();
    };

    const seedState = {
      settings: {
        facilityName: "Physical Therapy Center",
        progressEvery: 5, // progress report triggers on this visit number
        slotMinutes: 45,
        dayStartHour: 8,
        dayEndHour: 17,
        workDays: [1, 2, 3, 4, 5, 6], // Mon–Sat
        audioReview: false, // opt-in: temporarily keep Cloud STT audio for review
        audioReviewDays: 7, // backstop auto-delete window for kept audio
      },
      users: [
        {
          id: "u-maria", name: "Maria Santos, PT", email: "maria@therachart.demo", role: "therapist",
          pin: "1234", active: true,
          license: { number: "PT-0012345", expires: daysFromNow(600) },
        },
        {
          id: "u-jose", name: "Jose Ramirez, PT", email: "jose@therachart.demo", role: "therapist",
          pin: "1234", active: true,
          license: { number: "PT-0098765", expires: daysFromNow(-40) }, // expired
        },
        {
          id: "u-carlo", name: "Carlo Mendoza, PT", email: "carlo@therachart.demo", role: "therapist",
          pin: "1234", active: false, // access voided
          license: { number: "PT-0055555", expires: daysFromNow(300) },
        },
        {
          id: "u-ana", name: "Ana Dela Cruz", email: "ana@therachart.demo", role: "frontdesk",
          pin: "1234", active: true, license: null,
        },
        {
          id: "u-grace", name: "Grace Lim, PT (Admin)", email: "grace@therachart.demo", role: "admin",
          pin: "1234", active: true,
          license: { number: "PT-0000111", expires: daysFromNow(50) }, // expiring soon
        },
      ],
      patients: [
        {
          id: "p-juan",
          firstName: "Juan", lastName: "Reyes",
          dob: "1988-04-12", sex: "M",
          address: "12 Mabini St, Cebu City",
          phone: "+63 917 555 0101", email: "juan.reyes@example.com",
          referringPhysician: "Dr. R. Cruz (Ortho)",
          insurance: { provider: "PhilHealth", memberId: "PH-4451-2231", notes: "Co-pay ₱150/visit" },
          attachments: [
            { id: "a-1", name: "Referral - Dr. Cruz.txt", type: "text/plain",
              dataUrl: "data:text/plain;base64," + b64("Referral: Juan Reyes\nDx: Right rotator cuff strain\nPT eval and treat 2-3x/week for 6 weeks.\n- Dr. R. Cruz"),
              uploadedBy: "u-ana", uploadedAt: t(-14, 9, 0) },
          ],
          createdBy: "u-ana", createdAt: t(-14, 8, 30),
        },
        {
          id: "p-liza",
          firstName: "Liza", lastName: "Mercado",
          dob: "1975-11-02", sex: "F",
          address: "88 Osmeña Blvd, Cebu City",
          phone: "+63 917 555 0202", email: "liza.mercado@example.com",
          referringPhysician: "Dr. A. Tan (Family Med)",
          insurance: { provider: "Maxicare", memberId: "MX-99-887766", notes: "" },
          attachments: [],
          createdBy: "u-ana", createdAt: t(-10, 10, 0),
        },
        {
          id: "p-mateo",
          firstName: "Mateo", lastName: "Villanueva",
          dob: "1969-07-19", sex: "M",
          address: "5 Lapu-Lapu Ave, Mandaue City",
          phone: "+63 917 555 0303", email: "mateo.villanueva@example.com",
          referringPhysician: "Dr. L. Gomez (Ortho)",
          insurance: { provider: "PhilHealth", memberId: "PH-7781-4420", notes: "" },
          attachments: [],
          createdBy: "u-ana", createdAt: t(-8, 9, 0),
        },
      ],
      documents: [
        {
          id: "d-eval-juan", patientId: "p-juan", type: "eval",
          title: "Initial Evaluation",
          createdBy: "u-maria", createdAt: t(-13, 10, 0),
          status: "signed",
          signatures: [{ userId: "u-maria", name: "Maria Santos, PT", license: "PT-0012345", time: t(-13, 11, 0), reason: "Original completion" }],
          amendments: [],
          data: {
            reason: "Referred by Dr. R. Cruz for right shoulder pain after lifting injury at work.",
            precautions: "Avoid overhead lifting over 5 lbs. No aggressive stretching in acute range.",
            pmh: "Hypertension, controlled. No prior shoulder surgery.",
            subjective: "Significant sharp pain, right shoulder · rated 7/10 · worse when reaching overhead. Denies numbness or tingling.",
            objectiveText: "Visible guarding with right arm elevation.",
            rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 105 }, { side: "right", joint: "shoulder", motion: "abduction", degrees: 90 }],
            mmt: [{ context: "right shoulder abduction", grade: "4-/5" }],
            special: [{ result: "positive", name: "Neer test" }, { result: "positive", name: "Hawkins Kennedy test" }],
            assessment: "Findings consistent with right rotator cuff strain / subacromial impingement. Good rehab potential.",
            plan: "PT 2-3x/week × 6 weeks: therex, manual therapy, modalities as needed.",
            mapPoints: [{
              key: "Shoulder|right", part: "Shoulder", side: "right", view: "front", x: 60, y: 86,
              notes: [{ time: "", summary: "Sharp pain · rated 7/10 · worse reaching overhead", quote: "", uttId: null, marks: [] }],
            }],
            transcript: [],
          },
        },
        ...[12, 10, 7, 5].map((ago, i) => ({
          id: `d-daily-juan-${i + 1}`, patientId: "p-juan", type: "daily",
          title: `Daily Treatment Note — Visit ${i + 1}`,
          createdBy: "u-maria", createdAt: t(-ago, 14, 0),
          status: "signed",
          signatures: [{ userId: "u-maria", name: "Maria Santos, PT", license: "PT-0012345", time: t(-ago, 14, 40), reason: "Original completion" }],
          amendments: [],
          data: {
            summary: `Visit ${i + 1}: TherEx for rotator cuff (scaption, ER isometrics ×3 sets), manual therapy to posterior capsule, HEP reviewed. Tolerated well.`,
            subjective: i < 2 ? "Pain 6/10 with overhead reach." : "Pain improving, 4/10 today.",
            rom: i >= 2 ? [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 120 + i * 5 }] : [],
            mmt: [], special: [],
            pain: [{ score: i < 2 ? 6 : 4, location: "right shoulder" }],
            mapPoints: [], transcript: [],
          },
        })),
        {
          id: "d-eval-liza", patientId: "p-liza", type: "eval",
          title: "Initial Evaluation",
          createdBy: "u-maria", createdAt: t(-9, 9, 0),
          status: "draft",
          signatures: [], amendments: [],
          data: {
            reason: "Referred for chronic low back pain.",
            precautions: "", pmh: "Type 2 diabetes.",
            subjective: "Shooting pain, lower back, radiating to right leg · worse after prolonged sitting.",
            objectiveText: "", rom: [], mmt: [], special: [], assessment: "", plan: "",
            mapPoints: [], transcript: [],
          },
        },
        // Mateo: a mid-care knee patient — signed eval + visits, plus in-flight
        // draft daily & draft progress notes for the draft picker showcase.
        {
          id: "d-eval-mateo", patientId: "p-mateo", type: "eval",
          title: "Initial Evaluation",
          createdBy: "u-maria", createdAt: t(-8, 10, 0),
          status: "signed",
          signatures: [{ userId: "u-maria", name: "Maria Santos, PT", license: "PT-0012345", time: t(-8, 11, 0), reason: "Original completion" }],
          amendments: [],
          data: {
            reason: "Left knee pain after a fall at home; referred for rehab.",
            precautions: "Weight-bearing as tolerated. Avoid deep squatting.",
            pmh: "Osteoarthritis, both knees.",
            subjective: "Aching left knee · rated 5/10 · worse on stairs.",
            objectiveText: "Mild effusion, antalgic gait.",
            rom: [{ side: "left", joint: "knee", motion: "flexion", degrees: 110 }],
            mmt: [{ context: "left knee extension", grade: "4/5" }],
            special: [], assessment: "Left knee OA flare; good rehab potential.",
            plan: "PT 2x/week × 6 weeks: quad strengthening, gait training.",
            mapPoints: [], transcript: [],
          },
        },
        ...[6, 4, 2].map((ago, i) => ({
          id: `d-daily-mateo-${i + 1}`, patientId: "p-mateo", type: "daily",
          title: `Daily Treatment Note — Visit ${i + 1}`,
          createdBy: "u-maria", createdAt: t(-ago, 11, 0),
          status: "signed",
          signatures: [{ userId: "u-maria", name: "Maria Santos, PT", license: "PT-0012345", time: t(-ago, 11, 40), reason: "Original completion" }],
          amendments: [],
          data: {
            summary: `Visit ${i + 1}: quad sets, terminal knee extension, gait training. Tolerated well.`,
            subjective: "Knee less stiff.", rom: [], mmt: [], special: [],
            pain: [{ score: 4, location: "left knee" }], mapPoints: [], transcript: [],
          },
        })),
        // --- Unsigned drafts: one of every document type, for the showcase ---
        {
          id: "d-daily-mateo-draft", patientId: "p-mateo", type: "daily",
          title: "Daily Treatment Note — Visit 4",
          createdBy: "u-maria", createdAt: t(-1, 11, 30),
          status: "draft", signatures: [], amendments: [],
          data: {
            summary: "Visit 4: progressed to mini-squats and step-ups. Reviewed HEP.",
            subjective: "Stairs easier this week, 3/10.",
            rom: [{ side: "left", joint: "knee", motion: "flexion", degrees: 125 }],
            mmt: [], special: [], pain: [{ score: 3, location: "left knee" }],
            mapPoints: [], transcript: [],
          },
        },
        {
          id: "d-progress-mateo-draft", patientId: "p-mateo", type: "progress",
          title: "Progress Report",
          createdBy: "u-maria", createdAt: t(0, 10, 0),
          status: "draft", signatures: [], amendments: [],
          data: {
            baselineSubjective: "Aching left knee · rated 5/10 · worse on stairs.",
            currentStatus: "Reports 3/10 pain; managing stairs with less difficulty.",
            updatedFindings: "Knee flexion improved to 125° (from 110° at evaluation).",
            goalsProgress: "On track; strengthening progressing well.",
            assessment: "",
            rom: [], mmt: [], special: [], mapPoints: [], transcript: [],
          },
        },
        {
          id: "d-discharge-juan-draft", patientId: "p-juan", type: "discharge",
          title: "Discharge Summary",
          createdBy: "u-maria", createdAt: t(0, 9, 30),
          status: "draft", signatures: [], amendments: [],
          data: {
            summary: "Completed 6-week course of care for right rotator cuff strain.",
            outcome: "",
            recommendations: "Continue home exercise program 3×/week; return if symptoms recur.",
            rom: [], mmt: [], special: [], mapPoints: [], transcript: [],
          },
        },
      ],
      appointments: [
        { id: "ap-1", patientId: "p-juan", therapistId: "u-maria", start: t(0, 9, 0), minutes: 45, note: "Visit 5", status: "booked",
          createdBy: "u-ana", createdAt: t(-3, 11, 0), history: [{ action: "created", userId: "u-ana", time: t(-3, 11, 0) }],
          reminders: [{ when: t(-3, 9, 0), method: "email+sms", status: "sent (simulated)" }, { when: t(0, 7, 0), method: "sms", status: "scheduled (simulated)" }] },
        { id: "ap-2", patientId: "p-liza", therapistId: "u-maria", start: t(0, 10, 30), minutes: 45, note: "", status: "booked",
          createdBy: "u-ana", createdAt: t(-2, 15, 0), history: [{ action: "created", userId: "u-ana", time: t(-2, 15, 0) }],
          reminders: [{ when: t(0, 7, 0), method: "sms", status: "scheduled (simulated)" }] },
        { id: "ap-3", patientId: "p-liza", therapistId: "u-jose", start: t(1, 14, 0), minutes: 45, note: "", status: "booked",
          createdBy: "u-ana", createdAt: t(-1, 9, 0), history: [{ action: "created", userId: "u-ana", time: t(-1, 9, 0) }],
          reminders: [] },
      ],
      // A little activity history so the Privacy &amp; Security log reads like a
      // living feed (varied actions/people) the moment the demo opens.
      audit: [
        { time: t(-14, 8, 30), userId: "u-ana", action: "patient-created", detail: "Juan Reyes" },
        { time: t(-14, 9, 0), userId: "u-ana", action: "attachment-added", detail: "Referral - Dr. Cruz.txt · Juan Reyes" },
        { time: t(-13, 10, 0), userId: "u-maria", action: "doc-created", detail: "Initial Evaluation for Juan Reyes" },
        { time: t(-13, 11, 0), userId: "u-maria", action: "doc-signed", detail: "Initial Evaluation for Juan Reyes" },
        { time: t(-12, 14, 40), userId: "u-maria", action: "doc-signed", detail: "Daily Treatment Note — Visit 1 for Juan Reyes" },
        { time: t(-10, 10, 0), userId: "u-ana", action: "patient-created", detail: "Liza Mercado" },
        { time: t(-9, 9, 20), userId: "u-maria", action: "transcript-refined", detail: "Initial Evaluation · Liza Mercado" },
        { time: t(-7, 15, 0), userId: "u-maria", action: "ai-chart-review", detail: "Juan Reyes" },
        { time: t(-5, 14, 40), userId: "u-maria", action: "doc-signed", detail: "Daily Treatment Note — Visit 4 for Juan Reyes" },
        { time: t(-4, 11, 0), userId: "u-ana", action: "appointment-created", detail: "Juan Reyes · 9:00 AM" },
        { time: t(-3, 16, 20), userId: "u-grace", action: "settings-updated", detail: "progress report every 5 visits" },
        { time: t(-2, 7, 5), userId: null, action: "reminder-sent", detail: "Liza Mercado · SMS (simulated)" },
        { time: t(-1, 8, 15), userId: null, action: "access-requested", detail: "google:ramil.torres@gmail.com" },
        { time: t(0, 7, 50), userId: null, action: "access-requested", detail: "google:bea.n@bayanihanpt.ph" },
      ],
      // Pending sign-in requests awaiting an administrator's approval. Real
      // requests are appended when a Google sign-in isn't yet allow-listed;
      // these two seed the queue so the approval flow can be showcased.
      accessRequests: [
        { id: "ar-ramil", email: "ramil.torres@gmail.com", name: "Ramil Torres", source: "google",
          googleSub: null, status: "pending", note: "New PT hire — starts Monday",
          createdAt: t(-1, 8, 15), _mod: t(-1, 8, 15) },
        { id: "ar-bea", email: "bea.n@bayanihanpt.ph", name: "Bea Navarro", source: "google",
          googleSub: null, status: "pending", note: "Front-desk relief, weekends",
          createdAt: t(0, 7, 50), _mod: t(0, 7, 50) },
      ],
      sessionUserId: null,
      clinics: {
        "clinic-demo": { id: "clinic-demo", name: "Physical Therapy Center" },
        "clinic-fresh": { id: "clinic-fresh", name: "New Clinic" },
      },
    };

    // Everything seeded above belongs to the demo clinic; stamp it so a second
    // clinic — and any brand-new account — starts empty instead of inheriting it.
    ["patients", "documents", "appointments", "audit", "accessRequests", "users"].forEach((k) => {
      (seedState[k] || []).forEach((rec) => { if (!rec.clinicId) rec.clinicId = "clinic-demo"; });
    });

    // A blank clinic with a single admin login, reachable from the demo login
    // picker (fresh@therachart.demo / 1234) — opens to a completely empty EMR.
    seedState.users.push({
      id: "u-fresh", name: "Sam Rivera, PT (Admin)", email: "fresh@therachart.demo", role: "admin",
      pin: "1234", active: true, clinicId: "clinic-fresh",
      license: { number: "PT-0002026", expires: daysFromNow(700) },
    });

    return seedState;
  }

  function b64(s) {
    // btoa is unavailable in node; Buffer is unavailable in browsers
    if (typeof btoa !== "undefined") return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(s, "utf8").toString("base64");
  }

  /* ---------------------------------------------------------------- *
   *  State
   * ---------------------------------------------------------------- */

  let state = null;

  function load() {
    if (state) return state;
    try {
      const raw = backend.getItem(KEY);
      state = raw ? JSON.parse(raw) : seed();
    } catch (_) {
      state = seed();
    }
    // Defensive defaults for keys added after a blob was first persisted
    // (load()/importAll do no migration, so guard collections used elsewhere).
    if (!Array.isArray(state.accessRequests)) state.accessRequests = [];
    save();
    return state;
  }

  let changeHook = null; // sync layer subscribes to pushes
  let importing = false;

  function save() {
    try {
      backend.setItem(KEY, JSON.stringify(state));
    } catch (_) { /* storage full/blocked — keep going in memory */ }
    if (changeHook && !importing) changeHook();
  }

  function setChangeHook(fn) { changeHook = fn; }

  /** Replace local state with a server copy, keeping this device's session. */
  function importAll(next, { preserveSession = true } = {}) {
    load();
    const session = state.sessionUserId;
    importing = true;
    try {
      state = typeof next === "string" ? JSON.parse(next) : next;
      if (preserveSession) state.sessionUserId = session;
      save();
    } finally {
      importing = false;
    }
  }

  function resetAll() {
    state = seed();
    save();
  }

  function wipeAll() {
    backend.removeItem(KEY);
    state = seed();
    save();
  }

  const uid = (prefix) =>
    `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

  // every mutation stamps the entity so offline edits can merge newest-wins
  const touch = (obj) => { if (obj) obj._mod = new Date().toISOString(); };

  /* ---------------------------------------------------------------- *
   *  Audit log — every access-relevant action is recorded
   * ---------------------------------------------------------------- */

  function audit(userId, action, detail) {
    load();
    state.audit.push({ time: new Date().toISOString(), userId, clinicId: (getUser(userId) || {}).clinicId || currentClinicId(), action, detail: detail || "" });
    if (state.audit.length > 2000) state.audit.splice(0, state.audit.length - 2000);
    save();
  }

  /* ---------------------------------------------------------------- *
   *  Users, auth, license gating
   * ---------------------------------------------------------------- */

  const getUser = (id) => load().users.find((u) => u.id === id) || null;
  const normEmail = (e) => String(e == null ? "" : e).trim().toLowerCase();
  const getUserByEmail = (email) => {
    const e = normEmail(email);
    return e ? load().users.find((u) => normEmail(u.email) === e) || null : null;
  };
  // Employees sign in by email; fall back to id for older links/back-compat.
  const findUserByLogin = (identifier) => getUserByEmail(identifier) || getUser(identifier);

  function licenseExpired(user) {
    if (!user || !user.license || !user.license.expires) return false; // no license / no expiry set
    return user.license.expires < iso(new Date());
  }

  function licenseExpiresSoon(user, days = 60) {
    if (!user || !user.license || licenseExpired(user)) return false;
    return user.license.expires <= daysFromNow(days);
  }

  /** Can this user open clinical records and documents at all? */
  function canAccessEmr(user) {
    if (!user || !user.active) return false;
    if (user.role === "frontdesk") return true; // scheduling + intake only
    return !licenseExpired(user);
  }

  /** Can this user create/edit/sign clinical documents? */
  function canDocument(user) {
    if (!user || !user.active) return false;
    if (user.role === "frontdesk") return false;
    return !!user.license && !licenseExpired(user);
  }

  /* Credentials. The server injects a hashed-password authenticator (scrypt via
     node crypto); the browser-only demo has no authenticator and falls back to
     the legacy plaintext `pin` (local-only, protects nothing the user can't
     already read in localStorage). So password hashing stays out of this shared,
     synchronous module and lives on the server. */
  let authenticator = null;
  function setAuthenticator(a) { authenticator = a; }

  function verifyCredential(user, secret) {
    if (authenticator) return authenticator.verify(user, secret);
    return user.pin != null && user.pin === String(secret); // demo fallback
  }

  /** Verify a user's password WITHOUT starting a session (for re-auth checks). */
  function verifyPassword(userId, secret) {
    const u = getUser(userId);
    return !!u && verifyCredential(u, secret);
  }

  /** Set/replace a user's password. With an authenticator it's hashed and the
      legacy plaintext pin is dropped; without one (demo) it stays a plain pin.
      opts.mustChange=true marks it as temporary (forces a change at next login). */
  function setPassword(userId, secret, byUser, opts) {
    const u = getUser(userId);
    if (!u) return { error: "User not found." };
    const s = String(secret == null ? "" : secret);
    if (s.length < 8) return { error: "Password must be at least 8 characters." };
    if (authenticator) { u.passwordHash = authenticator.hash(s); delete u.pin; }
    else { u.pin = s; }
    if (opts && opts.mustChange) u.mustChangePassword = true; else delete u.mustChangePassword;
    touch(u);
    save();
    audit(byUser ? byUser.id : userId, "password-changed", u.name);
    return { user: u };
  }

  const ROLES = ["therapist", "admin", "frontdesk"];

  /** Create a new employee. Their initial password is temporary — they're
      forced to set their own at first login (mustChangePassword). */
  function addUser(fields, byUser) {
    load();
    const name = String((fields && fields.name) || "").trim();
    const email = normEmail(fields && fields.email);
    const role = ROLES.includes(fields && fields.role) ? fields.role : "therapist";
    const password = String((fields && fields.password) || "");
    if (!name) return { error: "Name is required." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "A valid email is required (it's their login)." };
    if (getUserByEmail(email)) return { error: "That email is already in use by another account." };
    if (password.length < 8) return { error: "Temporary password must be at least 8 characters." };
    const user = {
      id: uid("u"), name, email, role, active: true,
      clinicId: (byUser && byUser.clinicId) || currentClinicId(),
      license: role === "frontdesk" ? null
        : { number: String((fields.license && fields.license.number) || "").trim(),
            expires: String((fields.license && fields.license.expires) || "").trim() },
      mustChangePassword: true,
    };
    if (authenticator) user.passwordHash = authenticator.hash(password);
    else user.pin = password;
    touch(user);
    state.users.push(user);
    save();
    audit(byUser ? byUser.id : null, "user-created", `${name} (${role})`);
    return { user };
  }

  /** Create a schedule-only provider (a PT column on the calendar) without a
      login. Lets you flesh out the schedule board quickly; an admin can later
      attach an email/password in Facility Admin to make it a full account. */
  function addProvider(name, licenseNumber, byUser) {
    load();
    const nm = String(name || "").trim();
    if (!nm) return { error: "Name is required." };
    const user = {
      id: uid("u"), name: nm, email: "", role: "therapist", active: true, provider: true,
      clinicId: (byUser && byUser.clinicId) || currentClinicId(),
      license: { number: String(licenseNumber || "").trim(), expires: daysFromNow(365 * 4) },
    };
    touch(user);
    state.users.push(user);
    save();
    audit(byUser ? byUser.id : null, "provider-created", `${nm} (PT)`);
    return { user };
  }

  /** Find-or-create an account that authenticates via Google (no password).
      The email and role arrive already verified by the server (Google ID-token
      check + allowlist), so this trusts them. An existing account is reactivated
      and re-roled to match the allowlist (the allowlist is the source of truth
      for who may sign in with Google, and as what). Google accounts get NO
      license — a clinician's license number is added later by an admin via the
      staff editor, which is also what unlocks e-signing (canDocument). Leaving
      it null (rather than blank) keeps EMR access open (see licenseExpired). */
  function upsertGoogleUser(fields) {
    load();
    const email = normEmail(fields && fields.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "A valid Google email is required." };
    const role = ROLES.includes(fields && fields.role) ? fields.role : "therapist";
    const name = String((fields && fields.name) || "").trim() || email.split("@")[0];
    const sub = fields && fields.googleSub ? String(fields.googleSub) : null;

    let user = getUserByEmail(email);
    if (user) {
      user.active = true;
      user.role = role;
      if (role === "frontdesk") user.license = null; // front desk never carries one
      user.authProvider = "google";
      if (sub) user.googleSub = sub;
      delete user.mustChangePassword; // Google users have no password to set
      touch(user);
      save();
      audit(user.id, "login", "google");
      return { user };
    }

    user = {
      id: uid("u"), name, email, role, active: true,
      license: null, authProvider: "google",
    };
    if (sub) user.googleSub = sub;
    touch(user);
    state.users.push(user);
    save();
    audit(user.id, "user-created", `${name} (${role}, google)`);
    audit(user.id, "login", "google");
    return { user };
  }

  /** Remove an employee. Can't delete yourself or the last active admin. */
  function deleteUser(userId, byUser) {
    load();
    const u = getUser(userId);
    if (!u) return { error: "User not found." };
    if (byUser && byUser.id === userId) return { error: "You can't delete your own account." };
    const otherAdmins = state.users.filter((x) => x.role === "admin" && x.active && x.id !== userId);
    if (u.role === "admin" && u.active && otherAdmins.length === 0) return { error: "Can't delete the last active administrator." };
    state.users = state.users.filter((x) => x.id !== userId);
    save();
    audit(byUser ? byUser.id : null, "user-deleted", u.name);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- *
   *  Access requests — a pending-approval queue. A request is recorded
   *  when someone tries to sign in with a Google account that isn't yet
   *  authorized; an admin then approves it (which provisions an active
   *  account so the next sign-in succeeds) or declines it. Kept in state
   *  so it syncs to every device like any other collection.
   * ---------------------------------------------------------------- */

  function accessRequests() {
    load();
    if (!Array.isArray(state.accessRequests)) state.accessRequests = [];
    return state.accessRequests.filter(mine);
  }

  /** Record (or refresh) a pending request. Deduped by email while still
      pending, so repeated sign-in attempts don't pile up. */
  function requestAccess(fields) {
    load();
    if (!Array.isArray(state.accessRequests)) state.accessRequests = [];
    const email = normEmail(fields && fields.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "A valid email is required." };
    const existing = getUserByEmail(email);
    if (existing && existing.active) return { user: existing }; // already authorized
    const name = String((fields && fields.name) || "").trim() || email.split("@")[0];
    const sub = fields && fields.googleSub ? String(fields.googleSub) : null;
    const source = (fields && fields.source) || "google";

    let req = state.accessRequests.find((r) => normEmail(r.email) === email && r.status === "pending");
    if (req) {
      req.attempts = (req.attempts || 1) + 1;
      req.name = req.name || name;
      if (sub) req.googleSub = sub;
      touch(req);
    } else {
      req = {
        id: uid("ar"), email, name, source, googleSub: sub,
        status: "pending", note: "", attempts: 1, createdAt: new Date().toISOString(),
      };
      touch(req);
      state.accessRequests.push(req);
    }
    save();
    audit(null, "access-requested", `${source}:${email}`);
    return { request: req };
  }

  /** Approve a pending request: provision an active Google account with the
      chosen role, then mark the request resolved (kept for the audit trail). */
  function approveAccessRequest(id, opts, byUser) {
    load();
    const req = accessRequests().find((r) => r.id === id);
    if (!req) return { error: "That request no longer exists." };
    if (req.status !== "pending") return { error: "That request has already been handled." };
    const role = ROLES.includes(opts && opts.role) ? opts.role : "therapist";
    const email = normEmail(req.email);
    let user = getUserByEmail(email);
    if (user) {
      user.active = true;
      user.role = role;
      if (role === "frontdesk") user.license = null;
      user.authProvider = "google";
      if (req.googleSub) user.googleSub = req.googleSub;
      delete user.mustChangePassword;
      touch(user);
    } else {
      user = {
        id: uid("u"), name: req.name || email.split("@")[0], email, role,
        active: true, license: null, authProvider: "google",
      };
      if (req.googleSub) user.googleSub = req.googleSub;
      touch(user);
      state.users.push(user);
    }
    req.status = "approved";
    req.role = role;
    req.resolvedBy = byUser ? byUser.id : null;
    req.resolvedAt = new Date().toISOString();
    touch(req);
    save();
    audit(byUser ? byUser.id : null, "user-created", `${user.name} (${role}, google)`);
    audit(byUser ? byUser.id : null, "access-approved", `${email} (${role})`);
    return { user, request: req };
  }

  /** Decline a pending request — kept (marked declined) for the audit trail. */
  function declineAccessRequest(id, byUser) {
    load();
    const req = accessRequests().find((r) => r.id === id);
    if (!req) return { error: "That request no longer exists." };
    if (req.status !== "pending") return { error: "That request has already been handled." };
    req.status = "declined";
    req.resolvedBy = byUser ? byUser.id : null;
    req.resolvedAt = new Date().toISOString();
    touch(req);
    save();
    audit(byUser ? byUser.id : null, "access-declined", req.email);
    return { ok: true, request: req };
  }

  /** One-time: hash any legacy plaintext pins into passwordHash (server only). */
  function hashLegacyPins() {
    if (!authenticator) return 0;
    load();
    let n = 0;
    for (const u of state.users) {
      if (u.pin != null && !u.passwordHash) { u.passwordHash = authenticator.hash(String(u.pin)); delete u.pin; touch(u); n++; }
    }
    if (n) save();
    return n;
  }

  /** One-time: give every account a login email if it lacks one (so accounts
      created before email-login can still sign in). Derived from the name;
      the admin can edit it to a real address. Returns the number assigned. */
  function ensureEmails() {
    load();
    const taken = new Set(state.users.map((u) => normEmail(u.email)).filter(Boolean));
    let n = 0;
    for (const u of state.users) {
      if (normEmail(u.email)) continue;
      const slug = String(u.name || u.id).toLowerCase().replace(/,.*$/, "").trim()
        .replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "user";
      let email = `${slug}@therachart.demo`, i = 2;
      while (taken.has(email)) email = `${slug}${i++}@therachart.demo`;
      u.email = email; taken.add(email); touch(u); n++;
    }
    if (n) save();
    return n;
  }

  /** identifier = email (or a user id for back-compat). null on success, or a
      human-readable reason the login was refused. The refusal message is kept
      generic (never "unknown email") so it can't be used to probe who exists. */
  function login(identifier, secret) {
    load();
    const user = findUserByLogin(identifier);
    if (!user) return "Incorrect email or password.";
    if (!user.active) {
      audit(user.id, "login-denied", "access voided");
      return "Access for this account has been voided. Contact your administrator.";
    }
    if (!verifyCredential(user, secret)) {
      audit(user.id, "login-denied", "wrong password");
      return "Incorrect email or password.";
    }
    state.sessionUserId = user.id;
    save();
    audit(user.id, "login", user.role);
    return null;
  }

  function logout() {
    load();
    if (state.sessionUserId) audit(state.sessionUserId, "logout", "");
    state.sessionUserId = null;
    save();
  }

  const currentUser = () => getUser(load().sessionUserId);

  /* ---------------------------------------------------------------- *
   *  Clinics (tenancy) — every clinical record carries a clinicId, and
   *  reads are scoped to the signed-in user's clinic so separate accounts
   *  don't share patients, documents, schedule, or the activity log.
   *  (Scheduling hours in `settings` stay a shared facility default.)
   * ---------------------------------------------------------------- */
  const DEFAULT_CLINIC = "clinic-demo";
  const currentClinicId = () => (currentUser() || {}).clinicId || DEFAULT_CLINIC;
  const recClinic = (rec) => (rec && rec.clinicId) || DEFAULT_CLINIC; // legacy/un-stamped → demo clinic
  const mine = (rec) => recClinic(rec) === currentClinicId();
  const clinicsMap = () => load().clinics || {};
  const clinicName = (id) => (clinicsMap()[id] && clinicsMap()[id].name) || load().settings.facilityName || "TheraChart Clinic";
  const currentClinicName = () => clinicName(currentClinicId());
  function renameClinic(name, byUser) {
    load();
    const nm = String(name || "").trim();
    if (!nm) return { error: "Clinic name is required." };
    const id = currentClinicId();
    state.clinics = state.clinics || {};
    state.clinics[id] = { ...(state.clinics[id] || { id }), id, name: nm };
    save();
    audit(byUser ? byUser.id : null, "settings-updated", `clinic renamed to ${nm}`);
    return { name: nm };
  }

  /* ---------------------------------------------------------------- *
   *  Patients
   * ---------------------------------------------------------------- */

  const getPatient = (id) => load().patients.find((p) => p.id === id) || null;
  const patientName = (p) => (p ? `${p.lastName}, ${p.firstName}` : "Unknown");

  function addPatient(fields, byUserId) {
    load();
    const patient = Object.assign(
      { id: uid("p"), clinicId: currentClinicId(), attachments: [], createdBy: byUserId, createdAt: new Date().toISOString() },
      fields
    );
    touch(patient);
    state.patients.push(patient);
    save();
    audit(byUserId, "patient-created", patientName(patient));
    return patient;
  }

  function updatePatient(id, fields, byUserId) {
    const p = getPatient(id);
    if (!p) return null;
    Object.assign(p, fields);
    touch(p);
    save();
    audit(byUserId, "patient-updated", patientName(p));
    return p;
  }

  /* ---------------------------------------------------------------- *
   *  Documents: create, sign/lock, amend
   * ---------------------------------------------------------------- */

  const docsFor = (patientId) =>
    load().documents.filter((d) => d.patientId === patientId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const getDoc = (id) => load().documents.find((d) => d.id === id) || null;

  const DOC_TITLES = {
    daily: "Daily Treatment Note",
    eval: "Initial Evaluation",
    progress: "Progress Report",
    discharge: "Discharge Summary",
  };

  function visitCount(patientId) {
    return docsFor(patientId).filter((d) => d.type === "daily").length;
  }

  /** Does this patient need a progress report? Triggered every N daily
      visits (N is facility-configurable) until one is written after the
      Nth visit. */
  function progressDue(patientId) {
    load();
    const every = state.settings.progressEvery || 5;
    const dailies = docsFor(patientId).filter((d) => d.type === "daily");
    if (dailies.length < every) return false;
    const milestones = Math.floor(dailies.length / every);
    const reports = docsFor(patientId).filter((d) => d.type === "progress").length;
    return reports < milestones;
  }

  function createDoc(patientId, type, byUser) {
    if (!canDocument(byUser)) return { error: "Your account can’t create clinical documents." };
    load();
    const data = { mapPoints: [], transcript: [], rom: [], mmt: [], special: [], pain: [] };
    if (type === "eval") Object.assign(data, { reason: "", precautions: "", pmh: "", subjective: "", objectiveText: "", assessment: "", plan: "" });
    // a daily treatment note is a SOAP note: subjective, objective (the
    // measurement tables + body map), assessment, plan — the last two are what
    // make the visit defensible to a payer or a reviewing clinician
    if (type === "daily") Object.assign(data, { summary: "", subjective: "", assessment: "", plan: "" });
    if (type === "discharge") Object.assign(data, { summary: "", outcome: "", recommendations: "" });
    if (type === "progress") {
      // carry over subjective baseline from the signed evaluation
      const evalDoc = docsFor(patientId).find((d) => d.type === "eval");
      Object.assign(data, {
        baselineSubjective: evalDoc ? evalDoc.data.subjective || "" : "",
        currentStatus: "", updatedFindings: "", goalsProgress: "", assessment: "",
      });
    }
    const doc = {
      id: uid("d"), patientId, clinicId: (getPatient(patientId) || {}).clinicId || currentClinicId(), type,
      title: type === "daily" ? `${DOC_TITLES.daily} — Visit ${visitCount(patientId) + 1}` : DOC_TITLES[type],
      createdBy: byUser.id, createdAt: new Date().toISOString(),
      status: "draft", signatures: [], amendments: [], data,
    };
    touch(doc);
    state.documents.push(doc);
    save();
    audit(byUser.id, "doc-created", `${doc.title} for ${patientName(getPatient(patientId))}`);
    return { doc };
  }

  /** Create a locked historical document from an imported (scanned) record.
      Dated with the original visit date so it sorts into the chart's
      chronology; locked from the start (the scan is the source of truth) with
      the importing clinician's attestation — corrections go via amendment. */
  function addImportedDoc(patientId, { type, date, title, data }, byUser, sourceName) {
    if (!canDocument(byUser)) return { error: "Your account can’t create clinical documents." };
    load();
    const t = DOC_TITLES[type] ? type : "daily";
    const when = date ? new Date(date + "T12:00:00") : new Date();
    const doc = {
      id: uid("d"), patientId, clinicId: (getPatient(patientId) || {}).clinicId || currentClinicId(), type: t,
      title: title || `${DOC_TITLES[t]} — ${date || "undated"} (imported)`,
      createdBy: byUser.id,
      createdAt: (isNaN(when.getTime()) ? new Date() : when).toISOString(),
      status: "signed",
      imported: true,
      signatures: [{
        userId: byUser.id, name: byUser.name,
        license: byUser.license ? byUser.license.number : null,
        time: new Date().toISOString(),
        reason: `Imported from scanned document${sourceName ? ` (${sourceName})` : ""}`,
      }],
      amendments: [],
      data: Object.assign({ mapPoints: [], transcript: [], rom: [], mmt: [], special: [], pain: [] }, data),
    };
    touch(doc);
    state.documents.push(doc);
    save();
    audit(byUser.id, "doc-imported", `${doc.title} for ${patientName(getPatient(patientId))}`);
    return { doc };
  }

  function updateDocData(docId, patch, byUser) {
    const doc = getDoc(docId);
    if (!doc) return { error: "Document not found." };
    if (!canDocument(byUser)) return { error: "Your account can’t edit clinical documents." };
    if (doc.status === "signed") return { error: "Document is locked. Use an amendment (requires e-signature)." };
    Object.assign(doc.data, patch);
    touch(doc);
    save();
    return { doc };
  }

  /** Delete an unsigned draft outright (never a signed record — those are
      permanent and can only be amended). Used to discard drafts created by
      accident and left empty. */
  function deleteDoc(docId, byUser) {
    load();
    const doc = getDoc(docId);
    if (!doc) return { error: "Document not found." };
    if (doc.status === "signed") return { error: "Signed documents can't be deleted." };
    state.documents = state.documents.filter((d) => d.id !== docId);
    save();
    if (byUser) audit(byUser.id, "doc-discarded", `${doc.title} (empty draft) for ${patientName(getPatient(doc.patientId))}`);
    return { ok: true };
  }

  /** Lock + e-sign. typedName must match the signing user's name. */
  function signDoc(docId, byUser, typedName, reason) {
    const doc = getDoc(docId);
    if (!doc) return { error: "Document not found." };
    if (!canDocument(byUser)) return { error: "Your license does not allow signing documents." };
    if (typedName.trim().toLowerCase() !== byUser.name.trim().toLowerCase())
      return { error: "Typed name must exactly match your registered name to e-sign." };
    doc.signatures.push({
      userId: byUser.id, name: byUser.name,
      license: byUser.license ? byUser.license.number : null,
      time: new Date().toISOString(),
      reason: reason || (doc.status === "draft" ? "Original completion" : "Amendment"),
    });
    doc.status = "signed";
    touch(doc);
    save();
    audit(byUser.id, "doc-signed", doc.title);
    return { doc };
  }

  /** Amend a locked document: the original stays intact; the amendment is
      appended with its own e-signature. */
  function amendDoc(docId, byUser, typedName, amendText, reason) {
    const doc = getDoc(docId);
    if (!doc) return { error: "Document not found." };
    if (!canDocument(byUser)) return { error: "Your license does not allow amending documents." };
    if (doc.status !== "signed") return { error: "Only signed documents can be amended." };
    if (typedName.trim().toLowerCase() !== byUser.name.trim().toLowerCase())
      return { error: "Typed name must exactly match your registered name to e-sign." };
    if (!amendText.trim()) return { error: "Amendment text is required." };
    if (!reason || !reason.trim()) return { error: "An authorization reason is required to amend a locked document." };
    doc.amendments.push({
      text: amendText.trim(), reason: reason.trim(),
      userId: byUser.id, name: byUser.name,
      license: byUser.license ? byUser.license.number : null,
      time: new Date().toISOString(),
    });
    touch(doc);
    save();
    audit(byUser.id, "doc-amended", `${doc.title}: ${reason.trim()}`);
    return { doc };
  }

  /* ---------------------------------------------------------------- *
   *  Appointments + reminders
   * ---------------------------------------------------------------- */

  function slotsForDay(dateIso) {
    load();
    const { dayStartHour, dayEndHour, slotMinutes, workDays } = state.settings;
    const day = new Date(dateIso + "T00:00:00");
    if (!workDays.includes(day.getDay())) return [];
    const slots = [];
    const cur = new Date(day);
    cur.setHours(dayStartHour, 0, 0, 0);
    const end = new Date(day);
    end.setHours(dayEndHour, 0, 0, 0);
    while (cur < end) {
      slots.push(cur.toISOString());
      cur.setMinutes(cur.getMinutes() + slotMinutes);
    }
    return slots;
  }

  const apptsOn = (dateIso) =>
    load().appointments.filter((a) => a.status !== "cancelled" && mine(a) && iso(new Date(a.start)) === dateIso);

  function bookAppointment({ patientId, therapistId, start, note }, byUser) {
    load();
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) return { error: "Invalid appointment time." };
    // Overlap, not an exact time match: two visits that merely start at
    // different minutes still put one therapist in two places at once.
    const mins = state.settings.slotMinutes;
    const from = startDate.getTime(), to = from + mins * 60000;
    const clash = state.appointments.some((a) => {
      if (a.status === "cancelled" || a.therapistId !== therapistId) return false;
      const aFrom = new Date(a.start).getTime();
      if (isNaN(aFrom)) return false;
      return aFrom < to && aFrom + (a.minutes || mins) * 60000 > from;
    });
    if (clash) return { error: "That therapist already has a booking overlapping this time." };
    const remind3d = new Date(startDate); remind3d.setDate(remind3d.getDate() - 3); remind3d.setHours(9, 0, 0, 0);
    const remindAm = new Date(startDate); remindAm.setHours(7, 0, 0, 0);
    const appt = {
      id: uid("ap"), patientId, therapistId, clinicId: (getPatient(patientId) || {}).clinicId || currentClinicId(), start,
      minutes: state.settings.slotMinutes, note: note || "", status: "booked",
      createdBy: byUser.id, createdAt: new Date().toISOString(),
      history: [{ action: "created", userId: byUser.id, time: new Date().toISOString() }],
      reminders: [
        { when: remind3d.toISOString(), method: "email+sms", status: "scheduled (simulated)" },
        { when: remindAm.toISOString(), method: "sms", status: "scheduled (simulated)" },
      ],
    };
    touch(appt);
    state.appointments.push(appt);
    save();
    audit(byUser.id, "appointment-created", `${patientName(getPatient(patientId))} @ ${start}`);
    return { appt };
  }

  /** Book a whole course of visits at once. `starts` is an array of ISO slot
      times (generated by the caller from a recurrence pattern). Each slot is
      booked with the normal reminder logic; any that clash with an existing
      booking (or are invalid) are skipped and reported, so a partial series
      still goes through. Returns { booked:[appt], skipped:[{start,reason}] }. */
  function bookSeries({ patientId, therapistId, starts, note }, byUser) {
    load();
    const booked = [], skipped = [];
    for (const start of starts || []) {
      const res = bookAppointment({ patientId, therapistId, start, note }, byUser);
      if (res.error) skipped.push({ start, reason: res.error });
      else booked.push(res.appt);
    }
    if (booked.length) audit(byUser.id, "appointment-series", `${booked.length} visit${booked.length === 1 ? "" : "s"} booked for ${patientName(getPatient(patientId))}`);
    return { booked, skipped };
  }

  /** Persist a patient's most recent AI chart review so it isn't re-run more
      than once a day. `review` = { ranOn: "YYYY-MM-DD", ranAt: ISO, result }. */
  function saveAiReview(patientId, review) {
    const p = getPatient(patientId);
    if (!p) return null;
    p.aiReview = review;
    touch(p);
    save();
    return p;
  }

  /* --------- Patient action items (accepted AI recs → needs attention) ------ *
   *  Recommendations from the AI chart review can be accepted onto a patient's
   *  "needs attention" list, completed (with an optional note) into their care
   *  history as a recommendation that was performed, or dismissed/deleted.     */

  // A stable key for an AI recommendation so it can be hidden once actioned.
  const recKey = (rec) => (typeof rec === "string" ? rec : (rec && rec.action) || "").trim().toLowerCase();

  /** Accept an AI recommendation: promote it to the patient's action items
      ("needs attention") and record its key so the AI review hides it. */
  function acceptRecommendation(patientId, rec, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    p.actionItems = p.actionItems || [];
    const key = recKey(rec);
    if (key && p.actionItems.some((it) => it.aiKey === key)) return { dup: true };
    const item = {
      id: uid("act"), text: rec.action || String(rec), rationale: rec.rationale || "",
      priority: rec.priority || "routine", source: "ai", aiKey: key,
      createdBy: byUser.id, createdAt: new Date().toISOString(),
    };
    p.actionItems.push(item);
    touch(p); save();
    audit(byUser.id, "recommendation-accepted", `${patientName(p)}: ${item.text}`);
    return { item };
  }

  /** Dismiss an AI recommendation outright (never becomes an action item). */
  function dismissRecommendation(patientId, rec, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    p.aiDismissed = p.aiDismissed || [];
    const key = recKey(rec);
    if (key && !p.aiDismissed.includes(key)) p.aiDismissed.push(key);
    touch(p); save();
    audit(byUser.id, "recommendation-dismissed", `${patientName(p)}: ${rec.action || rec}`);
    return { ok: true };
  }

  /** Add a manual (non-AI) task to a patient's needs-attention list. */
  function addActionItem(patientId, text, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    const t = (text || "").trim();
    if (!t) return { error: "Enter a task." };
    p.actionItems = p.actionItems || [];
    const item = { id: uid("act"), text: t, rationale: "", priority: "routine", source: "manual", aiKey: null, createdBy: byUser.id, createdAt: new Date().toISOString() };
    p.actionItems.push(item);
    touch(p); save();
    audit(byUser.id, "action-item-added", `${patientName(p)}: ${t}`);
    return { item };
  }

  /** Complete an action item: move it into the patient's care history as a
      recommendation that was carried out, with an optional note. */
  function completeActionItem(patientId, itemId, note, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    p.actionItems = p.actionItems || [];
    const idx = p.actionItems.findIndex((it) => it.id === itemId);
    if (idx < 0) return { error: "Item not found." };
    const item = p.actionItems.splice(idx, 1)[0];
    p.careHistory = p.careHistory || [];
    const entry = {
      id: item.id, text: item.text, rationale: item.rationale || "", source: item.source || "ai", aiKey: item.aiKey || null,
      recommendedAt: item.createdAt, recommendedBy: item.createdBy,
      completedAt: new Date().toISOString(), completedBy: byUser.id, note: (note || "").trim(),
    };
    p.careHistory.push(entry);
    touch(p); save();
    audit(byUser.id, "recommendation-completed", `${patientName(p)}: ${entry.text}${entry.note ? ` — ${entry.note}` : ""}`);
    return { entry };
  }

  /** Delete an action item without recording it as performed. */
  function deleteActionItem(patientId, itemId, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    p.actionItems = p.actionItems || [];
    const idx = p.actionItems.findIndex((it) => it.id === itemId);
    if (idx < 0) return { error: "Item not found." };
    const [item] = p.actionItems.splice(idx, 1);
    // If it came from an AI rec, remember it so the review doesn't resurface it.
    if (item.aiKey) { p.aiDismissed = p.aiDismissed || []; if (!p.aiDismissed.includes(item.aiKey)) p.aiDismissed.push(item.aiKey); }
    touch(p); save();
    audit(byUser.id, "action-item-deleted", `${patientName(p)}: ${item.text}`);
    return { ok: true };
  }

  const actionItems = (patientId) => (getPatient(patientId) || {}).actionItems || [];
  const careHistory = (patientId) => (getPatient(patientId) || {}).careHistory || [];

  /** Keys of recs already accepted, completed, or dismissed — hidden from the
      AI chart review so the same suggestion isn't offered twice. */
  function resolvedRecKeys(patientId) {
    const p = getPatient(patientId);
    if (!p) return [];
    const keys = new Set();
    (p.actionItems || []).forEach((it) => it.aiKey && keys.add(it.aiKey));
    (p.careHistory || []).forEach((it) => it.aiKey && keys.add(it.aiKey));
    (p.aiDismissed || []).forEach((k) => keys.add(k));
    return [...keys];
  }

  function cancelAppointment(apptId, byUser) {
    load();
    const appt = state.appointments.find((a) => a.id === apptId);
    if (!appt) return { error: "Appointment not found." };
    appt.status = "cancelled";
    appt.history.push({ action: "cancelled", userId: byUser.id, time: new Date().toISOString() });
    touch(appt);
    save();
    audit(byUser.id, "appointment-cancelled", appt.id);
    return { appt };
  }

  /* ---------------------------------------------------------------- *
   *  Settings & users (admin)
   * ---------------------------------------------------------------- */

  function updateSettings(patch, byUser) {
    load();
    Object.assign(state.settings, patch);
    touch(state.settings);
    save();
    audit(byUser.id, "settings-updated", JSON.stringify(patch));
  }

  function updateUser(userId, patch, byUser) {
    const u = getUser(userId);
    if (!u) return null;
    if ("active" in patch && patch.active === false && u.active) {
      // same lockout guards as deleteUser: keep at least one working admin
      if (byUser && byUser.id === userId) return { error: "You can't void your own access." };
      const otherAdmins = state.users.filter((x) => x.role === "admin" && x.active && x.id !== userId);
      if (u.role === "admin" && otherAdmins.length === 0) return { error: "Can't void the last active administrator." };
    }
    if ("email" in patch) {
      const e = normEmail(patch.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: "A valid email is required." };
      const clash = getUserByEmail(e);
      if (clash && clash.id !== u.id) return { error: "That email is already in use." };
      u.email = e;
    }
    if (patch.license) Object.assign(u.license || (u.license = {}), patch.license);
    for (const k of ["name", "active", "pin"]) if (k in patch) u[k] = patch[k];
    touch(u);
    save();
    audit(byUser.id, "user-updated", `${u.name} ${JSON.stringify(Object.keys(patch))}`);
    return u;
  }

  function exportAll() {
    load();
    return JSON.stringify(state, null, 2);
  }

  /* ---------------------------------------------------------------- *
   *  Offline merge: combine a device's local state with the server's.
   *  Rules: entities created on either side always survive; when both
   *  sides changed the same entity, the newer _mod wins; signatures,
   *  amendments, and history are unioned (append-only records never
   *  disappear); a signed status always beats a draft. Every conflict
   *  where an edit loses is reported so it can be audit-logged.
   * ---------------------------------------------------------------- */

  const mtime = (x) => (x && (x._mod || x.createdAt)) || "";

  function unionBy(items, keyFn) {
    const seen = new Map();
    for (const it of items) if (!seen.has(keyFn(it))) seen.set(keyFn(it), it);
    return [...seen.values()].sort((a, b) => ((a.time || "") < (b.time || "") ? -1 : 1));
  }

  function mergeStates(serverState, localState) {
    const merged = JSON.parse(JSON.stringify(serverState));
    const local = JSON.parse(JSON.stringify(localState));
    const conflicts = [];

    for (const key of ["patients", "documents", "appointments", "users"]) {
      const byId = new Map(merged[key].map((x) => [x.id, x]));
      for (const li of local[key]) {
        const si = byId.get(li.id);
        if (!si) { merged[key].push(li); continue; } // created offline — keep
        const same = JSON.stringify(si) === JSON.stringify(li);
        if (same) continue;

        let winner = mtime(li) > mtime(si) ? li : si;
        const loser = winner === li ? si : li;

        if (key === "documents") {
          // signed always beats draft; append-only records are unioned
          if (si.status === "signed" && li.status !== "signed") winner = si;
          else if (li.status === "signed" && si.status !== "signed") winner = li;
          winner.signatures = unionBy([...si.signatures, ...li.signatures], (s) => s.time + s.userId);
          winner.amendments = unionBy([...si.amendments, ...li.amendments], (a) => a.time + a.userId);
          if (si.status === "signed" || li.status === "signed") winner.status = "signed";
        }
        if (key === "appointments") {
          winner.history = unionBy([...si.history, ...li.history], (h) => h.time + h.action + h.userId);
          if (si.status === "cancelled" || li.status === "cancelled") winner.status = "cancelled";
        }

        if (winner !== si) {
          const idx = merged[key].findIndex((x) => x.id === li.id);
          merged[key][idx] = winner;
        }
        if (JSON.stringify(winner) !== JSON.stringify(loser)) {
          conflicts.push({
            kind: key, id: li.id,
            note: `${key.slice(0, -1)} ${li.id}: kept ${mtime(winner)} version, superseded ${mtime(loser)} version`,
          });
        }
      }
    }

    if (mtime(local.settings) > mtime(merged.settings)) merged.settings = local.settings;
    merged.audit = unionBy(
      [...merged.audit, ...local.audit],
      (e) => e.time + (e.userId || "") + e.action
    ).slice(-2000);
    // access requests: union by id, newest _mod wins — so an approve/decline
    // on one device isn't undone by a stale still-pending copy on another
    {
      const byId = new Map();
      for (const r of [...(merged.accessRequests || []), ...(local.accessRequests || [])]) {
        const prev = byId.get(r.id);
        if (!prev || mtime(r) > mtime(prev)) byId.set(r.id, r);
      }
      merged.accessRequests = [...byId.values()];
    }
    // clinic name map: keep server entries, fill in any the server hasn't seen
    merged.clinics = { ...(local.clinics || {}), ...(merged.clinics || {}) };
    merged.sessionUserId = null;
    return { state: merged, conflicts };
  }

  return {
    load, save, resetAll, wipeAll, exportAll, importAll, setChangeHook, mergeStates, uid,
    audit, auditLog: () => load().audit.filter(mine),
    // clinics (tenancy)
    clinics: clinicsMap, clinicName, currentClinicName, currentClinicId, renameClinic,
    // users/auth — users() is global (login/roster lookups); staff() is clinic-scoped
    users: () => load().users, staff: () => load().users.filter(mine), getUser, getUserByEmail, findUserByLogin, login, logout, currentUser,
    setAuthenticator, verifyPassword, setPassword, hashLegacyPins, ensureEmails, addUser, addProvider, upsertGoogleUser, deleteUser,
    licenseExpired, licenseExpiresSoon, canAccessEmr, canDocument,
    // patients — patients() is clinic-scoped; allPatients() is unscoped (server-side lookups)
    patients: () => load().patients.filter(mine), allPatients: () => load().patients, getPatient, patientName, addPatient, updatePatient, saveAiReview,
    // patient action items / care history (accepted AI recommendations)
    acceptRecommendation, dismissRecommendation, addActionItem, completeActionItem, deleteActionItem,
    actionItems, careHistory, resolvedRecKeys,
    // documents — documents() is clinic-scoped; docsFor(patientId) is patient-scoped
    documents: () => load().documents.filter(mine), docsFor, getDoc, DOC_TITLES, createDoc, addImportedDoc, updateDocData, deleteDoc, signDoc, amendDoc,
    visitCount, progressDue,
    // calendar — appointments() is clinic-scoped; allAppointments() is unscoped (server reminders)
    appointments: () => load().appointments.filter(mine), allAppointments: () => load().appointments, slotsForDay, apptsOn, bookAppointment, bookSeries, cancelAppointment,
    // admin
    settings: () => load().settings, updateSettings, updateUser,
    // access requests (pending-approval queue)
    accessRequests, requestAccess, approveAccessRequest, declineAccessRequest,
  };
});
