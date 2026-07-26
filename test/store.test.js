/* TheraChart store checker — verifies license gating, e-sign locking,
   amendments, progress-report triggering, and audit logging.
   Run: node test/store.test.js */

"use strict";

const store = require("../store.js");
store.resetAll();

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

const maria = store.getUser("u-maria"); // valid license
const jose = store.getUser("u-jose"); // expired license
const carlo = store.getUser("u-carlo"); // access voided
const ana = store.getUser("u-ana"); // front desk

// --- access gating ------------------------------------------------------
check("voided user cannot log in", store.login("u-carlo", "1234") !== null);
check("wrong PIN refused", store.login("u-maria", "9999") !== null);
check("valid login works", store.login("u-maria", "1234") === null);

check("expired license: EMR access blocked", store.canAccessEmr(jose) === false);
check("expired license: cannot document", store.canDocument(jose) === false);
check("voided: cannot document", store.canDocument(carlo) === false);
check("valid therapist: can document", store.canDocument(maria) === true);
check("front desk: can use scheduling/intake", store.canAccessEmr(ana) === true);
check("front desk: cannot create clinical docs", store.canDocument(ana) === false);

// --- documents: create, lock, amend --------------------------------------
const blocked = store.createDoc("p-juan", "daily", jose);
check("expired license cannot create documents", !!blocked.error, JSON.stringify(blocked));

const { doc } = store.createDoc("p-juan", "daily", maria);
check("valid therapist creates draft", doc && doc.status === "draft");

const upd = store.updateDocData(doc.id, { summary: "TherEx and manual therapy." }, maria);
check("draft is editable", !upd.error);

const badSign = store.signDoc(doc.id, maria, "M. Santos", "");
check("e-sign requires exact typed name", !!badSign.error, JSON.stringify(badSign));

const signed = store.signDoc(doc.id, maria, "Maria Santos, PT", "");
check("e-sign locks the document", !signed.error && signed.doc.status === "signed");
check("signature records name+license+time",
  signed.doc.signatures[0].license === "PT-0012345" && !!signed.doc.signatures[0].time);

const editLocked = store.updateDocData(doc.id, { summary: "changed" }, maria);
check("locked document rejects direct edits", !!editLocked.error, JSON.stringify(editLocked));

const noReason = store.amendDoc(doc.id, maria, "Maria Santos, PT", "Correction: 3 sets not 2.", "");
check("amendment requires authorization reason", !!noReason.error);

const amended = store.amendDoc(doc.id, maria, "Maria Santos, PT", "Correction: 3 sets not 2.", "Documentation error");
check("amendment appends with e-signature", !amended.error && amended.doc.amendments.length === 1);
check("amendment keeps original intact", amended.doc.data.summary === "TherEx and manual therapy.");

// --- progress report trigger ---------------------------------------------
// Seed has 4 signed dailies for Juan; the one created above makes 5.
check("progress due after 5th visit", store.progressDue("p-juan") === true);
const prog = store.createDoc("p-juan", "progress", maria);
check("progress report carries over eval subjective",
  /sharp pain/i.test(prog.doc.data.baselineSubjective || ""), prog.doc.data.baselineSubjective);
check("progress no longer due once written", store.progressDue("p-juan") === false);
check("liza (1 visit) not due", store.progressDue("p-liza") === false);

// --- calendar --------------------------------------------------------------
// use the next working day (slotsForDay is empty on non-work days)
let day = new Date();
let slots = [];
for (let i = 0; i < 7 && !slots.length; i++) {
  day.setDate(day.getDate() + 1);
  slots = store.slotsForDay(day.toISOString().slice(0, 10));
}
check("closed days offer no slots or a work day was found", slots.length > 0);
const free = slots.find((s) => !store.appointments().some((a) => a.start === s && a.therapistId === "u-maria"));
const booked = store.bookAppointment({ patientId: "p-liza", therapistId: "u-maria", start: free, note: "" }, ana);
check("booking works and records creator", !booked.error && booked.appt.createdBy === "u-ana");
check("booking schedules two reminders", booked.appt.reminders.length === 2);
const clash = store.bookAppointment({ patientId: "p-juan", therapistId: "u-maria", start: free, note: "" }, ana);
check("double-booking a therapist is refused", !!clash.error);
// a visit starting mid-slot still puts one therapist in two places at once
const overlapStart = new Date(new Date(free).getTime() + 5 * 60000).toISOString();
const overlap = store.bookAppointment({ patientId: "p-juan", therapistId: "u-maria", start: overlapStart, note: "" }, ana);
check("an overlapping (not identical) booking is refused too", !!overlap.error);
const otherPt = store.bookAppointment({ patientId: "p-juan", therapistId: "u-grace", start: overlapStart, note: "" }, ana);
check("the same time is still bookable for a different therapist", !otherPt.error);
store.cancelAppointment(otherPt.appt.id, maria);
const cancelled = store.cancelAppointment(booked.appt.id, maria);
check("cancellation recorded in history", cancelled.appt.history.some((h) => h.action === "cancelled" && h.userId === "u-maria"));

