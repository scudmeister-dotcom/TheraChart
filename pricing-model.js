/* TheraChart unit economics — what a documented visit costs, and what we can
   therefore charge for one.

   Run: node pricing-model.js

   This is the companion to PRICING.md: the prose there explains the decisions,
   this file holds the arithmetic so a rate change or a new measurement is one
   edit rather than a rewrite. It is NOT served to the browser (server.js serves
   an allowlist, see isClientAsset) and is excluded from the deploy — commercial
   figures must not ship with the app.

   WHAT IS MEASURED AND WHAT IS NOT, because the distinction is the whole point
   of the metering work:

     MEASURED — provider list prices (dated, sourced in PRICING.md).
     MEASURED — prompt sizes, built from the real builders in ai.js/insights.js:
                refine 1,484 tokens on a 73-line transcript, insights 2,651 on a
                12-visit chart plus a digest of 20 older visits.
     MEASURED — ai.js's own live figures for thinking: ~2.3k tokens at "medium",
                "up to ~7k" at "high".
     ESTIMATED — answer tokens, where inside "up to 7k" the deep path lands, and
                how many dictation minutes a visit really takes. These are the
                three numbers /api/usage replaces with real ones after a week of
                live use, which is why every result here is a band, not a point.

   Nothing here is metered for egress or storage; see PRICING.md. */

"use strict";

const FX = 61.5;                     // PHP per USD, mid-August 2026
const php = (usd) => usd * FX;
const peso = (usd) => `₱${php(usd).toFixed(2)}`;

// ---------------- provider list prices ----------------

/* Speech-to-Text v2, standard tier. Chirp and Chirp 2 carry no premium on v2 —
   this is the same $0.016 the /api/usage read-time pricing applies. (Dynamic
   batch is $0.003/min but is documented as "within 24 hours", which fails the
   in-the-room requirement outright. Volume tiers fall to ~$0.004/min at 2M+
   minutes a month — about 4,000 seats away, so not modelled.) */
const STT_PER_MIN = 0.016;

/* Gemini 3.7 Flash. Thinking bills as output. */
const RATES = {
  intro: { in: 0.75, out: 3.75 },    // introductory, through 2026-12-31
  list:  { in: 1.50, out: 7.50 },    // from 2027-01-01 — price for THIS one
};

/* Per-call token profile. `in` is measured; `out` and `think` are the band.

   `assistant` and `extract` were missing from this model until 2026-08-21, and
   they are not small: both run at thinkingLevel "high" (ai.js:712, ai.js:822),
   the same deep path that makes `insights` the biggest line here. The assistant
   is a headline feature on the landing page — "ask its AI assistant anything
   about the patient" — so a model that costed only refine+insights was costing
   a product we do not sell. Their input sizes are taken from insights (both
   send a chart digest); their frequencies are the estimate, and they are the
   two frequencies /api/usage settles first, because it already meters every
   Gemini call regardless of which endpoint made it. */
const BANDS = {
  /* insights moved from thinkingLevel "high" to "medium" on 2026-08-21 after
     the eval scored 100% at both over three runs, so its `think` band is now
     the medium one (~2.3k) rather than the deep one (3.5k-7k). The assistant
     and extract-doc still run deep. */
  low:  { refine: { in: 1620, out: 1000, think: 1800 }, insights: { in: 2820, out: 700,  think: 1800 },
          assistant: { in: 2900, out: 400, think: 3500 }, extract: { in: 3200, out: 900,  think: 3500 } },
  base: { refine: { in: 1620, out: 1400, think: 2300 }, insights: { in: 2820, out: 1000, think: 2300 },
          assistant: { in: 2900, out: 600, think: 5000 }, extract: { in: 3200, out: 1300, think: 5000 } },
  high: { refine: { in: 1620, out: 1800, think: 2800 }, insights: { in: 2820, out: 1400, think: 2800 },
          assistant: { in: 2900, out: 900, think: 7000 }, extract: { in: 3200, out: 1800, think: 7000 } },
};
const call = (c, r) => (c.in * r.in + (c.out + c.think) * r.out) / 1e6;

/* One documented visit = dictation minutes + one refine + one insights re-run
   (the chart review re-runs when the chart changes, which a new note does). */
const VISIT_MIN = { eval: 6.0, daily: 2.5 };   // BILLED dictation minutes, i.e. voiced audio
const MIX = { eval: 1, daily: 8 };             // one evaluation per eight daily notes
const N = MIX.eval + MIX.daily;
const BLEND_MIN = (VISIT_MIN.eval * MIX.eval + VISIT_MIN.daily * MIX.daily) / N;

