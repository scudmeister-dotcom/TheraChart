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

/* The shipped commercial defaults, read ONCE before any fixture below calls
   updateSettings. The rate-consistency check at the bottom used to read
   store.settings() live, by which point an earlier block had already set
   fairUseMinutesPerVisit to 10 for its own arithmetic — so it was quietly
   checking a fixture's pool against the published per-minute rate rather than
   the pair we actually sell. It passed by coincidence while those two numbers
   happened to divide out; it stopped the moment either moved. */
const SHIPPED = (() => {
  const s = store.settings();
  return {
    overagePerVisit: s.overagePerVisit,
    overagePerMinute: s.overagePerMinute,
    fairUseMinutesPerVisit: s.fairUseMinutesPerVisit,
  };
})();

/* Open a counting window that cannot see anything created before it.

   These blocks isolate themselves by date rather than by deleting, because the
   seed contains signed notes and signed clinical records are not deletable —
   correctly so. An earlier version opened the window a couple of hundred
   milliseconds in the PAST, which quietly swept in the last document of the
   previous block whenever the two ran close together: every figure came out one
   visit and ten pooled minutes high, and whether it failed depended on how fast
   the machine was that day. Wait a tick, then start counting from now. */
function freshWindow(byUser) {
  const until = Date.now() + 25;
  while (Date.now() < until) { /* a few ms, so prior writes are strictly older */ }
  const from = new Date();
  /* One seeded note is dated LATER TODAY — a progress-report draft at 17:00 —
     so "everything after now" is not the same as "nothing". Left alone this
     file passed all morning and failed all afternoon. Clear what is inside the
     window; the draft is deletable, and anything that is not will still show up
     in the emptiness check the caller makes next. */
  if (byUser) {
    for (const d of store.documents()) {
      if (new Date(d.createdAt || 0) >= from) store.deleteDoc(d.id, byUser);
    }
  }
  return from;
}

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
check("each documented visit consumes exactly one visit, dictated or not",
  uu.visits === base4.visits + 3 && uu.excessMinutes === 0,
  `visits ${base4.visits} -> ${uu.visits}, excess minutes ${uu.excessMinutes}`);

/* Overage is quoted in the unit it was incurred in — minutes over the pool at
   a per-minute rate, never converted into fractional visits. */
say(10.02);
uu = store.monthUsage();
check("a hair over one visit's budget costs nothing while the pool covers it",
  uu.excessMinutes === 0 && uu.estimatedOverage === 0,
  `excess=${uu.excessMinutes}min overage=${uu.estimatedOverage}`);
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
check("unused minutes from short visits pay for a long one",
  pooled.visits - pre6.visits === 5 && pooled.excessMinutes === 0,
  `5 visits totalling 46 min against 50 pooled minutes must incur no overage, got ${pooled.excessMinutes} min over`);
check("…so nothing is 'lost' by finishing a note early",
  pooled.estimatedOverage === 0, `charged ${pooled.estimatedOverage} while the pool still covers it`);
check("the pool is the PLAN's, not what the visits so far have earned",
  pooled.includedMinutes === 450 * 10 && pooled.excessMinutes === 0,
  `included=${pooled.includedMinutes} after only ${pooled.visits} visits — should be the full 4500`);