// --- plan-of-care goals -----------------------------------------------------
{
  const before = store.goalsFor("p-liza").length;
  const added = store.addGoal("p-liza", { text: "Walk 500 m unaided", target: "no rest stops", targetDate: "2026-12-01" }, maria);
  check("a therapist can add a goal", !added.error && !!added.goal.id);
  check("a new goal starts active", added.goal.status === "active");
  check("the goal lands on the patient", store.goalsFor("p-liza").length === before + 1);

  check("front desk cannot add goals", !!store.addGoal("p-liza", { text: "x" }, ana).error);
  check("an expired licence cannot add goals", !!store.addGoal("p-liza", { text: "x" }, jose).error);
  check("a goal needs text", !!store.addGoal("p-liza", { text: "   " }, maria).error);

  const upd = store.updateGoal("p-liza", added.goal.id, { status: "met" }, maria);
  check("a goal can be marked met", !upd.error && upd.goal.status === "met");
  check("the status change is recorded on the goal",
    upd.goal.history.some((h) => h.status === "met" && h.from === "active" && h.userId === "u-maria"),
    JSON.stringify(upd.goal.history));

  check("editing an unknown goal is refused", !!store.updateGoal("p-liza", "nope", { status: "met" }, maria).error);
  const del = store.deleteGoal("p-liza", added.goal.id, maria);
  check("a goal can be removed", !del.error && store.goalsFor("p-liza").length === before);
  check("front desk cannot remove goals", !!store.deleteGoal("p-juan", "g-juan-1", ana).error);
  check("goals for an unknown patient come back empty", store.goalsFor("nope").length === 0);
}

// --- outcome measures -------------------------------------------------------
{
  const series = store.outcomeSeries("p-juan");
  check("outcome scores are gathered across the whole chart", series.length >= 3, String(series.length));
  check("every score carries the date of its note",
    series.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date)), JSON.stringify(series.slice(0, 2)));
  check("the series comes back in date order",
    series.every((s, i) => i === 0 || series[i - 1].date <= s.date));
  check("a chart with no scores yields an empty series", store.outcomeSeries("nope").length === 0);
}

// --- insurance authorisation ------------------------------------------------
{
  const a = store.authStatus(store.getPatient("p-juan"));
  check("authorisation reports the authorised count", a.authorized === 18, String(a.authorized));
  check("visits used is counted from the chart, not stored",
    a.used === store.visitCount("p-juan"), `${a.used} vs ${store.visitCount("p-juan")}`);
  check("remaining is authorised minus used", a.remaining === 18 - a.used);
  check("a live authorisation is neither expired nor exhausted", !a.expired && !a.exhausted);

  // p-juan has documented visits, so "used" is non-zero and can overrun
  const juan = store.getPatient("p-juan");
  juan.authorization = { visitsAuthorized: 1, expiresOn: "2020-01-01", reference: "OLD" };
  const stale = store.authStatus(juan);
  check("a past expiry date reports expired", stale.expired === true);
  check("used beyond the authorised count reports exhausted", stale.exhausted === true, `${stale.used}/${stale.authorized}`);
  check("an exhausted authorisation reports nothing remaining", stale.remaining === 0, String(stale.remaining));

  juan.authorization = { visitsAuthorized: store.visitCount("p-juan") + 2, expiresOn: "2030-01-01" };
  check("two visits left is flagged as low", store.authStatus(juan).low === true);
  juan.authorization = { visitsAuthorized: store.visitCount("p-juan") + 9, expiresOn: "2030-01-01" };
  check("plenty of visits left is not flagged as low", store.authStatus(juan).low === false);

  check("a patient with no authorisation says so", store.authStatus({ id: "nope" }).hasAuth === false);
}

// --- audit ------------------------------------------------------------------
const log = store.auditLog();
check("audit log captured sign/amend/booking",
  ["doc-signed", "doc-amended", "appointment-created", "appointment-cancelled", "login-denied"]
    .every((a) => log.some((e) => e.action === a)),
  JSON.stringify([...new Set(log.map((e) => e.action))]));

// --- access requests (approval queue) ------------------------------------
const req = store.requestAccess({ email: "newhire@clinic.com", name: "New Hire", source: "google" });
check("access request recorded as pending",
  !!req.request && store.accessRequests().some((r) => r.email === "newhire@clinic.com" && r.status === "pending"));
const dupe = store.requestAccess({ email: "newhire@clinic.com", name: "New Hire" });
check("duplicate pending request deduped + counted",
  store.accessRequests().filter((r) => r.email === "newhire@clinic.com").length === 1 && dupe.request.attempts === 2);
const approved = store.approveAccessRequest(req.request.id, { role: "frontdesk" }, ana);
check("approve provisions an active Google account with the chosen role",
  !approved.error && approved.user.active === true && approved.user.role === "frontdesk" && approved.user.authProvider === "google");
check("approved account is reachable by email (so sign-in can succeed)", !!store.getUserByEmail("newhire@clinic.com"));
check("approved request marked resolved", store.accessRequests().find((r) => r.id === req.request.id).status === "approved");
check("re-handling a resolved request is refused", !!store.approveAccessRequest(req.request.id, { role: "therapist" }, ana).error);
const req2 = store.requestAccess({ email: "walkin@clinic.com", name: "Walk In" });
const declined = store.declineAccessRequest(req2.request.id, ana);
check("decline resolves the request without an account",
  declined.ok && store.accessRequests().find((r) => r.id === req2.request.id).status === "declined" && !store.getUserByEmail("walkin@clinic.com"));
check("access request/approve/decline are audited",
  ["access-requested", "access-approved", "access-declined"].every((a) => store.auditLog().some((e) => e.action === a)));

store.resetAll(); // leave a clean seed behind

const total = passed + failures.length;
console.log(`\nTheraChart store checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
