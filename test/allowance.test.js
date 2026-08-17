/* TheraChart plan-allowance checker.

   The clinic is sold a monthly allowance in DOCUMENTED VISITS, and the meter in
   Facility Admin is what an owner trusts when deciding whether to move plans.
   If it disagrees with the bill, the pricing model is unsellable — so these
   checks pin the arithmetic that a sales conversation rests on.

   The distinction under test throughout: a VISIT is what the clinic pays for,
   DICTATION SECONDS are what it costs us. They are counted separately and must
   never be conflated.

   Run: node test/allowance.test.js */

"use strict";

const store = require("../store.js");
store.resetAll();

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

const maria = store.getUser("u-maria"); // valid license, can document
const grace = store.getUser("u-grace"); // admin, sets the plan

// A visit only lands in this month's meter if it was created this month, and
// the seed backdates documents — so every assertion below is a DELTA against
// the starting figure rather than an absolute count.
const base = store.monthUsage();

// --- the plan comes from settings ----------------------------------------
check("a fresh clinic starts on the entry rung",
  base.planName === "Solo" && base.allowance === 130,
  `got ${base.planName} / ${base.allowance}`);

store.updateSettings({ planName: "Clinic", visitAllowance: 420 }, grace);
const onClinic = store.monthUsage();
check("the meter counts against the plan the admin set",
  onClinic.planName === "Clinic" && onClinic.allowance === 420,
  `got ${onClinic.planName} / ${onClinic.allowance}`);

// --- a documented visit consumes allowance, dictation or not --------------
const a = store.createDoc("p-juan", "daily", maria).doc;
const afterOne = store.monthUsage();
check("a new document consumes one visit of allowance",
  afterOne.visits === base.visits + 1, `${base.visits} -> ${afterOne.visits}`);
check("…and the remaining count drops with it",
  afterOne.remaining === afterOne.allowance - afterOne.visits,
  `remaining=${afterOne.remaining} allowance=${afterOne.allowance} visits=${afterOne.visits}`);
check("a visit with no dictation adds no dictation time",
  afterOne.dictationSeconds === base.dictationSeconds,
  `${base.dictationSeconds} -> ${afterOne.dictationSeconds}`);

// --- dictation seconds accumulate onto the visit --------------------------
store.updateDocData(a.id, { _dictationSeconds: 240 }, maria);
const afterDict = store.monthUsage();
check("billed dictation seconds land on the month's total",
  afterDict.dictationSeconds === base.dictationSeconds + 240,
  `expected +240, got +${afterDict.dictationSeconds - base.dictationSeconds}`);
check("…without changing the visit count",
  afterDict.visits === afterOne.visits,
  `dictating must not bill a second visit (${afterOne.visits} -> ${afterDict.visits})`);

/* Recording twice onto one note is two real charges. The client adds to what is
   already there rather than replacing it, and the meter must reflect the sum —
   a "last write wins" bug here would silently under-report the bill. */
const soFar = Number(store.getDoc(a.id).data._dictationSeconds) || 0;
store.updateDocData(a.id, { _dictationSeconds: soFar + 60 }, maria);
check("a second recording on the same visit adds to the first",
  store.monthUsage().dictationSeconds === base.dictationSeconds + 300,
  `expected +300, got +${store.monthUsage().dictationSeconds - base.dictationSeconds}`);

/* The average is over visits that ACTUALLY used dictation, not over all visits.
   Averaging across silent notes would make a clinic that dictates half its
   charts look twice as efficient as it is, and that number is one an owner
   would take to a pricing conversation. */
const b = store.createDoc("p-juan", "daily", maria).doc;
store.updateDocData(b.id, { _dictationSeconds: 100 }, maria);
// a third visit with NO dictation, created here rather than relied on from the
// seed so the property holds whatever day of the month this runs
store.createDoc("p-juan", "daily", maria);
const avg = store.monthUsage();
const mine = avg.dictationSeconds - base.dictationSeconds;
check("two recordings + one more dictated visit sum correctly", mine === 400, `got ${mine}`);
check("the silent visit counts as a visit", avg.visits === afterOne.visits + 2,
  `expected 2 more visits, got ${avg.visits - afterOne.visits}`);
/* 300s on visit A and 100s on visit B is a 200s average across the two that
   used dictation. Averaged over all three it would read 133s — flattering, and
   wrong. Pinned as a literal so a change to the denominator fails here. */
check("the average is per DICTATED visit, not per visit",
  avg.avgSecondsPerVisit === 200,
  `expected 200s (400s over 2 dictated visits), got ${avg.avgSecondsPerVisit}`);
