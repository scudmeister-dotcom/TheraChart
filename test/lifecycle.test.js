/* TheraChart lifecycle checker — deleting things, and what deleting does NOT
   undo.

   Two destructive paths meet here and both are about money or records:

     A DRAFT a therapist deletes goes to a trash they can recover from, and the
     dictation minutes and AI passes it already spent stay on the month's bill.
     Google charged for those when they ran; a delete button that quietly
     erased them would be us paying for the clinic's changed mind, and a meter
     that disagreed with the invoice is the thing that makes a clinic distrust
     the whole bill.

     A CLINIC the operator suspends keeps every record and simply cannot sign
     in. A clinic the operator deletes loses everything under it, which is why
     it takes the clinic's name typed out to do it.

   Run: node test/lifecycle.test.js */

"use strict";

const store = require("../store.js");

store.resetAll();

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

const maria = store.getUser("u-maria");   // licensed therapist — can document
const grace = store.getUser("u-grace");   // clinic admin

/* ================= deleting a draft ================= */

const patient = store.patients()[0];

// 1. a draft that spent nothing
const clean = store.createDoc(patient.id, "daily", maria).doc;
// 2. a draft that spent real money before it was abandoned
const spent = store.createDoc(patient.id, "daily", maria).doc;
store.updateDocData(spent.id, { _dictationSeconds: 372 }, maria);
store.recordDocAiCall(spent.id);
store.recordDocAiCall(spent.id);

check("a fresh draft has spent nothing", store.docConsumption(clean).billed === false);
check("a dictated, AI-reviewed draft reads as billed", store.docConsumption(spent).billed === true);
check("consumption reports whole minutes", store.docConsumption(spent).minutes === 6,
  `got ${store.docConsumption(spent).minutes}`);
check("consumption counts each AI pass", store.docConsumption(spent).aiCalls === 2,
  `got ${store.docConsumption(spent).aiCalls}`);

// --- signed records are never deletable ---
const signed = store.createDoc(patient.id, "daily", maria).doc;
store.signDoc(signed.id, maria, maria.name, "Original completion");
const refused = store.trashDoc(signed.id, maria);
check("a signed note refuses to be deleted", !!refused.error, JSON.stringify(refused));
check("...and says to amend it instead", /amendment/i.test(refused.error || ""), refused.error);
check("...and is still in the chart", store.docsFor(patient.id).some((d) => d.id === signed.id));

// --- deleting hides, but does not destroy ---
// counted here, with every document of this block already created, so the
// deltas below are the delete's doing and nothing else's
const before = store.monthUsage();
store.trashDoc(spent.id, maria);
check("a deleted draft leaves the chart", !store.docsFor(patient.id).some((d) => d.id === spent.id));
check("...and is not in the clinic-wide document list", !store.documents().some((d) => d.id === spent.id));
check("...but is listed in the trash", store.deletedDocsFor(patient.id).some((d) => d.id === spent.id));
check("...stamped with who deleted it and when",
  !!store.getDoc(spent.id).deletedAt && store.getDoc(spent.id).deletedBy === maria.id);

/* THE POINT OF THE WHOLE FILE. Six dictated minutes were transcribed by Google
   and two Gemini calls were made. Deleting the note afterwards does not unmake
   either, so the visit and the minutes both stay on the meter. */
const afterSpent = store.monthUsage();
check("a deleted draft that spent something still counts as a visit",
  afterSpent.visits === before.visits, `${before.visits} → ${afterSpent.visits}`);
check("...and its dictation minutes stay on the meter",
  afterSpent.minutesUsed === before.minutesUsed, `${before.minutesUsed} → ${afterSpent.minutesUsed}`);

/* And the other way round: nothing was spent, so there is no cost to recover
   and charging a visit for an abandoned empty form would be inventing one. */
store.trashDoc(clean.id, maria);
const afterClean = store.monthUsage();
check("a deleted draft that spent nothing drops off the meter",
  afterClean.visits === afterSpent.visits - 1, `${afterSpent.visits} → ${afterClean.visits}`);