/* ESTIMATED, and flagged as such wherever a result depends on them. A question
   every third visit is a therapist who uses the assistant but does not live in
   it; one import per twenty visits is roughly "new patients arriving with
   outside records". */
const ASSISTANT_PER_VISIT = 1 / 3;
const EXTRACT_PER_VISIT = 1 / 20;

/* How many times the chart review actually runs per documented visit.

   This model always assumed 1, and the code did not honour that. Until
   2026-08-21 the review's cache key included every document's modification
   stamp, drafts included — and a draft autosaves on every keystroke. So the
   review re-ran whenever a therapist glanced at the Overview tab after typing,
   which is two or three times in an ordinary visit. The model was not wrong
   about the price of a run; it was wrong about the number of runs, which is
   the more expensive kind of wrong because nothing on the invoice says so.

   The trigger is now keyed on SIGNED documents, so it fires when a note is
   signed, amended or removed and not while one is being written. That is what
   makes 1.0 true rather than aspirational. RUNS_BEFORE is kept so the saving
   can be printed rather than asserted. */
const INSIGHTS_RUNS_PER_VISIT = 1.0;
const INSIGHTS_RUNS_BEFORE_FIX = 2.5;

/* Cost broken out by the feature the clinic actually sees, because "what is
   this costing me" is a question about features, not about endpoints. */
function visitLines(band, rate, opts) {
  opts = opts || {};
  const b = BANDS[band];
  const insightsShare = opts.insightsShare == null ? 1.0 : opts.insightsShare;
  return [
    { feature: "Listen & dictate live",       line: "Speech-to-Text v2",   usd: BLEND_MIN * STT_PER_MIN, meter: "dictation" },
    { feature: "Review & clean up with AI",   line: "Gemini refine",       usd: call(b.refine, rate),                        meter: "ai" },
    { feature: "Clinical insights card",      line: "Gemini insights",     usd: insightsShare * INSIGHTS_RUNS_PER_VISIT * call(b.insights, rate), meter: "ai" },
    { feature: "Grounded AI assistant",       line: "Gemini assistant",    usd: ASSISTANT_PER_VISIT * call(b.assistant, rate), meter: "ai" },
    { feature: "Import an outside document",  line: "Gemini extract-doc",  usd: EXTRACT_PER_VISIT * call(b.extract, rate),   meter: "ai" },
  ];
}

function perVisit(band, rate, insightsShare = 1.0) {
  const lines = visitLines(band, rate, { insightsShare });
  const stt = lines.filter((l) => l.meter === "dictation").reduce((a, l) => a + l.usd, 0);
  const gem = lines.filter((l) => l.meter === "ai").reduce((a, l) => a + l.usd, 0);
  return { stt, gem, total: stt + gem, lines };
}

/* Fixed stack, shared across tenants. Storage+egress is a guess and the one
   COGS line NOTHING meters: /api/usage covers Gemini and STT only. Egress was
   the largest line in the cost model before response compression landed
   (~9.5x on a 1,300-document clinic state) and still grows with chart history,
   because a device refetches the WHOLE clinic state on every revision bump. */
const INFRA = { cloudSql: 35, cloudRun: 15, storageEgress: 5 };
const INFRA_TOTAL = Object.values(INFRA).reduce((a, b) => a + b, 0);
const CLINICS_SHARING = 10;
const DAYS = 22;

// ---------------- report ----------------

console.log("=========== COST OF ONE DOCUMENTED VISIT ===========");
console.log(`(blended ${BLEND_MIN.toFixed(1)} billed dictation min: 1 eval @${VISIT_MIN.eval}min per ${MIX.daily} dailies @${VISIT_MIN.daily}min)\n`);
for (const [lbl, rate] of Object.entries(RATES)) {
  console.log(`  Gemini ${lbl} rate ($${rate.in}/$${rate.out} per 1M):`);
  for (const band of ["low", "base", "high"]) {
    const v = perVisit(band, rate);
    console.log(`    ${band.padEnd(4)}  dictation ${peso(v.stt)} + AI ${peso(v.gem)} = ${peso(v.total)}   (dictation ${(100 * v.stt / v.total).toFixed(0)}% of variable cost)`);
  }
}

console.log("\n=========== PER THERAPIST SEAT, PER MONTH (22 working days, 2027 rate) ===========");
for (const perDay of [6, 8, 12]) {
  const visits = perDay * DAYS;
  const lo = perVisit("low", RATES.list).total * visits;
  const hi = perVisit("high", RATES.list).total * visits;
  const base = perVisit("base", RATES.list).total * visits;
  console.log(`  ${String(perDay).padStart(2)}/day = ${visits} visits: ${peso(lo)}–${peso(hi)} (base ${peso(base)}) · ${(visits * BLEND_MIN).toFixed(0)} dictation min`);
}