/* ---- the pool is fixed, and nothing is reserved against it ----

   Two intuitions to disprove, and they pull in opposite directions:

     "9 minutes spare, I start an evaluation, so I am 1 minute overdrawn
      before anyone speaks."   — no: nothing is reserved when a note opens.
     "…so opening a note ADDS 10 minutes and leaves me better off."
                               — no longer true, and it should not be. The pool
                                 is the PLAN's and does not move as notes are
                                 written; a visit only ever spends.

   Sized so the allowance is not in play (10 visits against 20) — the
   max(allowance, visits) growth rule has its own block further down. */
{
  // reset first: earlier blocks in this file created documents moments ago,
  // and they would otherwise fall inside the window opened below
  store.resetAll();
  const g9 = store.getUser("u-grace"), m9 = store.getUser("u-maria");
  store.updateSettings({ visitAllowance: 20, fairUseMinutesPerVisit: 10 }, g9);
  const w = freshWindow(g9);
  const dictate = (min) => { const d = store.createDoc("p-juan", "daily", m9).doc;
    if (min) store.updateDocData(d.id, { _dictationSeconds: Math.round(min * 60) }, m9); return d; };
  for (let i = 0; i < 10; i++) dictate(18.1);         // 10 visits, 181 min, pool 200
  const before = store.monthUsage(w);
  check("the pool is the plan's 200 minutes however few visits have run",
    before.includedMinutes === 200 && before.visits === 10,
    `included=${before.includedMinutes} after ${before.visits} visits`);
  check("the window starts on exactly 19 spare minutes",
    before.spareMinutes === 19, `got ${before.spareMinutes}`);

  const ev = store.createDoc("p-liza", "eval", m9).doc;
  const opened = store.monthUsage(w);
  check("opening a note reserves nothing — the spare minutes do not move",
    opened.spareMinutes === 19 && opened.includedMinutes === 200,
    `spare ${before.spareMinutes} -> ${opened.spareMinutes}, pool ${opened.includedMinutes}`);
  check("…and it costs one visit and no minutes before anything is said",
    opened.visits === 11 && opened.excessMinutes === 0 && opened.estimatedOverage === 0,
    `visits=${opened.visits} excess=${opened.excessMinutes} overage=${opened.estimatedOverage}`);

  store.updateDocData(ev.id, { _dictationSeconds: 5 * 60 }, m9);
  const short = store.monthUsage(w);
  check("a 5-minute evaluation spends exactly 5",
    short.spareMinutes === 14,
    `19 - 5 = 14, got ${short.spareMinutes}`);
  check("…and still costs nothing in overage",
    short.estimatedOverage === 0, `charged ${short.estimatedOverage}`);

  store.updateDocData(ev.id, { _dictationSeconds: 25 * 60 }, m9);
  const long = store.monthUsage(w);
  check("a 25-minute evaluation overdraws the pool and bills the minutes",
    long.spareMinutes === -6 && long.excessMinutes === 6,
    `spare=${long.spareMinutes} excess=${long.excessMinutes}`);
  /* Quoted per MINUTE, because that is the meter that noticed. The visit
     count is inside its allowance, so nothing here is a visit overage — and
     since the two rates are now exactly consistent (P42 / 6 min = P7), the
     totals alone can no longer tell the two paths apart. Assert the unit. */
  check("…quoted in minutes at the per-minute rate, not converted to visits",
    long.estimatedOverage === 6 * long.overagePerMinute
    && long.overagePerMinute === SHIPPED.overagePerMinute
    && long.overBy === 0,
    `6 min x P${long.overagePerMinute} = P${6 * long.overagePerMinute}, got P${long.estimatedOverage} with ${long.overBy} visit(s) over`);
}

/* ---- the case accrual got wrong: fewer visits, longer notes ----

   A clinic on the 130-visit rung that does 40 long evaluations has bought
   1300 minutes and used 800 of them. Under the old per-visit accrual it had
   "earned" only 400 and was billed P1200 on top of a plan it was already
   underusing. It costs us LESS than a clinic burning the same pool across 130
   visits — same speech minutes, 90 fewer Gemini calls — so there was never
   anything to recover. */
{
  store.resetAll();
  const gA = store.getUser("u-grace"), mA = store.getUser("u-maria");
  store.updateSettings({ visitAllowance: 130, fairUseMinutesPerVisit: 10 }, gA);
  const wA = freshWindow(gA);
  for (let i = 0; i < 40; i++) {
    const d = store.createDoc("p-juan", "daily", mA).doc;
    store.updateDocData(d.id, { _dictationSeconds: 20 * 60 }, mA);
  }
  const lowVol = store.monthUsage(wA);
  check("40 long evaluations draw on the whole plan's pool, not on 40 visits' worth",
    lowVol.visits === 40 && lowVol.includedMinutes === 1300 && lowVol.minutesUsed === 800,
    `visits=${lowVol.visits} pool=${lowVol.includedMinutes} used=${lowVol.minutesUsed}`);
  check("…so a clinic well inside its visit allowance is charged nothing",
    lowVol.excessMinutes === 0 && lowVol.estimatedOverage === 0,
    `excess=${lowVol.excessMinutes} min, charged P${lowVol.estimatedOverage} (accrual billed P1200 here)`);
  check("…and it still has the balance of the pool to spend",
    lowVol.spareMinutes === 500, `got ${lowVol.spareMinutes}`);
}

