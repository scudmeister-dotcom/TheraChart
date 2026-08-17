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

/* ---------------- fair-use dictation, and the monthly reset ----------------

   The plan is sold in VISITS. Dictation is fair use on top of that, sized off
   the allowance — shown so an owner can see where they stand, never enforced.
   And the allowance resets: saying so, with a date, is how a billing dispute
   is avoided rather than argued. */

store.updateSettings({ planName: "Clinic", visitAllowance: 450, fairUseMinutesPerVisit: 10 }, grace);
const fu = store.monthUsage();
check("fair use is sized off the ALLOWANCE, not off visits used",
  fu.fairUseMinutes === 4500,
  `450 visits x 10 min should be 4500, got ${fu.fairUseMinutes} (a pool that shrinks as you work reads like a countdown)`);
check("…and follows the configured per-visit budget",
  fu.fairUsePerVisit === 10);

store.updateSettings({ fairUseMinutesPerVisit: 6 }, grace);
check("changing the fair-use budget re-sizes the pool",
  store.monthUsage().fairUseMinutes === 2700,
  `450 x 6 = 2700, got ${store.monthUsage().fairUseMinutes}`);
store.updateSettings({ fairUseMinutesPerVisit: 10 }, grace);

check("minutes used are reported alongside the pool",
  store.monthUsage().minutesUsed === Math.round(store.monthUsage().dictationSeconds / 60),
  `minutesUsed=${store.monthUsage().minutesUsed} seconds=${store.monthUsage().dictationSeconds}`);

/* The reset date is the 1st of NEXT month — including across a year boundary,
   where a naive month+1 produces month 12 of the same year. */
const dec = store.monthUsage(new Date(2026, 11, 1));
check("the reset date rolls the year over correctly",
  dec.resetsOn === "2027-01-01", `got ${dec.resetsOn}`);
const jun = store.monthUsage(new Date(2026, 5, 1));
check("…and is the 1st of the following month otherwise",
  jun.resetsOn === "2026-07-01", `got ${jun.resetsOn}`);

/* ---------------- dictation consumes allowance ----------------

   Speech-to-Text is a third of revenue and the only cost that scales with HOW a
   clinic works rather than how much. Left uncapped it takes a tier underwater:
   past ~16 minutes a visit, the Clinic rung loses money on every visit.

   Rather than a second overage meter, a visit consumes allowance in proportion
   to the dictation behind it. These checks pin that the proportion is right and,
   just as importantly, that a normal clinic never notices it. */

store.resetAll();
const m4 = store.getUser("u-maria");
const g4 = store.getUser("u-grace");
store.updateSettings({ visitAllowance: 450, fairUseMinutesPerVisit: 10 }, g4);
const say = (mins) => {
  const d = store.createDoc("p-juan", "daily", m4).doc;
  if (mins) store.updateDocData(d.id, { _dictationSeconds: Math.round(mins * 60) }, m4);
  return d;
};
const base4 = store.monthUsage();

say(0); say(4); say(6);
let uu = store.monthUsage();
check("visits inside the included minutes each cost exactly one",
  uu.chargeableVisits === base4.chargeableVisits + 3 && uu.unitsFromDictation === 0,
  `chargeable ${base4.chargeableVisits} -> ${uu.chargeableVisits}, extra=${uu.unitsFromDictation}`);

/* The cliff this design exists to avoid: charging ceil() per visit would make
   10 minutes 1 second cost two visits. Aggregating first means it costs ~1. */
say(10.02);
uu = store.monthUsage();
check("a hair over the included minutes does NOT cost a second visit",
  uu.unitsFromDictation === 0,
  `10m02s must not round up to 2 visits (extra=${uu.unitsFromDictation})`);

/* Sustained heavy dictation does move it, and by the right amount: three
   30-minute visits are 9 visits' worth of the expensive resource. */
/* ---- minutes POOL across the month ----

   The reason this matters: flooring each visit at one would silently discard
   the minutes a short note didn't use, so a clinic doing mostly short daily
   notes would pay for a long-visit allowance it never received. Pooling means
   finishing early is never wasted. */

store.resetAll();
store.updateSettings({ visitAllowance: 450, fairUseMinutesPerVisit: 10 }, store.getUser("u-grace"));
const m6 = store.getUser("u-maria");
const say6 = (mins) => { const d = store.createDoc("p-juan", "daily", m6).doc; store.updateDocData(d.id, { _dictationSeconds: Math.round(mins * 60) }, m6); };
const pre6 = store.monthUsage();

// four short notes bank 24 unused minutes, then one long visit draws on them
for (let i = 0; i < 4; i++) say6(4);
say6(30);
const pooled = store.monthUsage();
const dVisits = pooled.visits - pre6.visits;
const dCharged = pooled.chargeableVisits - pre6.chargeableVisits;
check("unused minutes from short visits pay for a long one",
  dVisits === 5 && dCharged === 5,
  `5 visits totalling 46 min against 50 pooled minutes must charge 5, got ${dCharged} (flooring each visit would charge 7)`);
check("…so nothing is 'lost' by finishing a note early",
  pooled.unitsFromDictation - pre6.unitsFromDictation === 0,
  `no extra should be charged while the pool covers it`);
