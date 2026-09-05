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
/* Seeded demo accounts ship with no password, so login() is exercised on an
   account given one here. The voided check still uses carlo: being blocked
   must not depend on whether a credential was even offered. */
store.setPassword("u-maria", "mariaPass123", store.getUser("u-grace"));
check("voided user cannot log in", store.login("u-carlo", "anything") !== null);
check("wrong PIN refused", store.login("u-maria", "9999") !== null);
check("valid login works", store.login("u-maria", "mariaPass123") === null);
check("a seeded demo account has no password until one is set",
  (() => { const j = store.getUser("u-jose"); return j.pin == null && !j.passwordHash; })());

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
// Seed has 4 signed dailies for Bautista; the one created above makes 5.
// Chasing one is opt-in: with the reminder off, nothing is ever "due".
const grace = store.staff().find((u) => u.role === "admin");
check("nothing is due while the reminder is off", store.progressDue("p-juan") === false);
check("the count is reported either way",
  store.progressToward("p-juan").done === 0 && store.progressToward("p-juan").every === 5,
  JSON.stringify(store.progressToward("p-juan")));

store.updateSettings({ progressReminder: true }, grace);
check("progress due after 5th visit once the reminder is on", store.progressDue("p-juan") === true);
const prog = store.createDoc("p-juan", "progress", maria);
check("progress report carries over eval subjective",
  /sharp pain/i.test(prog.doc.data.baselineSubjective || ""), prog.doc.data.baselineSubjective);
check("progress no longer due once written", store.progressDue("p-juan") === false);
check("liza (1 visit) not due", store.progressDue("p-liza") === false);
store.updateSettings({ progressReminder: false }, grace);

// --- who may set what the clinic charges ----------------------------------
// Entering a code on a note and deciding what that code costs are separate
// permissions: the first is clinical, the second is commercial.
check("an admin can set prices", store.canSetPrices(grace) === true);
check("a licensed therapist cannot", store.canSetPrices(maria) === false);
check("the front desk cannot", store.canSetPrices(ana) === false);
check("nobody at all cannot", store.canSetPrices(null) === false);
check("an admin who predates the flag is not locked out",
  store.canSetPrices({ role: "admin", active: true }) === true);
check("a therapist cannot grant themselves billing access",
  !!(store.updateUser(maria.id, { billingAccess: true }, maria) || {}).error);
check("…and did not get it", store.canSetPrices(store.getUser(maria.id)) === false);
// Grace is the only admin in the demo clinic, so she cannot strand the
// price list by revoking her own access.
check("the last admin with billing access can't revoke their own",
  !!(store.updateUser(grace.id, { billingAccess: false }, grace) || {}).error);
check("…and still has it", store.canSetPrices(store.getUser(grace.id)) === true);
// With a second admin holding it, revoking the first is allowed again.
check("billing access can be revoked once someone else holds it", (() => {
  const st = JSON.parse(store.exportAll());
  st.users.push({ id: "u-admin2", clinicId: grace.clinicId, name: "Second Admin", email: "second@demo",
                  role: "admin", active: true, pin: "1234", license: null });
  store.importAll(st);
  const r = store.updateUser(grace.id, { billingAccess: false }, store.getUser("u-admin2"));
  return !(r || {}).error && store.canSetPrices(store.getUser(grace.id)) === false;
})());
store.updateUser(grace.id, { billingAccess: true }, store.getUser("u-admin2"));
check("…and given back", store.canSetPrices(store.getUser(grace.id)) === true);
{
  const voided = Object.assign({}, store.getUser(grace.id), { active: false });
  check("a voided admin sets nothing", store.canSetPrices(voided) === false);
}

// The price list is per clinic. The demo clinic ships with a worked one so
// the showcase adds up; every other clinic starts empty, because we do not
// know what a clinic charges and a made-up default would be billed to a
// patient. The demo's list must not leak through the legacy global block.
check("the demo clinic ships with a worked price list",
  store.settings().servicePrices.PT02 === 850, JSON.stringify(store.settings().servicePrices));
check("a clinic that has set nothing has no prices",
  JSON.stringify(store.settingsFor("clinic-fresh").servicePrices) === "{}",
  JSON.stringify(store.settingsFor("clinic-fresh").servicePrices));
store.updateSettings({ servicePrices: { PT02: 900 } }, grace);
check("a saved price survives a read", store.settings().servicePrices.PT02 === 900);

// --- doctor's communication log ------------------------------------------
// An ORDER changes what may be done to the patient, so it stays outstanding
// until a clinician says they acted on it. A note is just a record.
{
  const before = store.outstandingOrders("p-juan").length;
  check("the seeded chart carries an outstanding order", before === 1, String(before));

  const note = store.addDoctorComm("p-juan", { kind: "note", text: "Copy of the MRI report received." }, ana);
  check("the front desk can log what the doctor said", !note.error, note.error);
  check("a note never becomes outstanding work",
    store.outstandingOrders("p-juan").length === before, "a record is not a task");

  const order = store.addDoctorComm("p-juan", { kind: "order", text: "Reduce to 1x/week." }, ana);
  check("…and can log a new order too", !order.error, order.error);
  check("an order IS outstanding the moment it is logged",
    store.outstandingOrders("p-juan").length === before + 1);
  check("an order defaults to today when no date is given",
    /^\d{4}-\d{2}-\d{2}$/.test(order.entry.date), order.entry.date);
  check("an empty entry is refused", !!store.addDoctorComm("p-juan", { text: "  " }, ana).error);

  // acting on an order is a clinical act, logging one is not
  check("the front desk cannot sign off an order",
    !!store.acknowledgeDoctorComm("p-juan", order.entry.id, ana).error,
    "whoever says an order was carried out has to be someone who could have carried it out");
  check("…and it is still outstanding", store.outstandingOrders("p-juan").length === before + 1);

  const ack = store.acknowledgeDoctorComm("p-juan", order.entry.id, maria);
  check("a licensed clinician can", !ack.error && ack.entry.acknowledged === true, ack.error);
  check("…which clears it from the outstanding list",
    store.outstandingOrders("p-juan").length === before);
  check("…and records who did it and when",
    ack.entry.acknowledgedBy === maria.id && !!ack.entry.acknowledgedAt);

  check("acknowledging twice is harmless",
    !store.acknowledgeDoctorComm("p-juan", order.entry.id, maria).error);
  check("an unknown entry is refused",
    !!store.acknowledgeDoctorComm("p-juan", "dc-nope", maria).error);
  check("the front desk cannot delete an entry",
    !!store.deleteDoctorComm("p-juan", order.entry.id, ana).error);
  check("a clinician can", !store.deleteDoctorComm("p-juan", order.entry.id, maria).error);
  check("a patient with no log reads as empty, not undefined",
    Array.isArray(store.doctorComms("p-liza")) && store.doctorComms("p-liza").length === 0);
}
check("…and does not reach another clinic",
  JSON.stringify(store.settingsFor("clinic-fresh").servicePrices) === "{}");

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
