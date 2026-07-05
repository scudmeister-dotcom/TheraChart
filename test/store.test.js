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
const cancelled = store.cancelAppointment(booked.appt.id, maria);
check("cancellation recorded in history", cancelled.appt.history.some((h) => h.action === "cancelled" && h.userId === "u-maria"));

// --- audit ------------------------------------------------------------------
const log = store.auditLog();
check("audit log captured sign/amend/booking",
  ["doc-signed", "doc-amended", "appointment-created", "appointment-cancelled", "login-denied"]
    .every((a) => log.some((e) => e.action === a)),
  JSON.stringify([...new Set(log.map((e) => e.action))]));

store.resetAll(); // leave a clean seed behind

const total = passed + failures.length;
console.log(`\nTheraChart store checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
