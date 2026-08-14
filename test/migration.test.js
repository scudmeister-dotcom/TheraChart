/* TheraChart migration checker — can today's code read yesterday's database?

   The deployed Cloud SQL database predates multi-clinic tenancy: no record
   carries a `clinicId`, there is no `clinics` map, and settings are a single
   global block. Everything since relies on those shapes being handled by
   fallbacks rather than a migration script, so this boots the real server
   against a genuinely old-shaped database and checks nothing vanishes,
   nothing is silently reconfigured, and writes still work afterwards.

   A failure here means deploying would damage live records. Run: node test/migration.test.js */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer, reporter } = require("./helpers/server.js");

// A database as it existed before tenancy: no clinicId anywhere, no clinics
// map, one global settings block with non-default values.
const LEGACY_STATE = {
  settings: {
    facilityName: "Bayanihan Physical Therapy",
    progressEvery: 4, slotMinutes: 30, dayStartHour: 7, dayEndHour: 19,
    workDays: [1, 2, 3, 4, 5], audioReview: true, audioReviewDays: 14,
  },
  users: [
    { id: "u-old-admin", name: "Grace Lim, PT (Admin)", email: "grace@old.demo", role: "admin", active: true,
      pin: "1234", license: { number: "PT-1", expires: "2099-01-01" } },
    { id: "u-old-pt", name: "Maria Santos, PT", email: "maria@old.demo", role: "therapist", active: true,
      pin: "1234", license: { number: "PT-2", expires: "2099-01-01" } },
    // a Google account provisioned before clinicId existed
    { id: "u-old-google", name: "Owner", email: "owner@old.demo", role: "admin", active: true,
      authProvider: "google", googleSub: "123", license: null },
  ],
  patients: [
    { id: "p-old-1", firstName: "Juan", lastName: "Reyes", dob: "1988-04-12", attachments: [] },
    { id: "p-old-2", firstName: "Liza", lastName: "Mercado", dob: "1975-11-02", attachments: [] },
  ],
  documents: [
    { id: "d-old-1", patientId: "p-old-1", type: "daily", status: "signed", title: "Daily Note — Visit 1",
      date: "2026-01-05T09:00:00.000Z", data: { subjective: "shoulder pain" },
      signatures: [{ by: "u-old-pt", at: "2026-01-05T09:30:00.000Z" }], amendments: [], history: [] },
  ],
  appointments: [
    { id: "ap-old-1", patientId: "p-old-1", therapistId: "u-old-pt", start: "2026-01-06T02:00:00.000Z",
      minutes: 30, status: "booked", reminders: [], history: [] },
  ],
  audit: [{ time: "2026-01-05T09:30:00.000Z", userId: "u-old-pt", action: "doc-signed", detail: "Daily Note" }],
  accessRequests: [],
  sessionUserId: null,
};