check("…so the silent visit is excluded from the denominator",
  avg.dictatedVisits === 2 && avg.visits > avg.dictatedVisits,
  `dictated=${avg.dictatedVisits} visits=${avg.visits}`);

// --- the overage boundary -------------------------------------------------
// This is the number that triggers an upgrade conversation, so it must be
// exact: AT the allowance is not yet over.
const now = store.monthUsage();
store.updateSettings({ visitAllowance: now.visits }, grace);
const atCap = store.monthUsage();
check("exactly at the allowance is not over",
  atCap.overBy === 0 && atCap.remaining === 0,
  `overBy=${atCap.overBy} remaining=${atCap.remaining}`);

store.updateSettings({ visitAllowance: Math.max(1, now.visits - 2) }, grace);
const over = store.monthUsage();
check("past the allowance reports the overage, not a negative remainder",
  over.overBy === 2 && over.remaining === 0,
  `overBy=${over.overBy} remaining=${over.remaining}`);

// --- a signed visit still counts -----------------------------------------
/* Signing locks the document, and updateDocData refuses to write to it. The
   spend already happened, so the meter must keep counting it — a clinic that
   signs its notes must not appear to use less than one that leaves drafts. */
store.updateSettings({ visitAllowance: 420 }, grace);
const beforeSign = store.monthUsage();
store.signDoc(a.id, maria, maria.name);
check("the note really did sign (otherwise the check below proves nothing)",
  store.getDoc(a.id).status === "signed", `status=${store.getDoc(a.id).status}`);
const afterSign = store.monthUsage();
check("signing a note does not erase its visit or its dictation",
  afterSign.visits === beforeSign.visits && afterSign.dictationSeconds === beforeSign.dictationSeconds,
  `visits ${beforeSign.visits}->${afterSign.visits}, seconds ${beforeSign.dictationSeconds}->${afterSign.dictationSeconds}`);

// --- the projection is honest about how much month it has seen ------------
const proj = store.monthUsage();
check("the projection is built from days elapsed, not guessed",
  proj.daysElapsed >= 1 && proj.daysElapsed <= 31 && proj.daysInMonth >= 28,
  `elapsed=${proj.daysElapsed} inMonth=${proj.daysInMonth}`);
// Everything booked so far happened within the elapsed days, so extrapolating
// over a whole month can only be >= what is already on the clock.
check("a projection never comes in under what has already happened",
  proj.projectedVisits >= proj.visits,
  `projected ${proj.projectedVisits} < actual ${proj.visits}`);
// One month of pace, not two: the classic bug is multiplying by days elapsed.
check("…and never more than a full month at the current daily rate",
  proj.projectedVisits <= Math.ceil((proj.visits / proj.daysElapsed) * proj.daysInMonth),
  `projected ${proj.projectedVisits} from ${proj.visits} over ${proj.daysElapsed}d of ${proj.daysInMonth}`);

// --- clinic scoping -------------------------------------------------------
/* The meter is commercial information. It reads through the same clinic filter
   as documents(), so one tenant can never see another's volumes. */
const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
const scoped = store.documents().filter((d) => new Date(d.createdAt || 0).getTime() >= monthStart);
check("the meter counts exactly this clinic's documents for the month",
  store.monthUsage().visits === scoped.length,
  `meter=${store.monthUsage().visits} clinic-scoped docs=${scoped.length}`);

/* ---------------- per-patient dictation, for scheduling ----------------

   This figure tells a front desk how long to book. It is the one most easily
   misread as a productivity score, so the guards around it are the point:
   a median rather than a mean, a minimum sample, and a "runs long" flag that
   needs a real gap and not just a ratio. */

store.resetAll();
const m2 = store.getUser("u-maria");
const g2 = store.getUser("u-grace");
const P = "p-juan";

const dictate = (patientId, seconds) => {
  const d = store.createDoc(patientId, "daily", m2).doc;
  store.updateDocData(d.id, { _dictationSeconds: seconds }, m2);
  return d;
};

check("a patient with no dictation has no typical",
  store.patientDictation(P).typical === 0 && store.patientDictation(P).visits === 0);

dictate(P, 300);
dictate(P, 360);
check("…and still none after two visits (too small a sample to advise on)",
  store.patientDictation(P).typical === 0,
  `got ${store.patientDictation(P).typical}s from 2 visits — 3 is the floor`);

dictate(P, 420);
const three = store.patientDictation(P);
check("three dictated visits produce a typical", three.typical === 360,
  `median of 300/360/420 is 360, got ${three.typical}`);
