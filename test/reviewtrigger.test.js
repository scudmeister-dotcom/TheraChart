/* TheraChart chart-review trigger checker — when the most expensive call in
   the product is allowed to fire.

   The AI chart review runs Gemini at thinkingLevel "high" over the whole
   episode of care. At the 2027 list rate it is ~P4.88 a run, which is 55% of
   what a documented visit costs us — more than the dictation, more than the
   note clean-up, more than everything else put together.

   It used to be keyed on every document's modification stamp, drafts
   included. A draft autosaves on each keystroke, so typing one sentence and
   then glancing at the Overview tab paid for a whole chart review; doing that
   two or three times in a visit paid for it two or three times, for one visit.

   So the trigger is a cost control, and this file is what keeps it one. It
   asserts the key changes for things that are actually part of the record —
   a note signed, amended, removed, a patient fact corrected — and does NOT
   change while a draft is being written.

   Run: node test/reviewtrigger.test.js */

"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function lift(decl) {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`app.js no longer contains: ${decl}`);
  const end = SRC.indexOf("\n  }\n", start);
  if (end < 0) throw new Error(`could not find the end of: ${decl}`);
  return SRC.slice(start, end + 5);
}

/* A stand-in store holding one patient's documents. chartReviewKey reads
   S.docsFor() and S.patientPrecautions(); reviewMissesDraft reads the first
   alone. patientPrecautions mirrors the real one, including the fallback to
   the pre-rename `allergies` key. */
let DOCS = [];
const S = {
  docsFor: () => DOCS,
  patientPrecautions: (p) =>
    String((p && (p.precautions != null ? p.precautions : p.allergies)) || "").trim(),
};

const M = new Function("S",
  lift("  function chartReviewKey(") + "\n" +
  lift("  function reviewMissesDraft(") +
  "\n  return { chartReviewKey, reviewMissesDraft };")(S);

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
};

const PATIENT = { id: "p1", dob: "1980-04-02", sex: "F", referringPhysician: "Dr Cruz", pmh: "HTN", precautions: "" };
const doc = (over) => Object.assign({
  id: "d1", type: "daily", status: "draft",
  createdAt: "2026-08-20T01:00:00.000Z", _mod: "2026-08-20T01:00:00.000Z",
}, over);

const keyNow = () => M.chartReviewKey(PATIENT);

/* ---- the whole point: a draft being written must not re-run it ---- */
{
  DOCS = [doc({ id: "d-signed", status: "signed", _mod: "2026-08-19T09:00:00.000Z" }),
          doc({ id: "d-draft", status: "draft", _mod: "2026-08-20T01:00:00.000Z" })];
  const before = keyNow();

  // the therapist types — autosave rewrites the draft's stamp
  DOCS[1]._mod = "2026-08-20T01:00:07.000Z";
  check("typing in a draft does not re-run the review", keyNow() === before, keyNow());

  // …and keeps typing, for the length of a visit
  DOCS[1]._mod = "2026-08-20T01:22:41.000Z";
  check("…however long they type for", keyNow() === before, keyNow());

  // a SECOND draft started (a different patient's visit filed here by mistake,
  // or simply a note begun and abandoned) is still not part of the record
  DOCS.push(doc({ id: "d-draft-2", status: "draft", _mod: "2026-08-20T02:00:00.000Z" }));
  check("starting another draft does not re-run it either", keyNow() === before, keyNow());
}

/* ---- and the things that must ---- */
{
  DOCS = [doc({ id: "d-signed", status: "signed", _mod: "2026-08-19T09:00:00.000Z" }),
          doc({ id: "d-draft", status: "draft", _mod: "2026-08-20T01:00:00.000Z" })];
  const before = keyNow();

  // signing is the moment a visit becomes part of the record
  DOCS[1].status = "signed";
  DOCS[1]._mod = "2026-08-20T03:00:00.000Z";
  check("signing a note DOES re-run the review", keyNow() !== before, "key did not change");

  // an amendment changes a signed record
  const afterSign = keyNow();
  DOCS[1]._mod = "2026-08-21T08:00:00.000Z";
  check("amending a signed note DOES re-run it", keyNow() !== afterSign, "key did not change");

  // a document leaving the chart changes what there is to review
  const afterAmend = keyNow();
  DOCS.splice(1, 1);
  check("removing a signed note DOES re-run it", keyNow() !== afterAmend, "key did not change");

  // patient facts reach the prompt, so correcting one has to re-run
  const afterDelete = keyNow();
  PATIENT.pmh = "HTN, T2DM";
  check("correcting the past medical history DOES re-run it", keyNow() !== afterDelete, "key did not change");
  PATIENT.pmh = "HTN";
}

/* ---- an empty chart is not a chart ---- */
{
  DOCS = [];
  const empty = keyNow();
  DOCS = [doc({ id: "d-draft", status: "draft" })];
  check("a chart with nothing signed yet has nothing to review",
    keyNow() === empty, `${keyNow()} vs ${empty}`);
}

/* ---- the honest cost of not re-running on every keystroke ----
   The review is right about the record and does not know about today's work.
   Nothing can infer that from the key, so it is stated on the card instead. */
{
  const ranAt = "2026-08-20T02:00:00.000Z";
  const P = { id: "p1", aiReview: { ranAt } };

  DOCS = [doc({ id: "d-signed", status: "signed", _mod: "2026-08-19T09:00:00.000Z" })];
  check("nothing unsigned means nothing missing", M.reviewMissesDraft(P) === false);

  DOCS.push(doc({ id: "d-draft", status: "draft", _mod: "2026-08-20T01:00:00.000Z" }));
  check("a draft written BEFORE the review ran is already in it",
    M.reviewMissesDraft(P) === false);

  DOCS[1]._mod = "2026-08-20T02:30:00.000Z";
  check("a draft written SINCE the review ran is flagged as missing",
    M.reviewMissesDraft(P) === true);

  check("a chart never reviewed claims nothing about what it is missing",
    M.reviewMissesDraft({ id: "p1" }) === false);
}

const total = passed + failures.length;
console.log(`\nTheraChart chart-review trigger checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