const infraPerSeat = INFRA_TOTAL / CLINICS_SHARING / 3;   // $55 stack ÷ 10 clinics ÷ 3 seats
const seatCogs = perVisit("base", RATES.list).total * 8 * DAYS;
console.log(`\n=========== PRICE NEEDED PER SEAT, BY MARGIN TARGET (2027 rate, 8 visits/day) ===========`);
console.log(`  variable ${peso(seatCogs)} + infra share ${peso(infraPerSeat)} = COGS ${peso(seatCogs + infraPerSeat)}/seat/mo`);
for (const gm of [0.6, 0.7, 0.75, 0.8, 0.85]) {
  const price = (seatCogs + infraPerSeat) / (1 - gm);
  console.log(`    ${(gm * 100).toFixed(0)}% gross margin → ₱${Math.ceil(php(price) / 100) * 100}/seat/mo ($${price.toFixed(0)})`);
}

/* The two cuts, both testable rather than hopeful:
     1. insights thinkingLevel high -> medium. ai.js says explicitly not to do
        this without re-running the eval — which is exactly the point: there IS
        an eval (98.0% baseline, test/eval/baseline.vertex.json) to gate it on.
     2. stop re-running the chart review on every content change; run it on a
        new note and on demand. Modelled at 40% of visits. */
const tuned = (() => {
  const rate = RATES.list, b = BANDS.base;
  const insightsMedium = { in: b.insights.in, out: b.insights.out, think: 2300 };
  const stt = BLEND_MIN * STT_PER_MIN;
  const gem = call(b.refine, rate) + 0.4 * call(insightsMedium, rate);
  return { stt, gem, total: stt + gem };
})();
const baseVisit = perVisit("base", RATES.list).total;
console.log("\n=========== THE SAME, AFTER THE TWO COST CUTS ===========");
console.log(`  per visit: dictation ${peso(tuned.stt)} + AI ${peso(tuned.gem)} = ${peso(tuned.total)}  (was ${peso(baseVisit)}, −${(100 * (1 - tuned.total / baseVisit)).toFixed(0)}%)`);
console.log(`  dictation is now ${(100 * tuned.stt / tuned.total).toFixed(0)}% of variable cost`);
const seatCogsTuned = tuned.total * 8 * DAYS + infraPerSeat;
console.log(`  COGS ${peso(seatCogsTuned)}/seat/mo`);
for (const gm of [0.7, 0.75, 0.8, 0.85]) {
  console.log(`    ${(gm * 100).toFixed(0)}% gross margin → ₱${Math.ceil(php(seatCogsTuned / (1 - gm)) / 100) * 100}/seat/mo`);
}

/* ---------------------------------------------------------------------------
   THE LADDER WE ACTUALLY SELL.

   Until 2026-08-21 this file modelled a THREE-rung, per-seat ladder (Solo
   P3900/250, Clinic P9900/750, Group P17900/1600, P15 overage) that the
   product had already stopped selling. The shipped ladder is per CLINIC, has
   four rungs, and meters two things rather than one — visits AND a monthly
   dictation pool. Its numbers live in two places, and both are authoritative
   in their own way, so both are mirrored here and checked against each other
   at the bottom of this file:

     app.js  renderLanding()   the tiers a customer reads and buys
     store.js DEFAULT_SETTINGS  the allowance and overage rates the app meters

   If those two ever disagree, the clinic is billed something other than what
   it was sold, and this script fails loudly rather than printing a margin for
   a plan nobody is on. --------------------------------------------------- */

const PLANS = [
  { name: "Solo",     php: 3450,  visits: 130 },
  { name: "Practice", php: 6700,  visits: 260 },
  { name: "Clinic",   php: 10900, visits: 450 },
  { name: "Group",    php: 32900, visits: 1450 },
];
const OVERAGE_VISIT_PHP = 42;    // store.js overagePerVisit
const OVERAGE_MIN_PHP = 7;       // store.js overagePerMinute
const POOL_MIN_PER_VISIT = 6;    // store.js fairUseMinutesPerVisit

const introVisit = perVisit("base", RATES.intro).total;
const infraPerClinic = INFRA_TOTAL / CLINICS_SHARING;

/* Margin on a plan, given how many visits the clinic actually documents and
   how many dictation minutes it actually speaks. Dictation is separated from
   the rest because it is the only input a human moves in the moment, and the
   only one the plan hands out far more of than the model assumes. */
function planMargin(plan, visits, minutesPerVisit, rate) {
  const v = perVisit("base", rate);
  const aiCost = v.gem * visits;
  const sttCost = visits * minutesPerVisit * STT_PER_MIN;
  const cogs = aiCost + sttCost + infraPerClinic;
  const revenue = plan.php / FX;
  return { revenue, cogs, gm: 1 - cogs / revenue };
}