/* ---- a visit past the allowance brings its minutes with it ----

   max(allowance, visits), not a frozen allowance. P28 is priced as a visit
   WITH its 10 minutes (P2.80/min, which is where the P3 rate comes from), so a
   pool that stayed at allowance x 10 would bill those minutes twice — once in
   the P28 and again at P3. */
{
  store.resetAll();
  const gB = store.getUser("u-grace"), mB = store.getUser("u-maria");
  store.updateSettings({ visitAllowance: 3, fairUseMinutesPerVisit: 10 }, gB);
  const wB = freshWindow(gB);
  const say = (min) => { const d = store.createDoc("p-juan", "daily", mB).doc;
    store.updateDocData(d.id, { _dictationSeconds: Math.round(min * 60) }, mB); };
  for (let i = 0; i < 3; i++) say(10);
  const atCap = store.monthUsage(wB);
  check("at the visit cap the pool is exactly the plan's",
    atCap.includedMinutes === 30 && atCap.excessMinutes === 0 && atCap.estimatedOverage === 0,
    `pool=${atCap.includedMinutes} excess=${atCap.excessMinutes} charged=${atCap.estimatedOverage}`);

  say(10);                                            // a 4th visit on a 3-visit plan
  const over = store.monthUsage(wB);
  check("the 4th visit grows the pool by its own 10 minutes",
    over.includedMinutes === 40 && over.minutesUsed === 40,
    `pool=${over.includedMinutes} used=${over.minutesUsed}`);
  check("…so it is billed as ONE extra visit and not as minutes as well",
    over.overBy === 1 && over.excessMinutes === 0
    && over.estimatedOverage === SHIPPED.overagePerVisit,
    `visits over=${over.overBy} minutes over=${over.excessMinutes} charged=P${over.estimatedOverage}`
    + ` (a frozen pool would double-bill: P${SHIPPED.overagePerVisit} + 10 x P${SHIPPED.overagePerMinute})`);

  say(25);                                            // a 5th, well past its own budget
  const both = store.monthUsage(wB);
  check("a 5th visit that also overruns bills on both meters, each in its own unit",
    both.overBy === 2 && both.excessMinutes === 15
    && both.estimatedOverage === 2 * SHIPPED.overagePerVisit + 15 * SHIPPED.overagePerMinute,
    `visits over=${both.overBy} minutes over=${both.excessMinutes} charged=P${both.estimatedOverage}`);
}

/* A month of TYPED notes leaves the pool untouched and costs nothing extra.
   Not a leak: an undictated visit is revenue at almost no cost (a Gemini call,
   ~P0.97, and no speech at all), so a clinic that types most of its notes has
   genuinely paid for dictation it never used — and the visit meter is what
   bounds it, which is the whole reason there are two meters and not one.
   Verified across the range — the tightest case (every visit at the ceiling)
   still clears 40%. */
{
  store.resetAll();
  const g7 = store.getUser("u-grace"), m7 = store.getUser("u-maria");
  store.updateSettings({ visitAllowance: 130, fairUseMinutesPerVisit: 10 }, g7);
  const w7 = freshWindow(g7);
  for (let i = 0; i < 12; i++) store.createDoc("p-juan", "daily", m7);   // typed, no audio
  const pre7 = store.monthUsage(w7);
  check("visits that were typed rather than dictated leave the pool whole",
    pre7.visits === 12 && pre7.minutesUsed === 0 && pre7.includedMinutes === 1300,
    `visits=${pre7.visits} used=${pre7.minutesUsed} pool=${pre7.includedMinutes}`);
  check("…and cost nothing extra on either meter",
    pre7.spareMinutes === 1300 && pre7.estimatedOverage === 0,
    `spare=${pre7.spareMinutes} charged=P${pre7.estimatedOverage}`);
}

/* Uniform-heavy is the case pooling must NOT discount — it is a concession on
   mixed months, never a loophole on consistently long ones. Isolated from the
   seed so the arithmetic is exact: with no banked minutes, three visits at
   three times the budget cost nine. */
store.resetAll();
const g8 = store.getUser("u-grace"), m8 = store.getUser("u-maria");
/* A 3-visit allowance so the pool is exactly the three visits' worth and the
   arithmetic below is the excess itself rather than a dent in a 4500-minute
   plan. Consistently-long months are what pooling must not discount. */
