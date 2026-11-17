/* TheraChart visit-billing checker — therapists log time, the manager bills.

   Asked for on 2026-11-13: no codes or prices on a note; the therapist logs
   time with the patient, and an administrator with billing access enters the
   service codes on the Visit time page. The codes live in doc.billing, beside
   the clinical record, so a signed note can be billed without reopening it.
   Both halves are pinned, because a device pushes its whole state as JSON:

     - store.js lets only a billing-access admin set a visit's codes, on a
       draft or a signed note, and never touches the note's own data
     - the server keeps the saved billing when anyone else pushes a change

   Run: node test/visitbilling.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const r = reporter("visit-billing checker");

  /* ---------------- store rules ---------------- */
  const S = require("../store.js");
  S.load();
  const maria = S.getUser("u-maria"), grace = S.getUser("u-grace");
  const signed = S.documents().find((d) => d.status === "signed");
  const before = JSON.stringify(signed.data);

  r.check("a therapist cannot bill a visit", !!S.setVisitCharges(signed.id, [{ code: "PT02", units: 1 }], maria).error);
  r.check("the admin with billing access can", S.canSetPrices(grace));
  const res = S.setVisitCharges(signed.id, [{ code: "pt02", units: "2", price: 850 }, { code: "", units: 1 }, { code: "PT05", units: 120 }], grace);
  r.check("a signed note can be billed without reopening it", !res.error, JSON.stringify(res.error));
  const d = S.getDoc(signed.id);
  r.check("the note stays signed", d.status === "signed");
  r.check("the note's own record is untouched", JSON.stringify(d.data) === before);
  r.check("codes are cleaned: upper-cased, blanks dropped, units capped",
    JSON.stringify(d.billing.charges.map((c) => [c.code, c.units])) === JSON.stringify([["PT02", 2], ["PT05", 99]]),
    JSON.stringify(d.billing.charges));
  r.check("the price stamped on the line is kept", d.billing.charges[0].price === 850);
  r.check("who billed it, and when, is recorded", d.billing.by === "u-grace" && !!d.billing.at);
  r.check("visitCharges reads the billing", S.visitCharges(d).length === 2);
  r.check("an older note's own codes are read until it is billed here",
    S.visitCharges({ data: { charges: [{ code: "PT02", units: 1 }] } }).length === 1);
  const revoked = { ...grace, billingAccess: false };
  r.check("an admin without billing access cannot bill", !!S.setVisitCharges(signed.id, [], revoked).error);

  /* ---------------- server rules ---------------- */
  const srv = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  try {
    const mToken = (await srv.demoSignIn("u-maria")).data.token;
    const gToken = (await srv.demoSignIn("u-grace")).data.token;
    const stateOf = async (token) => (await srv.call("/api/state", { token })).data;

    // the manager bills a signed visit through an ordinary push
    const cur = await stateOf(gToken);
    const target = cur.state.documents.find((x) => x.status === "signed");
    const billed = JSON.parse(JSON.stringify(cur.state));
    billed.documents.find((x) => x.id === target.id).billing = { charges: [{ code: "PT02", units: 1, price: 900 }], by: "u-grace", at: new Date().toISOString() };
    const put = await srv.call("/api/state", { method: "PUT", token: gToken, body: { baseRev: cur.rev, state: billed } });
    r.check("the manager's push is accepted", put.status === 200, `-> ${put.status}`);
    const after = await stateOf(mToken);
    const saved = after.state.documents.find((x) => x.id === target.id);
    r.check("the manager's billing is saved on a signed note", saved.billing && saved.billing.charges[0].price === 900);
    r.check("…and the note is still signed", saved.status === "signed");

    // a therapist's device pushes a changed bill, and a bill on another visit
    const sneaky = JSON.parse(JSON.stringify(after.state));
    sneaky.documents.find((x) => x.id === target.id).billing.charges[0].price = 1;
    const other = sneaky.documents.find((x) => x.id !== target.id);
    other.billing = { charges: [{ code: "PT05", units: 9 }], by: "u-maria", at: new Date().toISOString() };
    await srv.call("/api/state", { method: "PUT", token: mToken, body: { baseRev: after.rev, state: sneaky } });
    const final = await stateOf(gToken);
    r.check("a therapist's push cannot change a bill", final.state.documents.find((x) => x.id === target.id).billing.charges[0].price === 900);
    r.check("…or bill a visit", !final.state.documents.find((x) => x.id === other.id).billing);

    // and cannot erase one by leaving it out
    const wipe = JSON.parse(JSON.stringify(final.state));
    delete wipe.documents.find((x) => x.id === target.id).billing;
    await srv.call("/api/state", { method: "PUT", token: mToken, body: { baseRev: final.rev, state: wipe } });
    r.check("…or erase one", !!(await stateOf(gToken)).state.documents.find((x) => x.id === target.id).billing);
  } finally {
    srv.stop();
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