console.log("\n=========== WHAT ONE VISIT COSTS, BY FEATURE (2027 rate, base band) ===========");
{
  const lines = visitLines("base", RATES.list);
  const total = lines.reduce((a, l) => a + l.usd, 0);
  for (const l of lines) {
    console.log(`  ${l.feature.padEnd(26)} ${l.line.padEnd(18)} ${peso(l.usd).padStart(8)}  ${(100 * l.usd / total).toFixed(0).padStart(3)}%`);
  }
  console.log(`  ${"".padEnd(26)} ${"TOTAL".padEnd(18)} ${peso(total).padStart(8)}`);
  console.log(`  (assistant and import frequencies are ESTIMATED — see ASSISTANT_PER_VISIT)`);
}

console.log("\n=========== THE SHIPPED LADDER ===========");
console.log(`(per clinic, not per seat · overage P${OVERAGE_VISIT_PHP}/visit + P${OVERAGE_MIN_PHP}/dictation-min)`);
for (const p of PLANS) {
  const perVisitRevenue = p.php / p.visits;
  const typical = Math.round(p.visits * 0.75);
  const at = (visits, min, rate) => `${(100 * planMargin(p, visits, min, rate).gm).toFixed(0)}%`;
  console.log(`\n  ${p.name} — P${p.php}/mo · ${p.visits} visits included · P${perVisitRevenue.toFixed(2)}/visit`);
  console.log(`     dictation pool ${p.visits * POOL_MIN_PER_VISIT} min (${POOL_MIN_PER_VISIT}/visit) · modelled use ${BLEND_MIN.toFixed(1)}/visit`);
  console.log(`     75% of allowance (${typical} visits), ${BLEND_MIN.toFixed(1)} min/visit:  today ${at(typical, BLEND_MIN, RATES.intro)} · Jan-2027 ${at(typical, BLEND_MIN, RATES.list)}`);
  console.log(`     allowance maxed (${p.visits} visits), ${BLEND_MIN.toFixed(1)} min/visit:  today ${at(p.visits, BLEND_MIN, RATES.intro)} · Jan-2027 ${at(p.visits, BLEND_MIN, RATES.list)}`);
  console.log(`     allowance maxed AND pool maxed (${POOL_MIN_PER_VISIT} min/visit):  today ${at(p.visits, POOL_MIN_PER_VISIT, RATES.intro)} · Jan-2027 ${at(p.visits, POOL_MIN_PER_VISIT, RATES.list)}`);
}

/* The exposure the visit meter cannot see.

   A plan hands out 10 dictation minutes per visit and the cost model assumes
   2.9. That 3.4x gap reads like enormous headroom, and it is not, because the
   AI cost per visit is paid first out of the same per-visit revenue. What is
   left over after AI is all that dictation has to spend, and at the 2027 rate
   that is a much shorter runway than the ratio suggests. */
console.log("\n=========== HOW MUCH DICTATION EACH PLAN CAN ACTUALLY AFFORD ===========");
for (const rateName of ["intro", "list"]) {
  const rate = RATES[rateName];
  const v = perVisit("base", rate);
  console.log(`\n  Gemini ${rateName} rate — AI is ${peso(v.gem)} of every visit:`);
  for (const p of PLANS) {
    const revenuePerVisit = (p.php / p.visits) / FX;             // USD
    const infraPerVisit = infraPerClinic / p.visits;
    const leftForStt = revenuePerVisit - v.gem - infraPerVisit;
    const breakEvenMin = leftForStt / STT_PER_MIN;
    const at70 = (revenuePerVisit * 0.30 - v.gem - infraPerVisit) / STT_PER_MIN;
    console.log(`    ${p.name.padEnd(9)} break-even at ${breakEvenMin.toFixed(1).padStart(5)} min/visit` +
      `  ·  70% margin needs <= ${at70 < 0 ? "  n/a" : at70.toFixed(1).padStart(5)} min/visit` +
      `  ·  pool grants ${POOL_MIN_PER_VISIT}`);
  }
}
console.log(`\n  The pool is sized at ${POOL_MIN_PER_VISIT} min. Compare that to the break-even column, not to`);
console.log(`  the ${BLEND_MIN.toFixed(1)} min the model assumes: the headroom is the distance to break-even.`);

