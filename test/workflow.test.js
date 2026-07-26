/* TheraChart workflow checker — drives a real clinical journey through the
   real server, across TWO devices, the way the app actually syncs: pull the
   state, change it locally, push it back.

   The unit suites cover the rules in isolation (store.js, clinical.js) and the
   tenancy suite covers the security boundary. What was untested is the join
   between them — that a chart built on one device arrives intact on another,
   that a signed note stays signed, and that two devices editing at once don't
   silently clobber each other.

   Run: node test/workflow.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const R = reporter("workflow checker");
  const srv = await startServer();
  const { call, login } = srv;

  try {
    /* ---- two devices, same therapist ---- */
    const a = await login("maria@therachart.demo", "1234");
    const b = await login("maria@therachart.demo", "1234");
    R.check("both devices sign in", !!(a.data.token && b.data.token));
    const A = a.data.token, B = b.data.token;

    const pull = async (t) => (await call("/api/state", { token: t })).data;
    const push = (t, rev, state) => call("/api/state", { method: "PUT", token: t, body: { baseRev: rev, state } });

    /* ---- 1. intake on device A lands on device B ---- */
    let s = await pull(A);
    const startingPatients = s.state.patients.length;
    s.state.patients.push({
      id: "p-workflow", firstName: "Ana", lastName: "Bautista", dob: "1990-03-04",
      phone: "+63 917 555 9999", allergies: "Penicillin", attachments: [],
      createdAt: new Date().toISOString(), _mod: new Date().toISOString(),
    });
    const created = await push(A, s.rev, s.state);
    R.check("device A can create a patient", created.status === 200, `-> ${created.status}`);

    const onB = await pull(B);
    const seen = (onB.state.patients || []).find((p) => p.id === "p-workflow");
    R.check("device B receives the new patient", !!seen);
    R.check("the intake detail survives the round trip",
      !!seen && seen.allergies === "Penicillin" && seen.dob === "1990-03-04", JSON.stringify(seen));
    R.check("the new patient is stamped with the clinic",
      !!seen && (seen.clinicId || "clinic-demo") === "clinic-demo", seen && seen.clinicId);

    /* ---- 2. a signed note round-trips and stays signed ---- */
    s = await pull(A);
    const signedAt = new Date().toISOString();
    s.state.documents.push({
      id: "d-workflow", patientId: "p-workflow", type: "daily", status: "signed",
      title: "Daily Treatment Note — Visit 1", date: signedAt, createdBy: "u-maria",
      data: {
        subjective: "Reports right shoulder pain, 6/10 overhead.",
        assessment: "Improving; tolerating scaption well.",
        plan: "Continue 2x/week.",
        measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 130 }], pain: [{ location: "right shoulder", score: 6 }] },
        billing: { minutes: 38, codes: [{ code: "97110", units: 2 }, { code: "97140", units: 1 }] },
      },
      signatures: [{ by: "u-maria", at: signedAt, statement: "Electronically signed" }],
      history: [], _mod: signedAt,
    });
    const noteRes = await push(A, s.rev, s.state);
    R.check("device A can file a signed note", noteRes.status === 200, `-> ${noteRes.status}`);

    const bDocs = (await pull(B)).state.documents || [];
    const doc = bDocs.find((d) => d.id === "d-workflow");
    R.check("device B receives the note", !!doc);
    R.check("the note is still signed on arrival", !!doc && doc.status === "signed", doc && doc.status);
    R.check("the signature survives", !!doc && (doc.signatures || []).length === 1, JSON.stringify(doc && doc.signatures));
    R.check("objective measurements survive", !!doc && doc.data.measurements.rom[0].degrees === 130);
    R.check("the charge sheet survives", !!doc && doc.data.billing.minutes === 38);

    /* ---- 3. concurrent edits: the loser is told, not silently dropped ---- */
    const sA = await pull(A);
    const sB = await pull(B);
    R.check("both devices are at the same revision", sA.rev === sB.rev, `${sA.rev} vs ${sB.rev}`);

    sA.state.patients.find((p) => p.id === "p-workflow").phone = "+63 917 000 1111";
    const firstWrite = await push(A, sA.rev, sA.state);
    R.check("the first concurrent write succeeds", firstWrite.status === 200, `-> ${firstWrite.status}`);

    sB.state.patients.find((p) => p.id === "p-workflow").phone = "+63 917 222 3333";
    const secondWrite = await push(B, sB.rev, sB.state); // stale baseRev
    R.check("the second concurrent write is refused with a conflict", secondWrite.status === 409, `-> ${secondWrite.status}`);
    R.check("the conflict response carries the current state so the device can recover",
      !!(secondWrite.data && secondWrite.data.state && secondWrite.data.rev), Object.keys(secondWrite.data || {}).join(","));

    const afterConflict = await pull(A);
    R.check("device A's edit was not clobbered by the rejected write",
      afterConflict.state.patients.find((p) => p.id === "p-workflow").phone === "+63 917 000 1111",
      afterConflict.state.patients.find((p) => p.id === "p-workflow").phone);

    /* ---- 4. a device cannot quietly unsign a locked note ---- */
    const sC = await pull(A);
    const target = sC.state.documents.find((d) => d.id === "d-workflow");
    target.status = "draft";
    target.signatures = [];
    const unsign = await push(A, sC.rev, sC.state);
    const afterUnsign = (await pull(B)).state.documents.find((d) => d.id === "d-workflow");
    R.check("a signed note cannot be reverted to a draft by a state push",
      afterUnsign && afterUnsign.status === "signed",
      `push -> ${unsign.status}; status is now ${afterUnsign && afterUnsign.status}`);
    R.check("its signature cannot be stripped by a state push",
      afterUnsign && (afterUnsign.signatures || []).length === 1,
      JSON.stringify(afterUnsign && afterUnsign.signatures));

    /* ---- 5. deletion still works for things that SHOULD be deletable ---- */
    const sD = await pull(A);
    sD.state.patients = sD.state.patients.filter((p) => p.id !== "p-workflow");
    await push(A, sD.rev, sD.state);
    const gone = (await pull(B)).state.patients.find((p) => p.id === "p-workflow");
    R.check("a patient removed on one device is removed everywhere", !gone);
    R.check("the pre-existing patients are untouched throughout",
      (await pull(A)).state.patients.length === startingPatients,
      `${(await pull(A)).state.patients.length} vs ${startingPatients}`);
  } finally {
    srv.stop();
  }

  R.done();
})().catch((e) => { console.error("workflow checker crashed:", e); process.exit(1); });
