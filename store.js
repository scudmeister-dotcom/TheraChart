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

  /* The accounts seed() creates, by id. This is the ONLY safe way to identify a
     demo login: ensureEmails() mints an @therachart.demo address for any account
     saved without one — including a therapist a clinic adds through the calendar
     — so a filter on the email domain would eventually list real staff on the
     public sign-in screen under "Test accounts · password 1234". server.js and
     app.js both read this rather than keeping their own copies. */
  const SEEDED_DEMO_USER_IDS = ["u-maria", "u-jose", "u-carlo", "u-ana", "u-grace", "u-fresh"];
  const SEEDED_DEMO_ID_SET = new Set(SEEDED_DEMO_USER_IDS);

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
          active: true,
          license: { number: "PT-0012345", expires: daysFromNow(600) },
        },
        {
          id: "u-jose", name: "Jose Ramirez, PT", email: "jose@therachart.demo", role: "therapist",
          active: true,
          license: { number: "PT-0098765", expires: daysFromNow(-40) }, // expired
        },
        {
          id: "u-carlo", name: "Carlo Mendoza, PT", email: "carlo@therachart.demo", role: "therapist",
          active: false, // access voided
          license: { number: "PT-0055555", expires: daysFromNow(300) },
        },
        {
          id: "u-ana", name: "Ana Dela Cruz", email: "ana@therachart.demo", role: "frontdesk",
          active: true, license: null,
        },
        {
          id: "u-grace", name: "Grace Lim, PT (Admin)", email: "grace@therachart.demo", role: "admin",
          active: true,
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
          allergies: "Penicillin — rash. Latex sensitivity (use nitrile gloves).",
          emergencyContact: { name: "Marites Reyes", relationship: "Spouse", phone: "+63 917 555 0111" },
          insurance: { provider: "PhilHealth", memberId: "PH-4451-2231", notes: "Co-pay ₱150/visit" },
          authorization: { visitsAuthorized: 18, expiresOn: t(46, 12, 0).slice(0, 10), reference: "AUTH-88213" },
          goals: [
            { id: "g-juan-1", term: "short", text: "Reach the top shelf without sharp pain",
              baseline: "Unable — 7/10 pain at 105° flexion", target: "Pain ≤3/10 through full reach",
              targetDate: t(-2, 12, 0).slice(0, 10), status: "met",
              createdBy: "u-maria", createdAt: t(-14, 9, 0),
              history: [{ status: "met", from: "active", userId: "u-maria", time: t(-2, 14, 0) }] },
            { id: "g-juan-2", term: "short", text: "Right shoulder flexion to 160°",
              baseline: "105° at evaluation", target: "160° active",
              targetDate: t(9, 12, 0).slice(0, 10), status: "active",
              createdBy: "u-maria", createdAt: t(-14, 9, 0), history: [] },
            { id: "g-juan-3", term: "long", text: "Return to full duties at work, including overhead lifting",
              baseline: "On light duty, no lifting above shoulder", target: "Lift 10 kg overhead ×10 reps",
              targetDate: t(-3, 12, 0).slice(0, 10), status: "active",
              createdBy: "u-maria", createdAt: t(-14, 9, 0), history: [] },
          ],
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
          allergies: "",
          emergencyContact: { name: "Ramon Mercado", relationship: "Son", phone: "+63 917 555 0222" },
          insurance: { provider: "Maxicare", memberId: "MX-99-887766", notes: "" },
          // deliberately near the end of the authorisation, so the warning shows
          authorization: { visitsAuthorized: 8, expiresOn: t(12, 12, 0).slice(0, 10), reference: "MX-AUTH-5512" },
          goals: [
            { id: "g-liza-1", term: "short", text: "Climb one flight of stairs reciprocally without a rail",
              baseline: "Step-to pattern, holds rail both sides", target: "Reciprocal, one hand on rail",
              targetDate: t(16, 12, 0).slice(0, 10), status: "active",
              createdBy: "u-maria", createdAt: t(-10, 10, 0), history: [] },
            { id: "g-liza-2", term: "long", text: "Walk to the market and back (about 800 m) without resting",
              baseline: "Rests twice, knee pain 5/10", target: "No rest stops, pain ≤2/10",
              targetDate: t(40, 12, 0).slice(0, 10), status: "active",
              createdBy: "u-maria", createdAt: t(-10, 10, 0), history: [] },
          ],
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
          allergies: "NSAIDs — gastric upset.",
          emergencyContact: { name: "Elena Villanueva", relationship: "Wife", phone: "+63 917 555 0333" },
          insurance: { provider: "PhilHealth", memberId: "PH-7781-4420", notes: "" },
          authorization: { visitsAuthorized: 12, expiresOn: t(30, 12, 0).slice(0, 10), reference: "PH-AUTH-2091" },
          goals: [
            { id: "g-mateo-1", term: "short", text: "Left knee flexion to 130°",
              baseline: "110° at evaluation", target: "130° active",
              targetDate: t(6, 12, 0).slice(0, 10), status: "active",
              createdBy: "u-maria", createdAt: t(-8, 9, 0), history: [] },
            { id: "g-mateo-2", term: "short", text: "Sit to stand from a standard chair without using hands",
              baseline: "Pushes off both armrests", target: "Hands free, ×5 repetitions",
              targetDate: t(20, 12, 0).slice(0, 10), status: "active",
              createdBy: "u-maria", createdAt: t(-8, 9, 0), history: [] },
          ],
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
            outcomes: [{ toolId: "dash", score: 58 }, { toolId: "nprs", score: 7 }],
            charges: [{ code: "97162", desc: "PT evaluation — moderate complexity", minutes: 45, units: 1 }],
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
            // 38 timed minutes → exactly the 3 units claimed under the 8-minute rule
            charges: [
              { code: "97110", desc: "Therapeutic exercise", minutes: 23, units: 2 },
              { code: "97140", desc: "Manual therapy", minutes: 15, units: 1 },
              { code: "97010", desc: "Hot or cold packs", minutes: 0, units: 1 },
            ],
            // DASH re-measured at the midpoint and again near the end
            outcomes: i === 1 ? [{ toolId: "dash", score: 44 }] : i === 3 ? [{ toolId: "dash", score: 30 }, { toolId: "nprs", score: 4 }] : [],
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
            outcomes: [{ toolId: "lefs", score: 34 }, { toolId: "nprs", score: 5 }],
            charges: [{ code: "97161", desc: "PT evaluation — low complexity", minutes: 40, units: 1 }],
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
            pain: [{ score: 4, location: "left knee" }],
            charges: [
              { code: "97110", desc: "Therapeutic exercise", minutes: 22, units: 1 },
              { code: "97116", desc: "Gait training", minutes: 16, units: 1 },
            ],
            outcomes: [], mapPoints: [], transcript: [],
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
            // left deliberately unbalanced: 30 timed minutes support 2 units,
            // only 1 is claimed — the billing check should say so
            charges: [{ code: "97110", desc: "Therapeutic exercise", minutes: 30, units: 1 }],
            outcomes: [],
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
      active: true, clinicId: "clinic-fresh",
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

    /* Which clinic a Google sign-in belongs to. The caller (server.js) decides,
       because the answer comes from host configuration: the operator and the
       people they allowlist are running a real clinic, and must NOT land in the
       seeded demo clinic — the demo logins and their password are published on
       the sign-in screen, so sharing a clinic with them would put real patient
       records under a publicly known admin account. */
    const clinicId = (fields && fields.clinicId) || DEFAULT_CLINIC;

    let user = getUserByEmail(email);
    if (user) {
      user.active = true;
      user.role = role;
      if (role === "frontdesk") user.license = null; // front desk never carries one
      user.authProvider = "google";
      if (sub) user.googleSub = sub;
      delete user.mustChangePassword; // Google users have no password to set
      /* A Google sign-in must never sit in the seeded demo clinic: those logins
         and their password are printed on the sign-in screen, so real records
         there would be under a publicly known admin account.

         Checking only for an UNSTAMPED user was not enough. Any device push
         stamps previously-unstamped records with the pusher's clinic, so a
         single demo session was enough to write clinic-demo onto every legacy
         account — including this one — before it ever signed in, after which
         the migration silently declined to run. Treat "in the demo clinic" and
         "unstamped" as the same case.

         Any OTHER clinic is still left alone: a routine sign-in must not yank
         someone out of their colleagues' data. Set GOOGLE_CLINIC_ID=clinic-demo
         to opt out of the move entirely. */
      if (!user.clinicId || user.clinicId === DEFAULT_CLINIC) user.clinicId = clinicId;
      touch(user);
      save();
      audit(user.id, "login", "google");
      return { user };
    }

    user = {
      id: uid("u"), name, email, role, active: true,
      license: null, authProvider: "google", clinicId,
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
    /* Someone asking for an account by email picks their password up front, so
       approving is one click and nobody has to hand a secret over out of band.
       It is hashed here and the account stays inactive until approved, so a
       pending request is not a usable credential. */
    const password = fields && fields.password ? String(fields.password) : "";
    const stashPassword = (r) => {
      if (!password) return;
      if (authenticator) r.passwordHash = authenticator.hash(password);
      else r.pin = password;
    };

    let req = state.accessRequests.find((r) => normEmail(r.email) === email && r.status === "pending");
    if (req) {
      req.attempts = (req.attempts || 1) + 1;
      req.name = req.name || name;
      if (sub) req.googleSub = sub;
      if (fields && ROLES.includes(fields.role)) req.wantRole = fields.role;
      stashPassword(req);
      touch(req);
    } else {
      req = {
        id: uid("ar"), email, name, source, googleSub: sub,
        /* An admin raising this on behalf of their own staff already knows the
           role and the clinic; the operator still decides, but starts from what
           the clinic asked for rather than from a blank field. */
        wantRole: (fields && ROLES.includes(fields.role)) ? fields.role : null,
        requestedBy: (fields && fields.requestedBy) || null,
        status: "pending", note: "", attempts: 1, createdAt: new Date().toISOString(),
        /* Which clinic's approval queue this lands in. Without it the record is
           un-stamped, and un-stamped means DEFAULT_CLINIC — the seeded demo
           clinic — so a real person asking for access showed up only to whoever
           signed in with the demo password published on the sign-in screen, and
           never to the operator. The caller passes the clinic Google sign-ins
           join; the fallback keeps the browser-only build working. */
        clinicId: (fields && fields.clinicId) || currentClinicId(),
      };
      stashPassword(req);
      touch(req);
      state.accessRequests.push(req);
    }
    save();
    audit(null, "access-requested", `${source}:${email}`);
    return { request: req };
  }

  /* Find a pending request within the acting admin's own clinic.

     Scoped by `byUser` rather than by accessRequests()'s ambient filter: the
     server holds no session (it authenticates per request), so the ambient
     "current clinic" there is the default one and an admin of any other clinic
     could not find their own queue. Falls back to the ambient scope for the
     browser-only build, where the acting user IS the session. */
  function findPendingRequest(id, byUser, anyClinic) {
    load();
    if (!Array.isArray(state.accessRequests)) return null;
    /* The operator approves for every clinic, so their lookup is not scoped —
       the server proves who they are before passing anyClinic. Everyone else
       stays inside their own tenant. */
    if (anyClinic) return state.accessRequests.find((r) => r.id === id) || null;
    const cid = (byUser && byUser.clinicId) || currentClinicId();
    return state.accessRequests.find((r) => r.id === id && recClinic(r) === cid) || null;
  }

  /** Every pending request, across clinics — for the operator's queue. The
      caller is responsible for proving it may see other tenants. */
  function pendingAccessRequestsAllClinics() {
    load();
    if (!Array.isArray(state.accessRequests)) return [];
    return state.accessRequests
      .filter((r) => r.status === "pending")
      .map((r) => ({ ...r, clinicName: clinicName(recClinic(r)), passwordHash: undefined, pin: undefined }));
  }

  /* Create a clinic with no members yet.

     createClinic() insists on a first administrator because a clinic nobody can
     sign into is not a clinic. That holds when the operator onboards a practice
     cold — but not when the clinic is being made FOR someone already waiting in
     the approval queue: they become its administrator a moment later, in the
     same action. Kept separate rather than loosening createClinic, so the
     "no clinic without a way in" rule still applies everywhere else. */
  function addClinic(name, byUser) {
    load();
    const clean = String(name || "").trim();
    if (!clean) return { error: "Clinic name is required." };
    if (Object.values(clinicsMap()).some((c) => c.name.trim().toLowerCase() === clean.toLowerCase())) {
      return { error: "A clinic with that name already exists." };
    }
    const clinicId = uid("clinic");
    state.clinics = state.clinics || {};
    state.clinics[clinicId] = { id: clinicId, name: clean };
    touch(state.clinics[clinicId]);
    save();
    audit(byUser ? byUser.id : null, "clinic-created", `${clean} (awaiting its first administrator)`);
    return { clinic: state.clinics[clinicId] };
  }

  /** Approve a pending request: provision an active account with the chosen
      role and the credential its source implies, then mark the request
      resolved (kept for the audit trail). */
  function approveAccessRequest(id, opts, byUser) {
    load();
    const req = findPendingRequest(id, byUser, opts && opts.anyClinic);
    if (!req) return { error: "That request no longer exists." };
    if (req.status !== "pending") return { error: "That request has already been handled." };
    const role = ROLES.includes(opts && opts.role) ? opts.role : "therapist";
    /* Which clinic they join is the operator's decision, not a side effect of
       who happened to approve. An explicit id is validated against the clinics
       that exist — an unknown one would file a real person into a tenant with
       no records and no colleagues, and look like a working account. */
    let joinClinic = (opts && opts.clinicId) || null;
    if (joinClinic && !clinicsMap()[joinClinic]) return { error: "That clinic no longer exists." };
    if (!joinClinic) joinClinic = recClinic(req) || (byUser && byUser.clinicId) || currentClinicId();
    const email = normEmail(req.email);
    /* Approving decides the role, never the way in: a Google request stays a
       Google account, and an email request is activated with the password its
       owner already chose. Provisioning the wrong provider would leave someone
       approved and still unable to sign in. */
    /* Only a Google request provisions a Google account. Anything else — a
       person choosing their own password, or an admin setting a temporary one
       for their staff — carries a credential that must actually be applied.
       Testing for "not email" silently threw the admin case's password away
       and produced an account nobody could sign into. */
    const viaGoogle = req.source === "google";
    const applyCredential = (u) => {
      u.authProvider = viaGoogle ? "google" : "password";
      if (viaGoogle) {
        if (req.googleSub) u.googleSub = req.googleSub;
        return;
      }
      if (req.passwordHash) u.passwordHash = req.passwordHash;
      else if (req.pin != null) u.pin = req.pin;
    };
    let user = getUserByEmail(email);
    if (user) {
      user.active = true;
      user.role = role;
      user.clinicId = joinClinic;
      if (role === "frontdesk") user.license = null;
      applyCredential(user);
      // an admin-raised request carries a temporary password, so the person
      // still picks their own the first time they sign in
      if (req.source === "admin") user.mustChangePassword = true;
      else delete user.mustChangePassword;
      touch(user);
    } else {
      user = {
        id: uid("u"), name: req.name || email.split("@")[0], email, role,
        active: true, license: null,
        clinicId: joinClinic,
      };
      applyCredential(user);
      if (req.source === "admin") user.mustChangePassword = true;
      touch(user);
      state.users.push(user);
    }
    /* The credential now lives on the account, so drop it from the request.
       The request is kept for the audit trail and does not need to keep a
       usable password hash in it. */
    delete req.passwordHash;
    delete req.pin;
    req.status = "approved";
    req.role = role;
    req.resolvedBy = byUser ? byUser.id : null;
    req.resolvedAt = new Date().toISOString();
    touch(req);
    save();
    audit(byUser ? byUser.id : null, "user-created", `${user.name} (${role}, ${viaGoogle ? "google" : "password"})`);
    audit(byUser ? byUser.id : null, "access-approved", `${email} (${role}) → ${clinicName(joinClinic)}`);
    return { user, request: req };
  }

  /** Decline a pending request — kept (marked declined) for the audit trail. */
  function declineAccessRequest(id, byUser, opts) {
    load();
    const req = findPendingRequest(id, byUser, opts && opts.anyClinic);
    if (!req) return { error: "That request no longer exists." };
    if (req.status !== "pending") return { error: "That request has already been handled." };
    delete req.passwordHash;
    delete req.pin;
    req.status = "declined";
    req.resolvedBy = byUser ? byUser.id : null;
    req.resolvedAt = new Date().toISOString();
    touch(req);
    save();
    audit(byUser ? byUser.id : null, "access-declined", req.email);
    return { ok: true, request: req };
  }

  /* The seeded demo accounts hold no password, on every deployment.

     They are entered by picking a name, which authorizes the caller rather
     than trusting a secret — so a password on them is not a way in, only a way
     around. Refusing them at /api/login already covers a server that offers a
     demo; this covers the one that does NOT, where that gate never runs and an
     old "1234" hash would otherwise sit there working. Unconditional and
     idempotent for that reason. An admin can still set a real password on one
     of these addresses later if they ever want it to be a real account. */
  function stripDemoCredentials() {
    load();
    let n = 0;
    for (const u of state.users) {
      if (!SEEDED_DEMO_ID_SET.has(u.id)) continue;
      if (u.pin == null && !u.passwordHash && !u.mustChangePassword) continue;
      delete u.pin;
      delete u.passwordHash;
      delete u.mustChangePassword;
      touch(u);
      n += 1;
    }
    if (n) { audit(null, "demo-credentials-cleared", `${n} seeded demo account${n === 1 ? "" : "s"}`); save(); }
    return n;
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

  /* Put the seeded demo logins back on an instance that already has state.

     seed() only runs when storage is EMPTY, so a deployment that has ever been
     written to will never grow the demo accounts on its own — which is why a
     long-lived server can advertise a demo clinic it has no logins for. This
     grafts the missing pieces in, and is safe to run on every boot:

       - only the six ids in SEEDED_DEMO_USER_IDS are ever touched, so a real
         employee is never created, revived, or given a published password;
       - the demo clinics are created if absent;
       - the demo CONTENT (patients/notes/schedule) is grafted only when
         clinic-demo has no patients at all, so a demo that has been clicked
         around in keeps its edits instead of being reset under the presenter;
       - the password is forced back to the published one, because the sign-in
         panel prints it and a stale password there is just a broken demo.

     The caller decides whether to run this — server.js ties it to
     THERACHART_DEMO_LOGINS, the same switch that reveals the panel, so a real
     clinic deployment neither shows nor creates these accounts.

     Returns a summary of what it changed ({users, content, clinics}). */
  function ensureDemoAccounts() {
    load();
    const fresh = seed();
    const out = { users: 0, content: false, clinics: 0 };

    state.clinics = state.clinics || {};
    for (const [id, c] of Object.entries(fresh.clinics || {})) {
      if (!state.clinics[id]) { state.clinics[id] = { ...c }; touch(state.clinics[id]); out.clinics++; }
    }

    const wanted = new Set(SEEDED_DEMO_USER_IDS);
    const byId = new Map(state.users.map((u) => [u.id, u]));
    for (const su of fresh.users) {
      if (!wanted.has(su.id)) continue;
      const existing = byId.get(su.id);
      if (!existing) {
        state.users.push({ ...su });
        touch(state.users[state.users.length - 1]);
        out.users++;
        continue;
      }
      let changed = false;

      /* Restore the seed ADDRESS. An instance old enough to predate email login
         stored these accounts with no email at all, and ensureEmails() then
         derived one from the name — "Maria Santos, PT" became
         maria.santos@therachart.demo. The account still worked, but not at the
         address the docs, the tests, and every demo script name, which reads
         exactly like the login being broken. Skipped if another account already
         holds the address, so this can never hijack someone's login. */
      const wantEmail = normEmail(su.email);
      if (wantEmail && normEmail(existing.email) !== wantEmail) {
        const holder = state.users.find((u) => u.id !== su.id && normEmail(u.email) === wantEmail);
        if (!holder) { existing.email = su.email; changed = true; }
      }

      /* These accounts hold no password at all — see stripDemoCredentials().
         The graft used to re-publish a shared 4-digit one because the sign-in
         panel advertised it; the panel now opens them by picking a name, so a
         credential here would only be a second, weaker door. */
      if (existing.pin != null || existing.passwordHash || existing.mustChangePassword) {
        delete existing.pin;
        delete existing.passwordHash;
        delete existing.mustChangePassword;
        changed = true;
      }

      if (changed) { touch(existing); out.users++; }
    }

    // Demo content, all-or-nothing: an empty demo clinic is a bad first
    // impression, but a half-grafted one would collide with records a
    // presenter just created.
    const demoPatients = state.patients.filter((p) => (p.clinicId || DEFAULT_CLINIC) === "clinic-demo");
    if (!demoPatients.length) {
      for (const key of ["patients", "documents", "appointments", "accessRequests"]) {
        const have = new Set((state[key] || []).map((r) => r.id));
        for (const rec of fresh[key] || []) if (!have.has(rec.id)) state[key].push({ ...rec });
      }
      const haveAudit = new Set(state.audit.map((e) => e.time + (e.userId || "") + e.action));
      for (const e of fresh.audit || []) {
        if (!haveAudit.has(e.time + (e.userId || "") + e.action)) state.audit.push({ ...e });
      }
      out.content = true;
    }

    if (out.users || out.content || out.clinics) save();
    return out;
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

  /** Enter a seeded demo account without a password.

      The authorization question for a demo account is "may this person reach
      the demo at all", which is answered before this is ever called — by the
      server's demo gate, or by being in the browser-only build. Once answered,
      re-asking for a password that is published anyway adds nothing. Restricted
      to the seeded ids so it can never become a password bypass for real staff. */
  function loginAsDemo(userId) {
    load();
    if (!SEEDED_DEMO_ID_SET.has(userId)) return "That demo account isn't available.";
    const user = getUser(userId);
    if (!user) return "That demo account isn't available.";
    if (!user.active) {
      audit(user.id, "login-denied", "access voided");
      return "Access for this account has been voided. Contact your administrator.";
    }
    state.sessionUserId = user.id;
    save();
    audit(user.id, "login", `${user.role} (demo panel)`);
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
   *  don't share patients, documents, schedule, activity log, or settings.
   * ---------------------------------------------------------------- */
  const DEFAULT_CLINIC = "clinic-demo";
  const currentClinicId = () => (currentUser() || {}).clinicId || DEFAULT_CLINIC;
  const recClinic = (rec) => (rec && rec.clinicId) || DEFAULT_CLINIC; // legacy/un-stamped → demo clinic
  const mine = (rec) => recClinic(rec) === currentClinicId();
  const clinicsMap = () => load().clinics || {};
  const clinicName = (id) => (clinicsMap()[id] && clinicsMap()[id].name) || load().settings.facilityName || "TheraChart Clinic";
  const currentClinicName = () => clinicName(currentClinicId());

  /* Onboard a brand-new clinic: the clinic itself plus its first admin, in one
     step, because a clinic with no way in is not a clinic.

     This is the ONLY path that creates a clinic other than the seeded ones and
     the single clinic Google sign-ins land in. addUser() cannot do it — it puts
     the new account in the CALLER's clinic, which is right for a clinic hiring
     staff and wrong for onboarding, where the whole point is a tenant the
     caller is not part of.

     The first admin gets a temporary password and `mustChangePassword`, so the
     operator never learns the credential the clinic ends up using. Caller-side
     authorisation is deliberately NOT checked here — server.js gates the route
     to the platform owner, and the browser-only build has no operator at all. */
  function createClinic(fields, byUser) {
    load();
    const clinicNameIn = String((fields && fields.clinicName) || "").trim();
    const ownerName = String((fields && fields.ownerName) || "").trim();
    const ownerEmail = normEmail(fields && fields.ownerEmail);
    const password = String((fields && fields.password) || "");

    if (!clinicNameIn) return { error: "Clinic name is required." };
    if (!ownerName) return { error: "The first administrator's name is required." };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) return { error: "A valid email is required (it's their login)." };
    if (getUserByEmail(ownerEmail)) return { error: "That email is already in use by another account." };
    if (password.length < 8) return { error: "Temporary password must be at least 8 characters." };
    /* A clinic named the same as an existing one is refused rather than
       silently allowed: the name is what the operator picks a clinic by, and
       two identical rows in that list is how records get filed into the wrong
       tenant. Ids stay unique regardless. */
    if (Object.values(clinicsMap()).some((c) => c.name.trim().toLowerCase() === clinicNameIn.toLowerCase())) {
      return { error: "A clinic with that name already exists." };
    }

    const clinicId = uid("clinic");
    state.clinics = state.clinics || {};
    state.clinics[clinicId] = { id: clinicId, name: clinicNameIn };
    touch(state.clinics[clinicId]);

    const user = {
      id: uid("u"), name: ownerName, email: ownerEmail, role: "admin", active: true,
      clinicId,
      // Left blank on purpose: the admin fills in their own PRC licence from My
      // Profile. Inventing a number here would put an unverified licence on a
      // clinical signature.
      license: { number: "", expires: "" },
      mustChangePassword: true,
    };
    if (authenticator) user.passwordHash = authenticator.hash(password);
    else user.pin = password;
    touch(user);
    state.users.push(user);

    save();
    audit(byUser ? byUser.id : null, "clinic-created", `${clinicNameIn} — first admin ${ownerName} (${ownerEmail})`);
    return { clinic: state.clinics[clinicId], user };
  }

  /* Every clinic on the server with a headcount and patient count — the
     operator's list. Unscoped by design (it spans tenants), so server.js must
     keep it behind the platform-owner check. It deliberately carries NO patient
     names or clinical detail: a count is enough to run onboarding, and anything
     more would hand one clinic's records to someone outside it. */
  function clinicSummaries() {
    load();
    const rows = Object.values(clinicsMap()).map((c) => ({
      id: c.id,
      name: c.name,
      staff: state.users.filter((u) => recClinic(u) === c.id).length,
      admins: state.users.filter((u) => recClinic(u) === c.id && u.role === "admin" && u.active !== false).length,
      patients: state.patients.filter((p) => recClinic(p) === c.id).length,
      documents: state.documents.filter((d) => recClinic(d) === c.id).length,
      createdAt: c._mod || null,
    }));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /* Settings are PER CLINIC. They live in `clinics[id].settings`; the
     top-level `settings` block is the pre-tenancy default, kept only so an
     existing install keeps its configuration until that clinic saves its own.
     This matters beyond scheduling preferences: `audioReview` is the opt-in
     that governs whether a patient's dictation audio is retained at all, and
     one clinic must not be able to switch that on for another. */
  const SETTING_DEFAULTS = {
    facilityName: "TheraChart Clinic",
    progressEvery: 5,
    slotMinutes: 45,
    dayStartHour: 8,
    dayEndHour: 17,
    workDays: [1, 2, 3, 4, 5, 6],
    audioReview: false,
    audioReviewDays: 7,
    /* Commercial plan. The allowance is what the clinic bought, in DOCUMENTED
       VISITS — not seats, because cost tracks visits and a clinic that adds a
       part-time therapist without adding visits costs us nothing more. Defaults
       to the entry rung so a fresh install shows a real meter rather than an
       empty one; an admin sets their actual plan in Facility Admin. */
    planName: "Solo",
    visitAllowance: 130,
    /* The RATE the monthly dictation pool is sized at — `visitAllowance` x
       this — not a per-visit cap. The pool is the plan's and is there in full
       from the 1st; see monthUsage(). 10 minutes is deliberately generous —
       the cost model is built on 6 — so a clinic only ever sees the overage
       line if it is genuinely an outlier, which is the point. It is shown,
       never enforced; cutting a therapist off mid-dictation to save a peso
       would be indefensible. Break-even is ~18 minutes a visit, so this rate
       is the one number here that must not drift upward. */
    fairUseMinutesPerVisit: 10,
    /* Overage, quoted per unit rather than blended. P28 a visit over a
       10-minute budget works out at P2.80 a minute, so P3 keeps the two rates
       consistent with each other while staying a round number on a price page
       — and roughly 3x the ~P0.98 a minute actually costs us. */
    overagePerVisit: 28,
    overagePerMinute: 3,
    /* Backstop, not a limit. The voice gate is an energy threshold, so a room
       loud enough to clear it defeats BOTH the silence gating and the idle
       auto-stop at once — noise reads as speech, so `idleMs` never accumulates
       and the microphone never turns itself off. The adaptive floor in app.js
       is the real fix; this bounds the damage when a room beats it anyway.
       Set at 3x fair use so no honest visit ever reaches it. */
    maxDictationMinutesPerVisit: 30,
  };

  /** Effective settings for one clinic: its own block over the legacy global
      block over the defaults. The clinic's NAME is authoritative, so a rename
      and `facilityName` can never drift apart. */
  function settingsFor(clinicId) {
    const id = clinicId || DEFAULT_CLINIC;
    load();
    const c = clinicsMap()[id];
    const merged = { ...SETTING_DEFAULTS, ...(state.settings || {}), ...((c && c.settings) || {}) };
    merged.facilityName = clinicName(id);
    return merged;
  }
  const settings = () => settingsFor(currentClinicId());
  /** Make sure a clinic exists with a readable name. Never renames one that is
      already named — an operator's own label must survive a restart. */
  function ensureClinic(id, name) {
    load();
    if (!id) return null;
    state.clinics = state.clinics || {};
    if (!state.clinics[id]) {
      state.clinics[id] = { id, name: String(name || "").trim() || "TheraChart Clinic" };
      touch(state.clinics[id]);
      save();
    }
    return state.clinics[id];
  }

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
   *  Plan-of-care goals
   *
   *  Goals belong to the patient, not to one note: they're written at the
   *  evaluation, reviewed in every progress report, and closed out at
   *  discharge. Keeping them on the patient means "progress toward goals"
   *  refers to the same objects each time instead of prose retyped per visit.
   * ---------------------------------------------------------------- */

  const goalsFor = (patientId) => (getPatient(patientId) || {}).goals || [];

  function addGoal(patientId, fields, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    if (!canDocument(byUser)) return { error: "Your account can’t edit the plan of care." };
    const text = String((fields || {}).text || "").trim();
    if (!text) return { error: "Describe the goal." };
    if (!p.goals) p.goals = [];
    const goal = {
      id: uid("g"), text,
      baseline: String(fields.baseline || "").trim(),
      target: String(fields.target || "").trim(),
      targetDate: fields.targetDate || "",
      term: fields.term === "long" ? "long" : "short",
      status: "active",
      createdBy: byUser.id, createdAt: new Date().toISOString(),
      history: [],
    };
    p.goals.push(goal);
    touch(p);
    save();
    audit(byUser.id, "goal-added", `${patientName(p)} — ${text}`);
    return { goal };
  }

  /** Status changes are appended to the goal's own history, so a progress
      report can show when a goal was met rather than only that it is. */
  function updateGoal(patientId, goalId, fields, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    if (!canDocument(byUser)) return { error: "Your account can’t edit the plan of care." };
    const goal = (p.goals || []).find((g) => g.id === goalId);
    if (!goal) return { error: "Goal not found." };
    const before = goal.status;
    Object.assign(goal, fields);
    if (fields.status && fields.status !== before) {
      goal.history = goal.history || [];
      goal.history.push({ status: fields.status, from: before, userId: byUser.id, time: new Date().toISOString() });
      audit(byUser.id, "goal-status-changed", `${patientName(p)} — ${goal.text}: ${before} → ${fields.status}`);
    }
    touch(p);
    save();
    return { goal };
  }

  function deleteGoal(patientId, goalId, byUser) {
    const p = getPatient(patientId);
    if (!p) return { error: "Patient not found." };
    if (!canDocument(byUser)) return { error: "Your account can’t edit the plan of care." };
    const i = (p.goals || []).findIndex((g) => g.id === goalId);
    if (i === -1) return { error: "Goal not found." };
    const [gone] = p.goals.splice(i, 1);
    touch(p);
    save();
    audit(byUser.id, "goal-removed", `${patientName(p)} — ${gone.text}`);
    return { ok: true };
  }

  /* ---------------------------------------------------------------- *
   *  Outcome measures & authorisation — both derived, never stored twice
   * ---------------------------------------------------------------- */

  /** Every outcome score recorded anywhere in the chart, stamped with the
      date of the note that carries it, ready for trending. */
  function outcomeSeries(patientId) {
    const out = [];
    docsFor(patientId).forEach((d) => {
      (d.data.outcomes || []).forEach((o) => {
        if (!o || !o.toolId) return;
        out.push({ toolId: o.toolId, score: o.score, date: (d.createdAt || "").slice(0, 10), docId: d.id });
      });
    });
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /** Where the patient stands against their authorised visit count. Visits
      used are counted from documented visits rather than stored, so the
      number can't drift away from the chart. */
  function authStatus(patient) {
    const a = (patient || {}).authorization || {};
    const authorized = Number(a.visitsAuthorized) || 0;
    const used = visitCount((patient || {}).id);
    const remaining = authorized ? Math.max(0, authorized - used) : null;
    const expires = a.expiresOn || "";
    const today = new Date().toISOString().slice(0, 10);
    return {
      authorized, used, remaining, expiresOn: expires, reference: a.reference || "",
      hasAuth: !!(authorized || expires),
      expired: !!expires && expires < today,
      exhausted: authorized > 0 && used >= authorized,
      low: remaining !== null && remaining > 0 && remaining <= 2,
    };
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

  /* ---------------- dictation history, for scheduling ----------------

     How long this patient's visits actually take to dictate, so the front desk
     can book a slot that fits. A patient with a complex neuro presentation
     genuinely needs more talking than a straightforward knee, and the schedule
     should reflect that rather than running late every week.

     Three deliberate constraints, because this is the number most easily
     misread as a productivity score:

       MEDIAN, not mean. One runaway session — a mic left open before the idle
       stop caught it, or an unusually messy visit — must not move a
       recommendation that will be applied every week from now on.

       A MINIMUM SAMPLE. Below MIN_SAMPLE dictated visits there is no answer,
       and the caller shows nothing. A "typical" built from one visit is noise
       wearing the costume of advice.

       NO THERAPIST DIMENSION, deliberately. This is keyed on the patient and
       nothing else. The same figure grouped by clinician is a stopwatch on
       staff, and the incentive it creates — dictate less — degrades exactly
       the documentation the product exists to improve. */
  const MIN_SAMPLE = 3;        // dictated visits before this patient has a "typical"
  const MIN_CLINIC_SAMPLE = 5; // …and before the clinic has a baseline to compare against

  const median = (sorted) => {
    if (!sorted.length) return 0;
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
  };
  const dictationSecs = (docs) => docs
    .map((d) => Number((d.data || {})._dictationSeconds) || 0)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);

  function patientDictation(patientId) {
    load();
    const mineSecs = dictationSecs(docsFor(patientId));
    /* The baseline is every OTHER patient, not the whole clinic. Including this
       patient's own visits compares them partly against themselves, which in a
       small clinic — where one heavy patient can be a large share of all
       dictation — quietly cancels the signal we are looking for. */
    const clinicSecs = dictationSecs(load().documents.filter(mine).filter((d) => d.patientId !== patientId));
    const typical = mineSecs.length >= MIN_SAMPLE ? median(mineSecs) : 0;
    const clinicTypical = clinicSecs.length >= MIN_CLINIC_SAMPLE ? median(clinicSecs) : 0;
    /* "Runs long" needs BOTH a ratio and an absolute gap. A ratio alone fires
       on a clinic whose typical visit is 90 seconds, where a 2-minute patient
       is 1.3x but the extra 30s is not worth re-arranging a schedule over. */
    const longer = !!(typical && clinicTypical && typical >= clinicTypical * 1.3 && typical - clinicTypical >= 120);
    const shorter = !!(typical && clinicTypical && typical <= clinicTypical * 0.7 && clinicTypical - typical >= 120);
    return {
      visits: mineSecs.length,
      typical,
      longest: mineSecs.length ? mineSecs[mineSecs.length - 1] : 0,
      clinicTypical,
      clinicVisits: clinicSecs.length,
      longer,
      shorter,
      // recent visits, newest first, for the scheduling detail view
      recent: docsFor(patientId)
        .filter((d) => Number((d.data || {})._dictationSeconds) > 0)
        .slice(-6).reverse()
        .map((d) => ({ id: d.id, type: d.type, createdAt: d.createdAt, seconds: Number(d.data._dictationSeconds) })),
    };
  }

  /* ---------------- plan usage ----------------

     What this clinic has consumed against its allowance, for the current
     calendar month. Two different quantities, and conflating them would
     mislead:

       visits    — what the plan is SOLD in, and what the clinic is charged
                   for. A document created this month counts once, whether or
                   not anyone dictated into it.
       dictation — the billed SECONDS of audio behind those visits, summed from
                   `_dictationSeconds`, which the server (not the client) put
                   there. This is the cost driver, not the price driver.

     Counted on createdAt rather than signing, because a visit consumes its AI
     the day it is documented; a note signed three days late would otherwise
     land in the wrong month and make the meter disagree with the bill. */
  function monthUsage(monthStart) {
    load();
    const start = monthStart || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const startMs = start.getTime();
    const docs = load().documents.filter(mine)
      .filter((d) => new Date(d.createdAt || 0).getTime() >= startMs);
    const st = settings();
    const allowance = Math.max(1, Number(st.visitAllowance) || 130);
    const fairUsePerVisit = Math.max(1, Number(st.fairUseMinutesPerVisit) || 10);

    /* ---- what the month actually consumes ----

       Speech-to-Text is a third of revenue and the only cost that scales with
       how a clinic works rather than how much it works, so an uncapped minute
       is the one number that can take a tier underwater: on the Clinic rung,
       past ~16 minutes a visit we lose money on every visit. The pool below is
       what caps it — at the 10-minute rate a full burn lands around 40% margin
       on every rung, so the ceiling is affordable. It is the RATE that cannot
       move, not the moment the pool becomes available.

       TWO METERS, BOTH SAID PLAINLY, because the plan has two dimensions and
       collapsing them hid one of them.

         visits  — every documented visit costs us a Gemini call (~P0.97)
                   whether a word was dictated or not, so a clinic that types
                   all its notes still has to be bounded. A minutes-only plan
                   leaves this open: 2,000 typed notes is zero minutes and
                   nearly P2,000 of Gemini.
         minutes — the plan carries a whole month of dictation as ONE pool,
                   `allowance x fairUsePerVisit`, available in full on the 1st.
                   All dictation is drawn from it.

       An earlier version converted excess minutes into fractional "visit
       units" so there was a single number. The arithmetic was identical —
       P28 a visit over a 10-minute budget IS P2.80 a minute — but the meter
       said "11 visits counting as 12", which is a conversion the reader has to
       reverse-engineer to check. Overage is now quoted in the unit it was
       incurred in: minutes over, at a peso rate per minute.

       THE POOL IS THE PLAN'S, NOT THE VISITS'. It is there in full on the 1st
       rather than accruing 10 minutes at a time as notes are written. Accrual
       measured the minute side against work done SO FAR, which quietly
       penalised the clinic doing fewer, longer visits: 40 long evaluations
       earned 400 minutes and spent 800, so a practice already paying for 130
       visits it never used got an overage bill on top of it. Cost does not
       work that way. Speech-to-Text bills total minutes, and a capped pool
       burned across 40 visits costs LESS than the same pool burned across 130,
       because it carries 90 fewer Gemini calls. Exposure is bounded by the
       pool either way, so accrual was defending nothing.

       `max(allowance, visits)` rather than a frozen `allowance`, because a
       visit past the plan has to bring its minutes with it. P28 IS a visit
       with its 10 minutes priced in (see `overagePerVisit`) — freezing the
       pool would bill those same minutes twice, once at P28 and again at P3.

       Pooling at all is what makes the minute side fair. Charging each visit
       max(1, minutes/budget) would floor a 4-minute note at a whole visit and
       discard the 6 minutes it did not use, so a clinic writing mostly short
       notes would pay for a long-visit allowance it never received. Pooled,
       those minutes carry to the long evaluations instead — which also tracks
       OUR cost more honestly, since Speech-to-Text bills total minutes and is
       indifferent to how they were split across visits. */
    let seconds = 0, dictated = 0;
    for (const d of docs) {
      const s = Number((d.data || {})._dictationSeconds) || 0;
      if (s > 0) { seconds += s; dictated += 1; }
    }
    const includedMinutes = Math.max(allowance, docs.length) * fairUsePerVisit;
    const usedMinutes = seconds / 60;
    /* Rounded BEFORE it is priced, not after. The card shows whole minutes, and
       a clinic checking "35 minutes over x P3" against the total must get the
       same answer we did — pricing the unrounded 34.83 and rounding the pesos
       gives P104 against a displayed P105, which is precisely the kind of
       one-peso disagreement that makes someone distrust the whole bill. */
    const excessMinutes = Math.round(Math.max(0, usedMinutes - includedMinutes));
    const perMinute = Math.max(0, Number(st.overagePerMinute) || 0);
    const perVisit = Math.max(0, Number(st.overagePerVisit) || 0);
    const visitsOver = Math.max(0, docs.length - allowance);
    // Pace is measured against days ELAPSED, so a projection on the 2nd of the
    // month is honest about being built on one day of data.
    const now = new Date();
    const daysElapsed = Math.max(1, Math.round((now - start) / 86400000) + 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return {
      planName: st.planName || "Solo",
      allowance,
      // ---- meter 1: visits ----
      visits: docs.length,
      remaining: Math.max(0, allowance - docs.length),
      overBy: visitsOver,
      dictationSeconds: Math.round(seconds),
      dictatedVisits: dictated,
      avgSecondsPerVisit: dictated ? Math.round(seconds / dictated) : 0,
      // ---- meter 2: dictation minutes ----
      fairUsePerVisit,
      // the plan's headline pool — the figure the price page quotes
      fairUseMinutes: allowance * fairUsePerVisit,
      // the pool actually in play: the plan's, plus fairUsePerVisit more for
      // every visit past the allowance, so an extra visit is never billed twice
      includedMinutes: Math.round(includedMinutes),
      excessMinutes,
      /* Overage is quoted in the unit it was incurred in. Two separate figures
         rather than one blended number, because a clinic well inside its visit
         allowance but heavy on dictation should see exactly which one it
         crossed — and be able to check the arithmetic without reversing a
         conversion. */
      overagePerMinute: perMinute,
      overagePerVisit: perVisit,
      estimatedOverage: Math.round(excessMinutes * perMinute + visitsOver * perVisit),
      /* Minutes still in the pool. Negative once the pool is spent, so the view
         can say "6 min over" rather than clamping to zero and implying there is
         nothing to see. Nothing is ever RESERVED against it either — a visit
         spends only what is actually dictated, so opening a long evaluation
         costs nothing at all until words are spoken. */
      spareMinutes: Math.round(includedMinutes - seconds / 60),
      minutesUsed: Math.round(seconds / 60),
      daysElapsed,
      daysInMonth,
      projectedVisits: Math.round((docs.length / daysElapsed) * daysInMonth),
      // the minute side needs its own projection now that it bills separately
      projectedMinutes: Math.round((usedMinutes / daysElapsed) * daysInMonth),
      monthStart: start.toISOString().slice(0, 10),
      /* Allowances do NOT roll over. Saying so, with the date, is the whole
         point of carrying it here: an unstated reset is how a billing dispute
         starts. */
      resetsOn: new Date(start.getFullYear(), start.getMonth() + 1, 1).toISOString().slice(0, 10),
    };
  }

  /** Does this patient need a progress report? Triggered every N daily
      visits (N is facility-configurable) until one is written after the
      Nth visit. */
  function progressDue(patientId) {
    load();
    const every = settings().progressEvery || 5;
    const dailies = docsFor(patientId).filter((d) => d.type === "daily");
    if (dailies.length < every) return false;
    const milestones = Math.floor(dailies.length / every);
    const reports = docsFor(patientId).filter((d) => d.type === "progress").length;
    return reports < milestones;
  }

  function createDoc(patientId, type, byUser) {
    if (!canDocument(byUser)) return { error: "Your account can’t create clinical documents." };
    load();
    // charges (CPT/minutes/units) and outcome scores belong to every visit
    // type — an evaluation bills too, and a re-assessment is where outcome
    // measures are usually repeated
    const data = { mapPoints: [], transcript: [], rom: [], mmt: [], special: [], pain: [], charges: [], outcomes: [] };
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
    const { dayStartHour, dayEndHour, slotMinutes, workDays } = settings();
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
    const mins = settings().slotMinutes;
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
      minutes: settings().slotMinutes, note: note || "", status: "booked",
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

  /** Write settings for the signed-in user's clinic only. The full block is
      materialised on first write, so a clinic's configuration can never be
      moved afterwards by a change to the legacy global defaults. */
  function updateSettings(patch, byUser) {
    load();
    const id = currentClinicId();
    state.clinics = state.clinics || {};
    const clinic = state.clinics[id] || { id, name: clinicName(id) };
    const next = { ...settingsFor(id), ...patch };
    delete next.facilityName; // the clinic's `name` is the single source of truth
    state.clinics[id] = { ...clinic, id, settings: next };
    touch(state.clinics[id]);
    save();
    audit(byUser ? byUser.id : null, "settings-updated", JSON.stringify(patch));
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
    // clinics carry the per-clinic name AND settings, so an offline rename or
    // settings change has to survive the merge like any other edit: newest
    // _mod wins, per clinic, and a clinic present on only one side is kept.
    {
      const out = { ...(merged.clinics || {}) };
      for (const [id, lc] of Object.entries(local.clinics || {})) {
        const sc = out[id];
        if (!sc || mtime(lc) > mtime(sc)) out[id] = lc;
      }
      merged.clinics = out;
    }
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
    clinics: clinicsMap, clinicName, currentClinicName, currentClinicId, renameClinic, ensureClinic,
    // operator-only (server gates these to the platform owner)
    createClinic, clinicSummaries,
    // users/auth — users() is global (login/roster lookups); staff() is clinic-scoped
    users: () => load().users, staff: () => load().users.filter(mine), getUser, getUserByEmail, findUserByLogin, login, loginAsDemo, logout, currentUser,
    setAuthenticator, verifyPassword, setPassword, hashLegacyPins, stripDemoCredentials, ensureEmails, ensureDemoAccounts, addUser, upsertGoogleUser, deleteUser,
    licenseExpired, licenseExpiresSoon, canAccessEmr, canDocument,
    // which accounts are seeded demo logins (never infer this from the email domain)
    SEEDED_DEMO_USER_IDS,
    // patients — patients() is clinic-scoped; allPatients() is unscoped (server-side lookups)
    patients: () => load().patients.filter(mine), allPatients: () => load().patients, getPatient, patientName, addPatient, updatePatient, saveAiReview,
    // patient action items / care history (accepted AI recommendations)
    acceptRecommendation, dismissRecommendation, addActionItem, completeActionItem, deleteActionItem,
    actionItems, careHistory, resolvedRecKeys,
    // plan-of-care goals, outcome-measure history, insurance authorisation
    goalsFor, addGoal, updateGoal, deleteGoal, outcomeSeries, authStatus,
    // documents — documents() is clinic-scoped; docsFor(patientId) is patient-scoped
    documents: () => load().documents.filter(mine), docsFor, getDoc, DOC_TITLES, createDoc, addImportedDoc, updateDocData, deleteDoc, signDoc, amendDoc,
    visitCount, progressDue,
    // plan allowance vs. what has actually been consumed this month
    monthUsage,
    // how long this patient takes to dictate — a scheduling input, not a score
    patientDictation,
    // calendar — appointments() is clinic-scoped; allAppointments() is unscoped (server reminders)
    appointments: () => load().appointments.filter(mine), allAppointments: () => load().appointments, slotsForDay, apptsOn, bookAppointment, bookSeries, cancelAppointment,
    // admin
    // settings are per clinic; settingsFor(id) is for server-side lookups by record
    settings, settingsFor, updateSettings, updateUser,
    // access requests (pending-approval queue)
    accessRequests, pendingAccessRequestsAllClinics, requestAccess, approveAccessRequest, declineAccessRequest,
    addClinic,
  };
});