/* Overage rates, checked rather than asserted. */
console.log("\n=========== OVERAGE MARGINS ===========");
for (const rateName of ["intro", "list"]) {
  const v = perVisit("base", RATES[rateName]);
  const extraVisitCost = php(v.gem + POOL_MIN_PER_VISIT * STT_PER_MIN);  // P28 buys a visit WITH its 10 minutes
  const extraMinCost = php(STT_PER_MIN);
  console.log(`  ${rateName.padEnd(5)}  P${OVERAGE_VISIT_PHP}/visit costs us P${extraVisitCost.toFixed(2)} → ${(100 * (1 - extraVisitCost / OVERAGE_VISIT_PHP)).toFixed(0)}% margin` +
    `   ·   P${OVERAGE_MIN_PHP}/min costs us P${extraMinCost.toFixed(2)} → ${(100 * (1 - extraMinCost / OVERAGE_MIN_PHP)).toFixed(0)}% margin`);
}

/* What a free first month costs us, which is a question about ONE clinic on
   ONE plan, not about the fleet. Infra is excluded: Cloud Run scales to zero
   and Cloud SQL is already paid for whether or not this clinic exists, so a
   trial adds only its own variable cost. */
console.log("\n=========== COST OF FOOTING A ONE-MONTH TRIAL (one clinic, variable cost only) ===========");
for (const [label, visits] of [["a partner kicking the tyres", 30], ["a real solo month", 130], ["a busy solo month", 176], ["a 3-therapist clinic", 450]]) {
  for (const rateName of ["intro", "list"]) {
    const v = perVisit("base", RATES[rateName]);
    const modelled = visits * v.total;
    const poolMax = visits * (v.gem + POOL_MIN_PER_VISIT * STT_PER_MIN);
    if (rateName === "intro") process.stdout.write(`  ${label.padEnd(28)} ${String(visits).padStart(4)} visits: `);
    process.stdout.write(`${rateName} ${peso(modelled).padStart(9)} (worst case, pool maxed: ${peso(poolMax)})   `);
    if (rateName === "list") process.stdout.write("\n");
  }
}

/* ---------------------------------------------------------------------------
   WHAT THE RE-RUN FIX IS WORTH, and what a price would have to be.
   --------------------------------------------------------------------- */

console.log("\n=========== THE CHART-REVIEW RE-RUN, BEFORE AND AFTER ===========");
{
  const rate = RATES.list, b = BANDS.base;
  const one = call(b.insights, rate);
  const before = perVisit("base", rate).total + (INSIGHTS_RUNS_BEFORE_FIX - 1) * one;
  const after = perVisit("base", rate).total;
  console.log(`  a single chart review                       ${peso(one)}`);
  console.log(`  visit cost when it ran ~${INSIGHTS_RUNS_BEFORE_FIX}x (before the fix)   ${peso(before)}`);
  console.log(`  visit cost now it runs once                 ${peso(after)}   (-${(100 * (1 - after / before)).toFixed(0)}%)`);
  console.log(`  across a 450-visit month, that is           ${peso((before - after) * 450)} saved`);
}

/* The one remaining cut named in PRICING.md: insights at thinkingLevel
   "medium" rather than "high". ai.js says not to lower it without re-running
   the eval, and there IS an eval (98.0% baseline) to gate it on — so this is
   what it would be worth IF the score holds, not a decision already taken. */
console.log("\n=========== IF INSIGHTS DROPPED high -> medium (needs the eval to hold) ===========");
{
  const rate = RATES.list, b = BANDS.base;
  const medium = { in: b.insights.in, out: b.insights.out, think: 2300 };
  const saving = call(b.insights, rate) - call(medium, rate);
  const after = perVisit("base", rate).total - saving;
  console.log(`  insights ${peso(call(b.insights, rate))} -> ${peso(call(medium, rate))}   ·   visit ${peso(perVisit("base", rate).total)} -> ${peso(after)}`);
}

/* What each plan would have to cost for a target margin, at the entitlement
   the clinic was actually SOLD rather than at the usage we hope for. This is
   the table that decides a price: a plan is only healthy if it is healthy when
   the customer uses what they paid for. */
console.log("\n=========== PRICE FOR A TARGET MARGIN, AT FULL ENTITLEMENT (2027 rate) ===========");
for (const pool of [10, 6]) {
  console.log(`\n  with a ${pool}-minute dictation pool:`);
  console.log(`    plan       visits   cost/mo    60%      70%      75%      80%     (now)`);
  for (const p of PLANS) {
    const v = perVisit("base", RATES.list);
    const cogs = p.visits * (v.gem + pool * STT_PER_MIN) + infraPerClinic;
    const at = (gm) => `P${(Math.ceil(php(cogs / (1 - gm)) / 50) * 50).toLocaleString("en-US")}`;
    console.log(`    ${p.name.padEnd(9)} ${String(p.visits).padStart(5)}   ${("P" + php(cogs).toFixed(0)).padStart(7)}` +
      `  ${at(0.6).padStart(7)}  ${at(0.7).padStart(7)}  ${at(0.75).padStart(7)}  ${at(0.8).padStart(7)}   P${p.php.toLocaleString("en-US")}`);
  }
}