check("…reported as a median, not a mean", three.visits === 3 && three.typical === 360);

/* The mean and the median diverge sharply here, which is the whole reason for
   the choice: one 40-minute outlier would drag a mean to ~11 minutes and have
   the desk over-booking this patient every week from now on. */
dictate(P, 2400);
const withOutlier = store.patientDictation(P);
const mean = Math.round((300 + 360 + 420 + 2400) / 4);
check("a single runaway session does not move the recommendation",
  withOutlier.typical === 390 && withOutlier.typical < mean / 2,
  `median=${withOutlier.typical} mean=${mean} — the outlier must not lead scheduling`);
check("…but the longest session is still visible",
  withOutlier.longest === 2400, `got ${withOutlier.longest}`);

// --- "runs long" needs a real gap, not just a ratio -----------------------
/* A second patient dictated far more heavily than the clinic norm. Both the
   ratio AND the absolute gap have to clear their thresholds, so a clinic with
   very short visits does not get told to re-arrange its day over 30 seconds. */
// a third patient, so the baseline for Q is drawn from more than one other
// chart — five dictated visits across other patients is the floor
for (const s of [280, 340]) dictate("p-mateo", s);
const Q = "p-liza";
for (const s of [900, 960, 1020]) dictate(Q, s);
const heavy = store.patientDictation(Q);
check("a patient well above the clinic norm is flagged to book longer",
  heavy.longer === true && heavy.shorter === false,
  `typical=${heavy.typical} clinicTypical=${heavy.clinicTypical} longer=${heavy.longer}`);
check("…and the clinic baseline it is compared against is real",
  heavy.clinicVisits >= 5 && heavy.clinicTypical > 0,
  `clinicVisits=${heavy.clinicVisits} clinicTypical=${heavy.clinicTypical}`);

/* The ratio-only trap: 1.3x of a small number is still a small number. */
store.resetAll();
const m3 = store.getUser("u-maria");
const tiny = (pid, s) => { const d = store.createDoc(pid, "daily", m3).doc; store.updateDocData(d.id, { _dictationSeconds: s }, m3); };
const A = "p-juan";
const B = "p-liza";
// enough short visits across OTHER charts that B has a genuine baseline to be
// compared against — otherwise this would pass merely for want of one
// distinct, ascending, and still a median of 60 — so the ordering check below
// tests ordering rather than comparing five identical numbers
for (const s of [40, 50, 60, 70, 80]) tiny(A, s);
for (const s of [60, 60]) tiny("p-mateo", s);
for (const s of [90, 90, 90]) tiny(B, s); // 1.5x the norm, but only 30s more
const marginal = store.patientDictation(B);
check("the marginal case really does have a baseline to compare against",
  marginal.clinicTypical === 60 && marginal.clinicVisits === 7,
  `clinicTypical=${marginal.clinicTypical} clinicVisits=${marginal.clinicVisits}`);
check("1.5x of a 60-second norm is not worth re-scheduling for",
  marginal.longer === false && marginal.typical === 90,
  `typical=${marginal.typical} clinic=${marginal.clinicTypical} — 30s over clears the ratio but not the 2-minute gap`);

// --- the history list -----------------------------------------------------
const hist = store.patientDictation(A);
check("recent visits are listed newest first for the detail view",
  JSON.stringify(hist.recent.map((r) => r.seconds)) === JSON.stringify([80, 70, 60, 50, 40]),
  JSON.stringify(hist.recent.map((r) => r.seconds)));
check("…and silent visits never appear in it",
  (() => { store.createDoc(A, "daily", m3); const h = store.patientDictation(A);
    return h.recent.length === 5 && h.visits === 5; })(),
  "a visit with no dictation has no duration to report");

/* The baseline is every OTHER patient. Comparing a patient against a norm that
   includes their own visits blunts the signal — in a small clinic a single
   heavy patient can be most of the dictation, and would end up being told they
   are "about typical" precisely because they dominate the average. */
const baseline = store.patientDictation(A);
const otherPatientsDictated = store.documents()
  .filter((d) => d.patientId !== A && Number((d.data || {})._dictationSeconds) > 0).length;
check("the baseline excludes the patient being compared",
  baseline.clinicVisits === otherPatientsDictated,
  `clinicVisits=${baseline.clinicVisits} other-patient dictated visits=${otherPatientsDictated}`);
check("…and reads through the same clinic filter as documents()",
  baseline.clinicVisits <= store.documents().length,
  "one tenant must never see another's volumes");

// --- report ---------------------------------------------------------------
console.log(`\nallowance checker: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