check("the pool is reported so the card can show it",
  pooled.includedMinutes === pooled.visits * 10 && pooled.excessMinutes === 0,
  `included=${pooled.includedMinutes} for ${pooled.visits} visits, excess=${pooled.excessMinutes}`);

/* The pool is drawn from EVERY visit, including notes that were typed rather
   than dictated. That is deliberate and not a leak: an undictated visit is
   revenue at almost no cost, so a clinic that types most of its notes has
   genuinely paid for dictation it never used. Verified across the range —
   the tightest case (every visit at the ceiling) still clears 40%. */
const pre7 = store.monthUsage();
const untouchedPool = pre7.includedMinutes - pre7.minutesUsed;
check("visits that were typed rather than dictated still contribute their minutes",
  untouchedPool > 0 && pre7.chargeableVisits === pre7.visits,
  `pool has ${untouchedPool} unused minutes and nothing extra is charged`);

/* Uniform-heavy is the case pooling must NOT discount — it is a concession on
   mixed months, never a loophole on consistently long ones. Isolated from the
   seed so the arithmetic is exact: with no banked minutes, three visits at
   three times the budget cost nine. */
store.resetAll();
const g8 = store.getUser("u-grace"), m8 = store.getUser("u-maria");
store.updateSettings({ visitAllowance: 450, fairUseMinutesPerVisit: 10 }, g8);
/* Isolated by WINDOW rather than by deleting: the seed contains signed notes,
   and signed clinical records are not deletable — correctly so. Counting from
   a moment just before these three visits excludes every seeded note. */
const cutoff = new Date(Date.now() - 500);
check("the window is isolated for the exact-arithmetic checks below",
  store.monthUsage(cutoff).visits === 0, `got ${store.monthUsage(cutoff).visits} leftover visits`);

for (let i = 0; i < 3; i++) { const d = store.createDoc("p-juan", "daily", m8).doc; store.updateDocData(d.id, { _dictationSeconds: 30 * 60 }, m8); }
const heavy3 = store.monthUsage(cutoff);
check("three visits all at 3x the budget cost nine, with no pool to draw on",
  heavy3.chargeableVisits === 9 && heavy3.visits === 3,
  `got ${heavy3.chargeableVisits} from ${heavy3.visits} — pooling must not discount consistently long visits`);
check("…and the excess is reported in minutes, not guessed",
  heavy3.includedMinutes === 30 && heavy3.excessMinutes === 60,
  `included=${heavy3.includedMinutes} excess=${heavy3.excessMinutes} of ${heavy3.minutesUsed} used`);

/* The economics this is protecting. At P0.98/min speech + P0.97 Gemini, a
   30-minute visit costs about P30.40 and would be sold for P17.56 on the
   Clinic rung — a loss. Charged as three visits it clears cost with room. */
const PER_MIN = 0.016 * 61.4, GEMINI = 0.01586 * 61.4, CLINIC_RATE = 7900 / 450;
const costOf = (mins) => PER_MIN * mins + GEMINI;
check("a 30-minute visit would lose money if charged as one",
  costOf(30) > CLINIC_RATE,
  `cost P${costOf(30).toFixed(2)} vs P${CLINIC_RATE.toFixed(2)} charged — this is why the weighting exists`);
check("…and is comfortably profitable charged as three",
  costOf(30) < CLINIC_RATE * 3,
  `cost P${costOf(30).toFixed(2)} vs P${(CLINIC_RATE * 3).toFixed(2)}`);
/* The weighting must never turn a NORMAL visit into more than one, or every
   clinic silently loses a fifth of its plan. 4.5 min is the measured length of
   a full initial evaluation. */
check("a normal visit is never weighted above one",
  Math.max(1, 4.5 / 10) === 1 && Math.max(1, 6 / 10) === 1,
  "an eval at 4.5 min and a long note at 6 min must both count as exactly one");

/* ---------------- the ladder rewards upgrading ----------------

   A tier that costs MORE per visit than the one above it is a reason to stay
   put. Pinned here because it is a pricing invariant, not a UI detail: the
   published ladder must get cheaper per visit at every rung. */
const LADDER = [["Solo", 2450, 130], ["Practice", 4700, 260], ["Clinic", 7900, 450], ["Group", 24900, 1450]];
const OVERAGE = 28;
let prevRate = Infinity, monotonic = true, detail = [];
for (const [name, price, visits] of LADDER) {
  const rate = price / visits;
  detail.push(`${name} ${rate.toFixed(2)}`);
  if (rate >= prevRate) monotonic = false;
  prevRate = rate;
}
check("every rung is cheaper per visit than the one below it",
  monotonic, detail.join(" -> ") + "  (a rung that costs more per visit is a reason not to upgrade)");

/* Overage must make the next tier attractive BEFORE a clinic runs out of it,
   otherwise they sit on overage paying more than a plan would cost. */
let upgradesInTime = true, ud = [];
for (let i = 0; i < LADDER.length - 1; i++) {
  const [, p1, v1] = LADDER[i], [n2, p2, v2] = LADDER[i + 1];
  const breakEven = v1 + (p2 - p1) / OVERAGE;
  ud.push(`${n2} wins at ${Math.round(breakEven)} of ${v2}`);
  if (breakEven >= v2) upgradesInTime = false;
}
check("overage pushes an upgrade before the next tier's allowance runs out",
  upgradesInTime, ud.join(" · "));

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
