/* TheraChart reliability, polish & clinical-features checker.
   Run: node test/reliability-clinical.test.js */

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
};

const ROOT = path.join(__dirname, "..");

/* ---------------- 1. Load isolated store with controllable storage backend ---------------- */
function makeStore(storageImpl) {
  const ctx = {
    console,
    Date,
    Math,
    JSON,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Buffer,
    THERACHART_STORAGE: storageImpl,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "store.js"), "utf8"), ctx, { filename: "store.js" });
  return ctx.TheraStore;
}

/* ---- 1a. localStorage quota recovery & error hook ---- */
{
  const mem = new Map();
  let maxLen = Infinity;
  let alwaysFail = false;
  const backend = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      if (alwaysFail) throw new Error("QuotaExceededError: disk full");
      if (v.length > maxLen) throw new Error("QuotaExceededError: over limit");
      mem.set(k, v);
    },
    removeItem: (k) => mem.delete(k),
  };
  const S = makeStore(backend);
  const events = [];
  S.setStorageErrorHook((ev) => events.push(ev));
  S.load();
  const admin = S.users().find((u) => u.role === "admin");
  S.loginAsDemo(admin.id);
  const baseLen = (mem.get("therachart-emr-v1") || "").length;

  // Fill audit log past 200 entries so quota recovery has older rows to trim
  const st = S.load();
  for (let i = 0; i < 450; i++) {
    st.audit.push({ time: "2026-01-01T00:00:00.000Z", userId: admin.id, clinicId: admin.clinicId, action: "filler", detail: "x".repeat(120) });
  }
  const bloatedLen = JSON.stringify(st).length;
  // Set quota between trimmed (~200 audit rows) and bloated (~450+ audit rows)
  maxLen = Math.floor((baseLen + bloatedLen) / 2) + 25000;
  S.save();
  check("quota recovery trims audit log and succeeds", S.storageError() === null && S.load().audit.length === 200,
    `err=${S.storageError()} len=${S.load().audit.length}`);
  check("quota recovery notifies storageErrorHook({ recovered: true })",
    events.some((e) => e && e.recovered === true && e.trimmedAudit > 0), JSON.stringify(events));

  // Persistent failure surfaces storageError and clears once storage succeeds again
  alwaysFail = true;
  S.save();
  check("persistent quota failure records storageError()", /QuotaExceededError/.test(S.storageError() || ""), String(S.storageError()));
  check("persistent quota failure notifies hook with { error }",
    events.some((e) => e && e.error && /QuotaExceededError/.test(e.error)), JSON.stringify(events));

  alwaysFail = false;
  maxLen = Infinity;
  S.save();
  check("subsequent successful save clears storageError()", S.storageError() === null && events[events.length - 1] === null);
}