(async () => {
  const R = reporter("migration checker");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-migration-"));
  fs.writeFileSync(path.join(dir, "therachart.json"), JSON.stringify(LEGACY_STATE, null, 2));
  fs.writeFileSync(path.join(dir, "rev"), "7");

  const srv = await startServer({}, { dataDir: dir });
  try {
    const login = await srv.login("maria@old.demo", "1234");
    R.check("a pre-tenancy account can still sign in", !!login.data.token, login.data.error);
    if (!login.data.token) throw new Error("no session — the rest cannot be checked");
    const token = login.data.token;
    const pull = async () => (await srv.call("/api/state", { token })).data;

    const st = (await pull()).state;

    /* ---- nothing disappears ---- */
    R.check("both legacy patients are visible", (st.patients || []).length === 2, `saw ${(st.patients || []).length}`);
    R.check("the legacy document is visible", (st.documents || []).length === 1);
    R.check("the legacy document is still signed", (st.documents[0] || {}).status === "signed");
    R.check("its signature survives", ((st.documents[0] || {}).signatures || []).length === 1);
    R.check("the legacy appointment is visible", (st.appointments || []).length === 1);
    R.check("legacy staff are visible", (st.users || []).length === 3, `saw ${(st.users || []).length}`);
    R.check("the legacy audit entry survives", (st.audit || []).length >= 1);
    R.check("the pre-tenancy Google admin is not orphaned",
      !!(st.users || []).find((u) => u.id === "u-old-google"));

    /* ---- un-stamped records resolve to the demo clinic, consistently ---- */
    R.check("un-stamped records resolve to the demo clinic",
      (st.patients || []).every((p) => (p.clinicId || "clinic-demo") === "clinic-demo"));

    /* ---- the clinic keeps its configuration ---- */
    const s = st.settings || {};
    R.check("the old global settings become this clinic's own",
      s.progressEvery === 4 && s.slotMinutes === 30 && s.dayStartHour === 7 && s.dayEndHour === 19,
      JSON.stringify({ prog: s.progressEvery, slot: s.slotMinutes, start: s.dayStartHour, end: s.dayEndHour }));
    R.check("audioReview is NOT silently flipped off", s.audioReview === true, `audioReview=${s.audioReview}`);
    R.check("the audio retention window is preserved", s.audioReviewDays === 14, String(s.audioReviewDays));
    R.check("the facility name carries over", s.facilityName === "Bayanihan Physical Therapy", s.facilityName);

    /* ---- a Google account must not inherit the demo clinic ---- */
    // The seeded demo logins and their password are published on the sign-in
    // screen. A pre-tenancy Google account falls back to the demo clinic, which
    // would leave real patient records under a publicly known admin login.
    // upsertGoogleUser re-stamps un-stamped accounts on next sign-in.
    const store = require("../store.js");
    store.importAll(JSON.parse(JSON.stringify(LEGACY_STATE)), { preserveSession: false });
    const legacyGoogle = store.getUserByEmail("owner@old.demo");
    R.check("the legacy Google account starts with no clinic", !legacyGoogle.clinicId,
      `clinicId=${legacyGoogle.clinicId}`);

    const up = store.upsertGoogleUser({ email: "owner@old.demo", name: "Owner", role: "admin", clinicId: "clinic-owner" });
    R.check("signing in moves it off the demo-clinic fallback", up.user.clinicId === "clinic-owner", up.user.clinicId);

    // an account that already belongs somewhere is never yanked out of it
    const settled = store.upsertGoogleUser({ email: "owner@old.demo", name: "Owner", role: "admin", clinicId: "clinic-somewhere-else" });
    R.check("an already-placed account is not moved on later sign-ins",
      settled.user.clinicId === "clinic-owner", settled.user.clinicId);

    // brand-new Google accounts land in the configured clinic, not the demo one
    const fresh = store.upsertGoogleUser({ email: "newstaff@old.demo", name: "New Staff", role: "therapist", clinicId: "clinic-owner" });
    R.check("a new Google account joins the configured clinic", fresh.user.clinicId === "clinic-owner", fresh.user.clinicId);
    R.check("and not the demo clinic", fresh.user.clinicId !== "clinic-demo");

    store.ensureClinic("clinic-owner", "My Clinic");
    R.check("the clinic gets a readable name", store.clinicName("clinic-owner") === "My Clinic", store.clinicName("clinic-owner"));
    store.ensureClinic("clinic-owner", "Something Else");
    R.check("ensureClinic never renames an existing clinic", store.clinicName("clinic-owner") === "My Clinic", store.clinicName("clinic-owner"));

    /* ---- and the migrated database is still writable ---- */
    const cur = await pull();
    const next = JSON.parse(JSON.stringify(cur.state));
    next.patients.push({ id: "p-new", firstName: "New", lastName: "Patient", attachments: [] });
    const put = await srv.call("/api/state", { method: "PUT", token, body: { baseRev: cur.rev, state: next } });
    R.check("a write against migrated data succeeds", put.status === 200, `-> ${put.status}`);

    const after = (await pull()).state;
    R.check("the new record is stamped with the clinic",
      (after.patients.find((p) => p.id === "p-new") || {}).clinicId === "clinic-demo");
    R.check("legacy records survive the write", after.patients.length === 3, `${after.patients.length}`);
    R.check("the legacy signed note is still signed after a write",
      (after.documents.find((d) => d.id === "d-old-1") || {}).status === "signed");
  } finally {
    srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  R.done();
})().catch((e) => { console.error("migration checker crashed:", e); process.exit(1); });
