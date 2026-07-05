/* TheraChart offline-merge checker — verifies that reconnecting after
   offline work never loses anyone's records. Run: node test/merge.test.js */

"use strict";

const store = require("../store.js");
store.resetAll();

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

const base = JSON.parse(store.exportAll());
const clone = (x) => JSON.parse(JSON.stringify(x));
const later = (ms) => new Date(Date.now() + ms).toISOString();

// ---- diverge: the "server" and an offline "device" both do work ----
const server = clone(base);
const device = clone(base);

// device (offline): registers a patient, edits Liza's draft eval, books a visit
device.patients.push({
  id: "p-offline", firstName: "Field", lastName: "Visit", dob: "1990-01-01",
  phone: "+63 900 000 0000", attachments: [], createdBy: "u-maria",
  createdAt: later(1000), _mod: later(1000),
});
const devEval = device.documents.find((d) => d.id === "d-eval-liza");
devEval.data.assessment = "Edited on the road";
devEval._mod = later(5000); // newer than any server edit below
device.appointments.push({
  id: "ap-offline", patientId: "p-liza", therapistId: "u-maria",
  start: later(86400000), minutes: 45, note: "", status: "booked",
  createdBy: "u-maria", createdAt: later(1200), _mod: later(1200),
  history: [{ action: "created", userId: "u-maria", time: later(1200) }], reminders: [],
});
device.audit.push({ time: later(1300), userId: "u-maria", action: "patient-created", detail: "Visit, Field" });

// server (meanwhile): front desk edits the SAME draft eval (older), signs a
// daily note amendment, and updates a phone number
const srvEval = server.documents.find((d) => d.id === "d-eval-liza");
srvEval.data.assessment = "Edited at the clinic (older)";
srvEval._mod = later(2000);
const srvDaily = server.documents.find((d) => d.id === "d-daily-juan-1");
srvDaily.amendments.push({ text: "Late entry", reason: "Late entry", userId: "u-maria", name: "Maria Santos, PT", license: "PT-0012345", time: later(1500) });
srvDaily._mod = later(1500);
const srvLiza = server.patients.find((p) => p.id === "p-liza");
srvLiza.phone = "+63 917 555 9999";
srvLiza._mod = later(1600);
server.audit.push({ time: later(1700), userId: "u-ana", action: "patient-updated", detail: "Mercado, Liza" });

// ---- merge ----
const { state: merged, conflicts } = store.mergeStates(server, device);

check("offline-created patient survives", merged.patients.some((p) => p.id === "p-offline"));
check("offline-created booking survives", merged.appointments.some((a) => a.id === "ap-offline"));
check("newer offline edit wins the draft",
  merged.documents.find((d) => d.id === "d-eval-liza").data.assessment === "Edited on the road");
check("losing edit is reported as a conflict",
  conflicts.some((c) => c.kind === "documents" && c.id === "d-eval-liza"), JSON.stringify(conflicts));
check("server amendment survives",
  merged.documents.find((d) => d.id === "d-daily-juan-1").amendments.some((a) => a.text === "Late entry"));
check("server phone update survives (device didn't touch it)",
  merged.patients.find((p) => p.id === "p-liza").phone === "+63 917 555 9999");
check("audit entries from both sides union",
  merged.audit.some((e) => e.detail === "Visit, Field") &&
  merged.audit.some((e) => e.detail === "Mercado, Liza"));
check("merged state carries no session", merged.sessionUserId === null);

// ---- signed beats draft, regardless of timestamps ----
{
  const s2 = clone(base), d2 = clone(base);
  const sDoc = s2.documents.find((d) => d.id === "d-eval-liza");
  sDoc.status = "signed";
  sDoc.signatures.push({ userId: "u-maria", name: "Maria Santos, PT", license: "PT-0012345", time: later(100), reason: "Original completion" });
  sDoc._mod = later(100);
  const dDoc = d2.documents.find((d) => d.id === "d-eval-liza");
  dDoc.data.assessment = "Draft edit made later, offline";
  dDoc._mod = later(9999);
  const m2 = store.mergeStates(s2, d2).state;
  const doc2 = m2.documents.find((d) => d.id === "d-eval-liza");
  check("signed beats a later draft edit", doc2.status === "signed" && doc2.data.assessment !== "Draft edit made later, offline");
  check("signature preserved through merge", doc2.signatures.length === 1);
}

// ---- cancelled bookings stay cancelled ----
{
  const s3 = clone(base), d3 = clone(base);
  const sAp = s3.appointments[0];
  sAp.status = "cancelled";
  sAp.history.push({ action: "cancelled", userId: "u-ana", time: later(50) });
  sAp._mod = later(50);
  const dAp = d3.appointments[0];
  dAp.note = "offline note edit";
  dAp._mod = later(500);
  const m3 = store.mergeStates(s3, d3).state;
  check("cancellation survives a later offline edit", m3.appointments[0].status === "cancelled");
  check("history union keeps both actions", m3.appointments[0].history.length >= 2);
}

// ---- merging identical states is a no-op ----
{
  const r = store.mergeStates(clone(base), clone(base));
  check("identical states merge without conflicts", r.conflicts.length === 0, JSON.stringify(r.conflicts));
}

store.resetAll();
const total = passed + failures.length;
console.log(`\nTheraChart merge checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