/* ---------------- 2. Clinical store features: HEP, Carry Forward, Search, Appt Statuses ---------------- */
{
  const mem = new Map();
  const S = makeStore({
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  });
  S.load();
  const pt = S.users().find((u) => u.id === "u-maria");
  const admin = S.users().find((u) => u.id === "u-grace");
  const fd = S.users().find((u) => u.id === "u-ana");
  S.loginAsDemo(pt.id);

  const pat = S.addPatient({ firstName: "Elena", lastName: "Cruz", dob: "1985-05-12", phone: "+63 917 000 1234" }, pt.id);

  // Empty chart has no carry-forward source
  check("lastVisitSource returns null on brand-new patient", S.lastVisitSource(pat.id, null) === null);

  // Create first daily note with summary, plan, HEP, and body map
  const { doc: d1 } = S.createDoc(pat.id, "daily", pt);
  check("createDoc initializes data.hep as array", Array.isArray(d1.data.hep) && d1.data.hep.length === 0);
  S.updateDocData(d1.id, {
    summary: "Therapeutic exercise for rotator cuff and scapular stabilization",
    plan: "Continue 3x/wk, progress resistance band",
    hep: [{ id: "hep-1", name: "Wall slides", sets: "3", reps: "10", hold: "5s", frequency: "2x/day", notes: "Pain-free arc" }],
    special: [{ name: "Neer test", side: "right", result: "positive" }],
  }, pt);

  const { doc: d2 } = S.createDoc(pat.id, "daily", pt);
  const src = S.lastVisitSource(pat.id, d2.id);
  check("lastVisitSource finds prior daily note excluding current draft", src && src.id === d1.id, src && src.id);

  // Full-text document search
  const hits1 = S.searchDocuments("rotator cuff", { patientId: pat.id });
  check("searchDocuments matches narrative text", hits1.length === 1 && hits1[0].doc.id === d1.id && /rotator/i.test(hits1[0].snippet));

  const hitsHep = S.searchDocuments("wall slides", { patientId: pat.id });
  check("searchDocuments matches HEP exercise names", hitsHep.length === 1 && hitsHep[0].doc.id === d1.id);

  const hitsSpecial = S.searchDocuments("neer positive");
  check("searchDocuments matches across special tests clinic-wide", hitsSpecial.some((h) => h.doc.id === d1.id));

  const hitsMiss = S.searchDocuments("nonexistent-xyz-token", { patientId: pat.id });
  check("searchDocuments returns empty array on non-match", hitsMiss.length === 0);

  // Trashed draft is excluded from searchDocuments
  S.trashDoc(d2.id, pt);
  check("trashed docs stay excluded from searchDocuments", !S.searchDocuments("Visit", { patientId: pat.id }).some((h) => h.doc.id === d2.id));

  // Appointment lifecycle statuses
  S.loginAsDemo(fd.id);
  const day = "2026-12-01";
  const slots = S.slotsForDay(day);
  const { appt } = S.bookAppointment({ patientId: pat.id, therapistId: pt.id, start: slots[0], note: "Follow-up" }, fd);
  check("new appointment starts with status booked", appt && appt.status === "booked");

  const rArr = S.setAppointmentStatus(appt.id, "arrived", fd);
  check("front desk can mark appointment arrived", !rArr.error && rArr.appt.status === "arrived");
  check("arrived appointment remains on apptsOn(day)", S.apptsOn(day).some((a) => a.id === appt.id));

  const rComp = S.setAppointmentStatus(appt.id, "completed", admin);
  check("admin can mark appointment completed", !rComp.error && rComp.appt.status === "completed");
  check("status change appended to appointment history", rComp.appt.history.some((h) => h.status === "completed"));

  const rNoShow = S.setAppointmentStatus(appt.id, "no-show", fd);
  check("front desk can mark appointment no-show", !rNoShow.error && rNoShow.appt.status === "no-show");

  const rBad = S.setAppointmentStatus(appt.id, "bogus-status", fd);
  check("invalid appointment status is rejected", !!rBad.error);

  const rTher = S.setAppointmentStatus(appt.id, "completed", pt);
  check("therapist cannot directly change appointment status (enforces canEditSchedule)", !!rTher.error);

  const rCancel = S.setAppointmentStatus(appt.id, "cancelled", fd);
  check("cancelled appointment is excluded from apptsOn(day)", !rCancel.error && !S.apptsOn(day).some((a) => a.id === appt.id));
}

/* ---------------- 3. feel.js TAB_ORDER includes scan ---------------- */
{
  const feelSrc = fs.readFileSync(path.join(ROOT, "feel.js"), "utf8");
  const ctx = {
    window: {},
    document: {
      documentElement: { classList: { add() {}, remove() {} } },
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: "" },
    setTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(feelSrc, ctx, { filename: "feel.js" });
  check("feel.js slides right from #/patients to #/scan", ctx.window.TheraFeel.directionFor("#/patients", "#/scan") === "right");
  check("feel.js slides left from #/calendar to #/scan", ctx.window.TheraFeel.directionFor("#/calendar", "#/scan") === "left");
}

/* ---------------- 4. Code hygiene & wiring checks ---------------- */
{
  const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const syncSrc = fs.readFileSync(path.join(ROOT, "sync.js"), "utf8");
  const appCodeOnly = appSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const bareConfirm = appCodeOnly.match(/(^|[^\w.])confirm\s*\(/gm) || [];
  check("app.js has zero native confirm() calls left", bareConfirm.length === 0, JSON.stringify(bareConfirm));
  check("app.js wires beforeunload guard", /addEventListener\("beforeunload"/.test(appSrc));
  check("app.js wires error boundary in render()", /function renderCrashCard\(/.test(appSrc));
  check("app.js includes idle lock overlay, theme switcher, quick jump, HEP, carry-forward, trends, and week view",
    ["showIdleLock", "setThemePref", "openQuickJump", "hepEditor", "printHepHandout", "openCarryForwardModal", "progressTrendsCard", "weekDaysOf"]
      .every((fn) => appSrc.includes(fn)));
  check("sync.js pauses polling when hidden and listens to online/offline + visibilitychange",
    syncSrc.includes("document.hidden") && syncSrc.includes("visibilitychange") && syncSrc.includes('"online"') && syncSrc.includes("authExpired"));
}

if (failures.length) {
  console.error(`\nTheraChart reliability & clinical checker: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error(f));
  process.exit(1);
}
console.log(`TheraChart reliability & clinical checker: ${passed}/${passed} checks passed`);