// --- and it comes back ---
store.restoreDoc(spent.id, maria);
check("a restored draft is back in the chart", store.docsFor(patient.id).some((d) => d.id === spent.id));
check("...and out of the trash", !store.deletedDocsFor(patient.id).some((d) => d.id === spent.id));
check("...with its dictation seconds intact",
  Number(store.getDoc(spent.id).data._dictationSeconds) === 372);
/* Unchanged, not one higher: it was already being counted while it sat in the
   trash, because it had spent something. Restoring it must not bill it twice. */
check("restoring does not double-count the visit",
  store.monthUsage().visits === afterClean.visits, `${afterClean.visits} → ${store.monthUsage().visits}`);

const frontDesk = store.staff().find((u) => u.role === "frontdesk");
if (frontDesk) {
  const denied = store.trashDoc(spent.id, frontDesk);
  check("an account that can't document can't delete either", !!denied.error, JSON.stringify(denied));
}

/* ================= suspending and deleting a clinic ================= */

const AUTH_PLAIN = { hash: (p) => `plain$${p}`, verify: (u, p) => u.passwordHash === `plain$${p}` };
store.setAuthenticator(AUTH_PLAIN);

const made = store.createClinic({
  clinicName: "Bayanihan Physical Therapy",
  ownerName: "Bea Navarro, PT",
  ownerEmail: "bea@bayanihanpt.ph",
  password: "temp-pass-1234",
}, grace);
const other = made.clinic;

check("a new clinic records the day it signed on", !!store.clinicMeta(other.id).createdAt);
check("...and starts active", store.clinicMeta(other.id).active === true);
check("a clinic summary carries its status", (store.clinicSummaries().find((c) => c.id === other.id) || {}).active === true);

// --- suspend: reversible, and loses nothing ---
store.setClinicActive(other.id, false, grace);
check("a suspended clinic reads as inactive", store.clinicMeta(other.id).active === false);
const blocked = store.login("bea@bayanihanpt.ph", "temp-pass-1234");
check("its staff cannot sign in", !!blocked, String(blocked));
check("...and are told the records are safe, not that they were revoked",
  /on hold/i.test(blocked || "") && /safe/i.test(blocked || ""), String(blocked));
check("...while the account itself is untouched", store.getUserByEmail("bea@bayanihanpt.ph").active === true);

store.setClinicActive(other.id, true, grace);
check("reactivating lets them straight back in", store.login("bea@bayanihanpt.ph", "temp-pass-1234") === null);
store.logout();

const ownClinic = store.setClinicActive(grace.clinicId || "clinic-demo", false, grace);
check("nobody can suspend the clinic they are signed in to", !!ownClinic.error, JSON.stringify(ownClinic));

// --- delete: irreversible, and gated on the name ---
const beforeUsers = store.users().length;
const wrongName = store.deleteClinic(other.id, grace, "Bayanihan PT");
check("a near-miss on the name does not delete a clinic", !!wrongName.error, JSON.stringify(wrongName));
check("...and nothing was removed", store.users().length === beforeUsers);

const ownDelete = store.deleteClinic(grace.clinicId || "clinic-demo", grace, "Physical Therapy Center");
check("nobody can delete the clinic they are signed in to", !!ownDelete.error, JSON.stringify(ownDelete));

const gone = store.deleteClinic(other.id, grace, "bayanihan physical therapy"); // case-insensitive
check("the exact name deletes it", gone.ok === true, JSON.stringify(gone));
check("...and reports what went with it", gone.removed && gone.removed.users === 1, JSON.stringify(gone.removed));
check("the clinic is off the roster", !store.clinicSummaries().some((c) => c.id === other.id));
check("its accounts are gone", !store.getUserByEmail("bea@bayanihanpt.ph"));
check("...so they cannot sign in", !!store.login("bea@bayanihanpt.ph", "temp-pass-1234"));

/* The operator's own record of the deletion survives it — the deleted clinic's
   log goes with the clinic, but who removed it, and what it held, does not. */
check("the deletion is written to the operator's activity log",
  store.auditLog().some((a) => a.action === "clinic-deleted" && /Bayanihan/.test(a.detail || "")));

/* ================= report ================= */

console.log(`\nTheraChart lifecycle checker: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