/* And the same question the other way round: keep the prices, fix the pool,
   and see where the margins land at both the expected and the sold usage. */
console.log("\n=========== KEEP THESE PRICES, CUT THE POOL TO 6 MIN ===========");
for (const p of PLANS) {
  const v = perVisit("base", RATES.list);
  const vi = perVisit("base", RATES.intro);
  const gm = (visits, min, vv) => {
    const cogs = visits * (vv.gem + min * STT_PER_MIN) + infraPerClinic;
    return `${(100 * (1 - cogs / (p.php / FX))).toFixed(0)}%`;
  };
  const typical = Math.round(p.visits * 0.75);
  console.log(`  ${p.name.padEnd(9)} P${String(p.php).padEnd(6)}` +
    ` · typical (${String(typical).padStart(4)} visits @2.9min) today ${gm(typical, BLEND_MIN, vi).padStart(4)} / Jan ${gm(typical, BLEND_MIN, v).padStart(4)}` +
    ` · sold out (${String(p.visits).padStart(4)} @6min) today ${gm(p.visits, 6, vi).padStart(4)} / Jan ${gm(p.visits, 6, v).padStart(4)}`);
}

/* ---------------------------------------------------------------------------
   PRICE AS A SHARE OF WHAT THE CLINIC COLLECTS.

   "What percent of collections is this?" is the sentence a clinic owner
   actually evaluates a practice bill with, so the ladder has to be quotable in
   it. The arithmetic is only as good as VISIT_FEE_PHP, which is why that is a
   constant with a sensitivity table under it rather than a number asserted in
   prose — it is the single input that moves the whole argument.

   AND IT WAS WRONG HERE UNTIL 2026-08-21. PRICING.md and the repricing commit
   both said the new ladder "sits at 2.9-3.9% of a clinic's collections". It
   does not, at any visit fee. The ladder's own spread is P26.54/P22.69 = 1.17x
   and a 2.9-3.9% band is 1.34x, so no single fee can produce it. At P800 the
   shipped ladder is 2.84-3.32%. The 2.1-2.4% quoted for the OLD ladder does
   reproduce exactly at P800, so the METHOD was right and the result was
   mis-transcribed. This matters commercially, not pedantically: 3.9% is at the
   top of the 2-5% norm and 3.3% is in the middle of it, and the difference is
   the whole of the "are we too expensive" question. */
const VISIT_FEE_PHP = 800;

const perVisitRate = (p) => p.php / p.visits;
const shareOfCollections = (p, fee) => perVisitRate(p) / fee;

console.log("\n=========== THE LADDER AS A SHARE OF COLLECTIONS ===========");
console.log(`  (a clinic's collections = included visits x the fee it bills per visit)\n`);
{
  const fees = [600, 800, 1000, 1500];
  console.log(`    plan       P/visit   ` + fees.map((f) => `@P${f}`.padStart(8)).join(""));
  for (const p of PLANS) {
    console.log(`    ${p.name.padEnd(9)} ${("P" + perVisitRate(p).toFixed(2)).padStart(7)}   ` +
      fees.map((f) => `${(100 * shareOfCollections(p, f)).toFixed(2)}%`.padStart(8)).join(""));
  }
  const lo = Math.min(...PLANS.map((p) => shareOfCollections(p, VISIT_FEE_PHP)));
  const hi = Math.max(...PLANS.map((p) => shareOfCollections(p, VISIT_FEE_PHP)));
  console.log(`\n  At the P${VISIT_FEE_PHP} we assume, the shipped ladder spans ${(100 * lo).toFixed(2)}%-${(100 * hi).toFixed(2)}%.`);
  console.log(`  It is quoted in PRICING.md as 2.9-3.9%. That is not this ladder — see the`);
  console.log(`  comment above VISIT_FEE_PHP. The band is narrower and LOWER than claimed.`);
}

/* ---------------------------------------------------------------------------
   CANDIDATE LADDERS, AUDITED AGAINST EVERY INVARIANT THE SUITE PINS.

   Four rules constrain any ladder, and three of them are in
   test/allowance.test.js rather than in anyone's judgement:

     1. every rung must be CHEAPER PER VISIT than the one below it, or
        upgrading buys capacity and no better price;
     2. overage must make the next rung attractive BEFORE the current one runs
        out — v1 + (p2-p1)/overage has to land inside v2, or a clinic sits on
        overage paying more than a plan;
     3. overagePerVisit / fairUseMinutesPerVisit must land within 0.5 of
        overagePerMinute, and overagePerVisit must clear the ENTRY rung's own
        per-visit rate;
     4. and the thing no test can check: the margin has to survive a clinic
        consuming everything it was sold.

   Rule 1 has a consequence that is easy to miss and decides this question: you
   cannot cut the entry rung on its own. Drop Solo to Group's per-visit rate and
   Practice is suddenly the expensive rung, so every price above it has to come
   down too. "Hold the entry rung low and leave the top alone" is not a ladder
   this product can sell. --------------------------------------------------- */