store.updateSettings({ visitAllowance: 3, fairUseMinutesPerVisit: 10 }, g8);
/* Isolated by WINDOW rather than by deleting: the seed contains signed notes,
   and signed clinical records are not deletable — correctly so. Counting from
   a moment just before these three visits excludes every seeded note. */
const cutoff = freshWindow(g8);
check("the window is isolated for the exact-arithmetic checks below",
  store.monthUsage(cutoff).visits === 0, `got ${store.monthUsage(cutoff).visits} leftover visits`);

for (let i = 0; i < 3; i++) { const d = store.createDoc("p-juan", "daily", m8).doc; store.updateDocData(d.id, { _dictationSeconds: 30 * 60 }, m8); }
const heavy3 = store.monthUsage(cutoff);
check("three visits all at 3x the budget bill the full excess, with no pool to draw on",
  heavy3.visits === 3 && heavy3.excessMinutes === 60
  && heavy3.estimatedOverage === 60 * SHIPPED.overagePerMinute,
  `3 x 30min against 30 pooled = 60 min over = P${60 * SHIPPED.overagePerMinute},`
  + ` got ${heavy3.excessMinutes} min / P${heavy3.estimatedOverage}`);
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
const LADDER = [["Solo", 3450, 130], ["Practice", 6700, 260], ["Clinic", 10900, 450], ["Group", 32900, 1450]];
const OVERAGE = 42;
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

/* The two overage rates have to agree with each other, or the same excess costs
   a different amount depending on which meter noticed it. P42 a visit over a
   6-minute budget is exactly P7 a minute, which is the published rate. */
{
  const s = SHIPPED;
  const impliedPerMinute = s.overagePerVisit / s.fairUseMinutesPerVisit;
  check("the per-minute and per-visit overage rates are consistent",
    Math.abs(s.overagePerMinute - impliedPerMinute) <= 0.5,
    `P${s.overagePerMinute}/min vs P${impliedPerMinute.toFixed(2)}/min implied by P${s.overagePerVisit} per ${s.fairUseMinutesPerVisit}-min visit`);
  /* And the visit rate has to clear the ENTRY plan's own per-visit rate, or a
     clinic is better off sitting on overage than moving up a rung. */
  check("an extra visit costs more than a visit inside the entry plan",
    s.overagePerVisit > LADDER[0][1] / LADDER[0][2],
    `P${s.overagePerVisit} overage vs P${(LADDER[0][1] / LADDER[0][2]).toFixed(2)} included on ${LADDER[0][0]}`);
  /* Both meters have to exist. Minutes alone would leave visit volume
     unbounded — a clinic typing 2,000 notes dictates zero minutes and still
     costs a Gemini call each — and visits alone was the gap that let dictation
     run a tier underwater. */
  /* The card shows whole minutes beside a peso total, and a clinic will
     multiply one by the rate to check the other. Pricing the unrounded figure
     and rounding the pesos gave P104 next to a displayed "35 min x P3". */
  {
    const g10 = store.getUser("u-grace"), m10 = store.getUser("u-maria");
    store.resetAll();
    store.updateSettings({ visitAllowance: 450, fairUseMinutesPerVisit: 10, overagePerMinute: 3 }, store.getUser("u-grace"));
    const w2 = freshWindow(store.getUser("u-grace"));
    const mm = store.getUser("u-maria");
    // 34.83 minutes of excess — deliberately not a whole number
    const d1 = store.createDoc("p-juan", "daily", mm).doc;
    store.updateDocData(d1.id, { _dictationSeconds: Math.round(44.83 * 60) }, mm);
    const r = store.monthUsage(w2);
    check("the displayed minutes and the charged pesos agree exactly",
      r.estimatedOverage === r.excessMinutes * r.overagePerMinute,
      `card shows ${r.excessMinutes} min x P${r.overagePerMinute} = P${r.excessMinutes * r.overagePerMinute}, charge says P${r.estimatedOverage}`);
  }

  check("both dimensions are metered, not just one",
    s.overagePerVisit > 0 && s.overagePerMinute > 0,
    "a minutes-only plan leaves typed-note volume uncharged; a visits-only plan leaves dictation length uncharged");
}

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
