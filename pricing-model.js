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

/* Per-call token profile. `in` is measured; `out` and `think` are the band. */
const BANDS = {
  low:  { refine: { in: 1620, out: 1000, think: 1800 }, insights: { in: 2820, out: 700,  think: 3500 } },
  base: { refine: { in: 1620, out: 1400, think: 2300 }, insights: { in: 2820, out: 1000, think: 5000 } },
  high: { refine: { in: 1620, out: 1800, think: 2800 }, insights: { in: 2820, out: 1400, think: 7000 } },
};
const call = (c, r) => (c.in * r.in + (c.out + c.think) * r.out) / 1e6;

/* One documented visit = dictation minutes + one refine + one insights re-run
   (the chart review re-runs when the chart changes, which a new note does). */
const VISIT_MIN = { eval: 6.0, daily: 2.5 };   // BILLED dictation minutes, i.e. voiced audio
const MIX = { eval: 1, daily: 8 };             // one evaluation per eight daily notes
const N = MIX.eval + MIX.daily;
const BLEND_MIN = (VISIT_MIN.eval * MIX.eval + VISIT_MIN.daily * MIX.daily) / N;

function perVisit(band, rate, insightsShare = 1.0) {
  const b = BANDS[band];
  const stt = BLEND_MIN * STT_PER_MIN;
  const gem = call(b.refine, rate) + insightsShare * call(b.insights, rate);
  return { stt, gem, total: stt + gem };
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

console.log("\n=========== PROPOSED LADDER (priced at the 2027 rate, so January is not a repricing) ===========");
const PLANS = [
  { name: "Solo",   php: 3900,  seats: 1, visits: 250 },
  { name: "Clinic", php: 9900,  seats: 3, visits: 750 },
  { name: "Group",  php: 17900, seats: 6, visits: 1600 },
];
const EXTRA_VISIT_PHP = 15;
for (const p of PLANS) {
  const usd = p.php / FX;
  const infra = INFRA_TOTAL / CLINICS_SHARING;
  const typical = 8 * DAYS * p.seats;
  const gm = (visits, per) => `${(100 * (1 - (visits * per + infra) / usd)).toFixed(0)}%`;
  const introVisit = perVisit("base", RATES.intro).total;
  console.log(`\n  ${p.name} — ₱${p.php}/mo ($${usd.toFixed(0)}) · ${p.seats} seat(s) · ${p.visits} AI-documented visits included (₱${Math.round(p.php / p.seats)}/seat)`);
  console.log(`     allowance = ${(p.visits / p.seats / DAYS).toFixed(1)} visits/seat/day ≈ ${Math.round(p.visits * BLEND_MIN)} dictation min`);
  console.log(`     typical use (${typical} visits): today ${gm(typical, introVisit)} · Jan-2027 ${gm(typical, baseVisit)} · after cuts ${gm(typical, tuned.total)}`);
  console.log(`     allowance maxed (${p.visits}):    today ${gm(p.visits, introVisit)} · Jan-2027 ${gm(p.visits, baseVisit)} · after cuts ${gm(p.visits, tuned.total)}`);
  console.log(`     extra visits ₱${EXTRA_VISIT_PHP} each → ${(100 * (1 - php(baseVisit) / EXTRA_VISIT_PHP)).toFixed(0)}% margin at the 2027 rate, ${(100 * (1 - php(tuned.total) / EXTRA_VISIT_PHP)).toFixed(0)}% after cuts`);
}

console.log("\n=========== WHAT THE DICTATION METER IS PROTECTING ===========");
console.log(`  30 min of mic-on, gate OFF (before yesterday):           ${peso(30 * STT_PER_MIN)}`);
console.log(`  30 min mic-on, gated, quiet room:                        ${peso(0)} — nothing is submitted, so nothing is billed`);
console.log(`  30 min mic-on, gated, ~50% of it talking:                ${peso(30 * 0.5 * STT_PER_MIN)}`);
console.log(`  one whole documented visit, for scale:                   ${peso(baseVisit)}`);
console.log(`  +2 avoidable recorded min per visit, one seat, a month:  ${peso(2 * STT_PER_MIN * 8 * DAYS)}`);
console.log(`  ...the same habit across a 6-seat clinic:                ${peso(2 * STT_PER_MIN * 8 * DAYS * 6)}/mo`);