const CANDIDATES = [
  {
    label: "A — shipped today",
    note: "2.84-3.32% of collections at P800",
    plans: PLANS,
  },
  {
    label: "B — the literal 2.5-3.5% band",
    note: "entry rung AT 3.5%, top rung AT 2.5% — a WIDER band than today's",
    plans: [
      { name: "Solo",     php: 3640,  visits: 130 },
      { name: "Practice", php: 6650,  visits: 260 },
      { name: "Clinic",   php: 10450, visits: 450 },
      { name: "Group",    php: 29000, visits: 1450 },
    ],
  },
  {
    label: "C — a real cut, 2.5-2.9%",
    note: "what 'move the whole band down' actually costs",
    plans: [
      { name: "Solo",     php: 3000,  visits: 130 },
      { name: "Practice", php: 5800,  visits: 260 },
      { name: "Clinic",   php: 9550,  visits: 450 },
      { name: "Group",    php: 29000, visits: 1450 },
    ],
  },
];

function auditLadder(c) {
  const ps = c.plans;
  console.log(`\n  ${c.label}  —  ${c.note}`);
  console.log(`    plan       price     P/visit   % of collections   Jan margin typical / sold out`);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const typical = Math.round(p.visits * 0.75);
    const t = planMargin(p, typical, BLEND_MIN, RATES.list).gm;
    const s = planMargin(p, p.visits, POOL_MIN_PER_VISIT, RATES.list).gm;
    const delta = PLANS[i] ? p.php - PLANS[i].php : 0;
    console.log(`    ${p.name.padEnd(9)} ${("P" + p.php.toLocaleString("en-US")).padStart(8)}` +
      ` ${("P" + perVisitRate(p).toFixed(2)).padStart(9)}` +
      ` ${((100 * shareOfCollections(p, VISIT_FEE_PHP)).toFixed(2) + "%").padStart(13)}      ` +
      ` ${((100 * t).toFixed(0) + "%").padStart(4)} / ${((100 * s).toFixed(0) + "%").padStart(4)}` +
      (delta ? `   (${delta > 0 ? "+" : "-"}P${Math.abs(delta).toLocaleString("en-US")})` : ""));
  }
  /* rule 1 */
  let prev = Infinity, monotonic = true;
  for (const p of ps) { if (perVisitRate(p) >= prev) monotonic = false; prev = perVisitRate(p); }
  /* rule 2 */
  let upgradesInTime = true, when = [];
  for (let i = 0; i < ps.length - 1; i++) {
    const be = ps[i].visits + (ps[i + 1].php - ps[i].php) / OVERAGE_VISIT_PHP;
    when.push(`${ps[i + 1].name} wins at ${Math.round(be)}/${ps[i + 1].visits}`);
    if (be >= ps[i + 1].visits) upgradesInTime = false;
  }
  /* rule 3 */
  const overageClears = OVERAGE_VISIT_PHP > perVisitRate(ps[0]);
  const ratesAgree = Math.abs(OVERAGE_MIN_PHP - OVERAGE_VISIT_PHP / POOL_MIN_PER_VISIT) <= 0.5;
  /* rule 4 */
  const worst = Math.min(...ps.map((p) => planMargin(p, p.visits, POOL_MIN_PER_VISIT, RATES.list).gm));
  const row = (label, verdict, detail) =>
    console.log(`    ${(label + " ").padEnd(38, ".")} ${verdict}${detail ? "   " + detail : ""}`);
  const ok = (b) => (b ? "PASS" : "FAIL");
  row("rung gets cheaper per visit", ok(monotonic));
  row("overage forces a timely upgrade", ok(upgradesInTime), `(${when.join(" · ")})`);
  row(`P${OVERAGE_VISIT_PHP} overage clears the entry rate`, ok(overageClears), `(P${OVERAGE_VISIT_PHP} vs P${perVisitRate(ps[0]).toFixed(2)})`);
  row("overage rates agree with each other", ok(ratesAgree), `(P${OVERAGE_VISIT_PHP}/${POOL_MIN_PER_VISIT}min = P${(OVERAGE_VISIT_PHP / POOL_MIN_PER_VISIT).toFixed(2)}/min vs P${OVERAGE_MIN_PHP})`);
  row("worst margin at full entitlement", `${(100 * worst).toFixed(0)}%`.padStart(4), worst < 0.5 ? "<-- under the 50% the shipped ladder holds" : "");
  const mrr = ps.reduce((a, p) => a + p.php, 0), mrrA = PLANS.reduce((a, p) => a + p.php, 0);
  if (c.plans !== PLANS) row("one clinic on each rung", `P${mrr.toLocaleString("en-US")}/mo`, `vs P${mrrA.toLocaleString("en-US")} today  (${(100 * (mrr / mrrA - 1)).toFixed(1)}%)`);
}

