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

    return {
      settings: {
        facilityName: "Bayanihan Physical Therapy Center",
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
          id: "u-maria", name: "Maria Santos, PT", role: "therapist",
          pin: "1234", active: true,
          license: { number: "PT-0012345", expires: daysFromNow(600) },
        },
        {
          id: "u-jose", name: "Jose Ramirez, PT", role: "therapist",
          pin: "1234", active: true,
          license: { number: "PT-0098765", expires: daysFromNow(-40) }, // expired
        },
        {
          id: "u-carlo", name: "Carlo Mendoza, PT", role: "therapist",
          pin: "1234", active: false, // access voided
          license: { number: "PT-0055555", expires: daysFromNow(300) },
        },
        {
          id: "u-ana", name: "Ana Dela Cruz", role: "frontdesk",
          pin: "1234", active: true, license: null,
        },
        {
          id: "u-grace", name: "Grace Lim, PT (Admin)", role: "admin",
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
      audit: [],
      sessionUserId: null,
    };
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
    state.audit.push({ time: new Date().toISOString(), userId, action, detail: detail || "" });
    if (state.audit.length > 2000) state.audit.splice(0, state.audit.length - 2000);
    save();
  }

  /* ---------------------------------------------------------------- *
   *  Users, auth, license gating
   * ---------------------------------------------------------------- */

  const getUser = (id) => load().users.find((u) => u.id === id) || null;

  function licenseExpired(user) {
    if (!user || !user.license) return false; // non-clinical roles have no license
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
      legacy plaintext pin is dropped; without one (demo) it stays a plain pin. */
  function setPassword(userId, secret, byUser) {
    const u = getUser(userId);
    if (!u) return { error: "User not found." };
    const s = String(secret == null ? "" : secret);
    if (s.length < 8) return { error: "Password must be at least 8 characters." };
    if (authenticator) { u.passwordHash = authenticator.hash(s); delete u.pin; }
    else { u.pin = s; }
    touch(u);
    save();
    audit(byUser ? byUser.id : userId, "password-changed", u.name);
    return { user: u };
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

  /** null on success, or a human-readable reason the login was refused. */
  function login(userId, secret) {
    load();
    const user = getUser(userId);
    if (!user) return "Unknown user.";
    if (!user.active) {
      audit(userId, "login-denied", "access voided");
      return "Access for this account has been voided. Contact your administrator.";
    }
    if (!verifyCredential(user, secret)) {
      audit(userId, "login-denied", "wrong password");
      return "Incorrect password.";
    }
    state.sessionUserId = userId;
    save();
    audit(userId, "login", user.role);
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
   *  Patients
   * ---------------------------------------------------------------- */

  const getPatient = (id) => load().patients.find((p) => p.id === id) || null;
  const patientName = (p) => (p ? `${p.lastName}, ${p.firstName}` : "Unknown");

  function addPatient(fields, byUserId) {
    load();
    const patient = Object.assign(
      { id: uid("p"), attachments: [], createdBy: byUserId, createdAt: new Date().toISOString() },
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
    if (type === "daily") Object.assign(data, { summary: "", subjective: "" });
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
      id: uid("d"), patientId, type,
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
      id: uid("d"), patientId, type: t,
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
    load().appointments.filter((a) => a.status !== "cancelled" && iso(new Date(a.start)) === dateIso);

  function bookAppointment({ patientId, therapistId, start, note }, byUser) {
    load();
    const clash = state.appointments.some(
      (a) => a.status !== "cancelled" && a.therapistId === therapistId && a.start === start
    );
    if (clash) return { error: "That therapist already has a booking in this slot." };
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) return { error: "Invalid appointment time." };
    const remind3d = new Date(startDate); remind3d.setDate(remind3d.getDate() - 3); remind3d.setHours(9, 0, 0, 0);
    const remindAm = new Date(startDate); remindAm.setHours(7, 0, 0, 0);
    const appt = {
      id: uid("ap"), patientId, therapistId, start,
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
    merged.sessionUserId = null;
    return { state: merged, conflicts };
  }

  return {
    load, save, resetAll, wipeAll, exportAll, importAll, setChangeHook, mergeStates, uid,
    audit, auditLog: () => load().audit,
    // users/auth
    users: () => load().users, getUser, login, logout, currentUser,
    setAuthenticator, verifyPassword, setPassword, hashLegacyPins,
    licenseExpired, licenseExpiresSoon, canAccessEmr, canDocument,
    // patients
    patients: () => load().patients, getPatient, patientName, addPatient, updatePatient,
    // documents
    docsFor, getDoc, DOC_TITLES, createDoc, addImportedDoc, updateDocData, signDoc, amendDoc,
    visitCount, progressDue,
    // calendar
    appointments: () => load().appointments, slotsForDay, apptsOn, bookAppointment, cancelAppointment,
    // admin
    settings: () => load().settings, updateSettings, updateUser,
  };
});