console.log("\n=========== 2.9-3.9% vs 2.5-3.5%: THE LADDERS SIDE BY SIDE ===========");
console.log("  (margins at the January 2027 Gemini rate — the hard case)");
for (const c of CANDIDATES) auditLadder(c);

/* The floor, stated once so it can be argued with rather than assumed. Below
   ~60% gross margin this stops being a software business at this scale: there
   is no room left for the support, sales and R&D a clinic-facing EMR needs out
   of the same peso, and every point of it is bought back only by volume this
   market does not have. The column that decides it is "sold out", not
   "typical" — a clinic using what it PAID FOR must still clear the floor. */
const GM_FLOOR = 0.60;
console.log(`\n  The floor: ${(100 * GM_FLOOR).toFixed(0)}% at typical use, and the shipped ladder holds 50-55% even`);
console.log(`  when every visit and every dictation minute sold is consumed. Any ladder whose`);
console.log(`  SOLD-OUT column drops under ~45% is one bad usage month from unprofitable.`);

console.log("\n=========== WHAT THE DICTATION METER IS PROTECTING ===========");
console.log(`  30 min of mic-on, gate OFF (before yesterday):           ${peso(30 * STT_PER_MIN)}`);
console.log(`  30 min mic-on, gated, quiet room:                        ${peso(0)} — nothing is submitted, so nothing is billed`);
console.log(`  30 min mic-on, gated, ~50% of it talking:                ${peso(30 * 0.5 * STT_PER_MIN)}`);
console.log(`  one whole documented visit, for scale:                   ${peso(baseVisit)}`);
console.log(`  +2 avoidable recorded min per visit, one seat, a month:  ${peso(2 * STT_PER_MIN * 8 * DAYS)}`);
console.log(`  ...the same habit across a 6-seat clinic:                ${peso(2 * STT_PER_MIN * 8 * DAYS * 6)}/mo`);

/* ---------------------------------------------------------------------------
   The ladder above is a COPY of numbers that live in the app. Copies drift,
   and a drifted copy here is worse than no model at all, because it produces a
   confident margin for a price nobody is charged. So check it, and fail. */
const fs = require("fs");
const appSrc = fs.readFileSync(require("path").join(__dirname, "app.js"), "utf8");
const storeSrc = fs.readFileSync(require("path").join(__dirname, "store.js"), "utf8");
const problems = [];
for (const p of PLANS) {
  const re = new RegExp(`tier\\("${p.name}",\\s*${p.php},\\s*${p.visits}\\b`);
  if (!re.test(appSrc)) problems.push(`app.js renderLanding has no tier ${p.name} at P${p.php}/${p.visits} visits`);
}
const storeNum = (key) => {
  const m = storeSrc.match(new RegExp(`${key}:\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};
if (storeNum("overagePerVisit") !== OVERAGE_VISIT_PHP) problems.push(`store.js overagePerVisit is ${storeNum("overagePerVisit")}, model says ${OVERAGE_VISIT_PHP}`);
if (storeNum("overagePerMinute") !== OVERAGE_MIN_PHP) problems.push(`store.js overagePerMinute is ${storeNum("overagePerMinute")}, model says ${OVERAGE_MIN_PHP}`);
if (storeNum("fairUseMinutesPerVisit") !== POOL_MIN_PER_VISIT) problems.push(`store.js fairUseMinutesPerVisit is ${storeNum("fairUseMinutesPerVisit")}, model says ${POOL_MIN_PER_VISIT}`);
if (storeNum("visitAllowance") !== PLANS[0].visits) problems.push(`store.js visitAllowance default is ${storeNum("visitAllowance")}, entry plan is ${PLANS[0].visits}`);

console.log("\n=========== LADDER vs THE APP ===========");
if (problems.length) {
  for (const p of problems) console.log(`  MISMATCH  ${p}`);
  console.log("\n  The model is describing a price the app does not charge. Fix one or the other.");
  process.exitCode = 1;
} else {
  console.log("  every plan, both overage rates and the pool rate match app.js and store.js");
}
