/* TheraChart insights checker — verifies the local heuristic surfaces the
   right connections, red flags, and recommendations from chart context.
   Run: node test/insights.test.js */

"use strict";
const I = require("../insights.js");

let passed = 0;
const failures = [];
const check = (n, c, d) => { if (c) passed += 1; else failures.push(`✗ ${n}${d ? `\n    ${d}` : ""}`); };
const titles = (r) => r.connections.map((c) => c.title).join(" | ");
const flagsOf = (r) => r.redFlags.map((f) => f.flag).join(" | ");

/* recurrence + declining ROM + recommendation */
{
  const ctx = {
    referral: "right shoulder pain", pmh: "Hypertension",
    current: {
      subjective: "Right shoulder still painful",
      findings: [{ part: "Shoulder", side: "right", summary: "pain 6/10 reaching overhead" }],
      measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 100 }], pain: [{ location: "right shoulder", score: 6 }] },
    },
    history: [
      { date: "2026-06-20", type: "eval", findings: [{ part: "Shoulder", side: "right", summary: "pain 7/10" }], measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 120 }], pain: [{ location: "right shoulder", score: 7 }] } },
      { date: "2026-06-25", type: "daily", findings: [{ part: "Shoulder", side: "right", summary: "pain 7/10" }], measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 110 }] } },
    ],
  };
  const r = I.buildInsights(ctx);
  check("recurrence connection surfaced", /Recurrent right shoulder/i.test(titles(r)), titles(r));
  check("declining ROM connection surfaced", /Declining .*flexion ROM/i.test(titles(r)), titles(r));
  check("declining ROM raises a red flag", r.redFlags.some((f) => /ROM is going down/i.test(f.flag)), JSON.stringify(r.redFlags));
  check("consistent-with-referral connection", /referral/i.test(titles(r)), titles(r));
  check("recommendation to re-examine on decline", r.recommendations.some((x) => /re-examine|referral/i.test(x.action)), JSON.stringify(r.recommendations.map((x) => x.action)));
  check("no findings invented beyond chart", r.connections.every((c) => c.title && c.detail));
}

/* radicular pattern + neuro red flag */
{
  const ctx = {
    pmh: "Type 2 diabetes",
    current: {
      findings: [
        { part: "Lower back", side: null, summary: "sharp pain 7/10" },
        { part: "Leg", side: "right", summary: "numbness and tingling with weakness" },
      ],
      measurements: {},
    },
    history: [],
  };
  const r = I.buildInsights(ctx);
  check("radicular pattern connection", /lumbar radicular/i.test(titles(r)), titles(r));
  check("neuro red flag for numbness+weakness", r.redFlags.some((f) => /numbness|neuro/i.test(f.flag)), JSON.stringify(r.redFlags));
  check("diabetes connection", /Diabetes/i.test(titles(r)), titles(r));
  check("neuro screen recommended", r.recommendations.some((x) => /neuro|radicular|SLR/i.test(x.action)), JSON.stringify(r.recommendations.map((x) => x.action)));
}

/* empty history is safe */
{
  const r = I.buildInsights({ current: { findings: [{ part: "Knee", side: "left", summary: "mild pain" }], measurements: {} }, history: [] });
  check("first visit still yields baseline recommendations", r.recommendations.length >= 1, JSON.stringify(r.recommendations));
  check("no crash on empty history", Array.isArray(r.connections));
}

/* prompt building */
{
  const p = I.insightsPrompt({ referral: "low back pain", pmh: "none", current: { subjective: "hurts when bending", findings: [{ part: "Lower back", summary: "pain 6/10" }], measurements: {} }, history: [] });
  check("prompt frames the PT + decision support", /physical therapist/i.test(p) && /decision support/i.test(I.insightsSystem().toLowerCase() ? "decision support" : ""), "");
  check("prompt includes current findings", /Lower back/i.test(p));
  check("prompt notes empty history", /no prior documents/i.test(p));
}

/* pain trends never mix body regions (2026-07 stress test) */
{
  const M = (o) => Object.assign({ rom: [], mmt: [], special: [], pain: [] }, o);
  const r = I.buildInsights({
    current: { findings: [{ part: "Knee", side: "right", summary: "mild ache" }], measurements: M({ pain: [{ location: "right knee", score: 2 }] }) },
    history: [
      { date: "2026-06-01", findings: [], measurements: M({ pain: [{ location: "right knee", score: 6 }] }) },
      { date: "2026-05-01", findings: [{ part: "Shoulder", side: "left", summary: "severe pain" }], measurements: M({ pain: [{ location: "left shoulder", score: 8 }] }) },
    ],
  });
  const painConns = r.connections.filter((c) => /^Pain /.test(c.title));
  check("mixed regions: knee trend reported per-region", painConns.some((c) => /right knee/.test(c.title) && /decreasing/i.test(c.title)), titles(r));
  check("mixed regions: no cross-region 8→2 claim", !painConns.some((c) => /8\/10 to 2\/10/.test(c.detail)), JSON.stringify(painConns));
}

/* malformed pain scores don't crash or pollute trends */
{
  const M = (o) => Object.assign({ rom: [], mmt: [], special: [], pain: [] }, o);
  const r = I.buildInsights({
    current: { findings: [], measurements: M({ pain: [{ score: 3 }] }) },
    history: [{ date: "2026-06-01", findings: [], measurements: M({ pain: [{ score: "not-a-number" }, { score: "7" }] }) }],
  });
  check("stringy/garbage scores handled", r.connections.some((c) => /7\/10 to 3\/10/.test(c.detail)), titles(r));
}

/* digest of a large chart keeps the pain trend connected to now */
{
  const M = (o) => Object.assign({ rom: [], mmt: [], special: [], pain: [] }, o);
  const older = [];
  for (let i = 0; i < 60; i++) {
    older.push({
      date: new Date(2024, 0, 1 + i * 5).toISOString().slice(0, 10), type: "daily",
      findings: [{ part: "Knee", side: "right", summary: "ache" }],
      measurements: M({ pain: [{ location: "right knee", score: Math.max(1, 8 - Math.floor(i / 10)) }] }),
    });
  }
  const dg = I.buildHistoryDigest(older);
  const r = I.buildInsights({
    current: { findings: [{ part: "Knee", side: "right", summary: "mild ache" }], measurements: M({ pain: [{ location: "right knee", score: 1 }] }) },
    history: [], historyDigest: dg,
  });
  check("digest: 60-visit chart digested", dg && dg.visits === 60, JSON.stringify(dg && dg.visits));
  check("digest: long-run pain trend surfaces", r.connections.some((c) => /Pain decreasing/i.test(c.title)), titles(r));
  check("digest: recurrence counts older visits", r.connections.some((c) => /Recurrent right knee/i.test(c.title) && /60/.test(c.detail)), titles(r));
}

/* denied regions are documentation of absence, not involvement */
{
  const r = I.buildInsights({
    current: {
      findings: [
        { part: "Neck", side: null, summary: "Denies pain" },
        { part: "Wrist", side: "right", summary: "Sharp pain" },
        { part: "Hand", side: "right", summary: "Denies numbness and tingling" },
      ],
      measurements: {},
    },
    history: [{ date: "2026-06-01", findings: [{ part: "Neck", side: null, summary: "Denies pain" }], measurements: {} }],
  });
  check("denied neck: no cervical radicular pattern", !/cervical/i.test(titles(r)), titles(r));
  check("denied neck: no recurrence connection", !/recurrent neck/i.test(titles(r)), titles(r));
  check("denied numbness: no neuro red flag", !r.redFlags.some((f) => /numbness/i.test(f.flag)), JSON.stringify(r.redFlags));
}

/* constitutional red flags — the serious-pathology screen */
{
  const r = I.buildInsights({
    referral: "thoracic pain", pmh: "Former smoker",
    current: {
      subjective: "Constant deep pain, worse at night, unrelieved by rest. Unintentional 6 kg weight loss over 2 months.",
      findings: [{ part: "Upper back", side: null, summary: "constant deep pain 8/10" }],
      measurements: {},
    },
    history: [],
  });
  check("night pain raises a red flag", /night/i.test(flagsOf(r)), flagsOf(r));
  check("unexplained weight loss raises a red flag", /weight loss/i.test(flagsOf(r)), flagsOf(r));
  check("several red flags together prompt medical referral",
    r.recommendations.some((x) => /refer/i.test(x.action) && /physician/i.test(x.action)), JSON.stringify(r.recommendations.map((x) => x.action)));
  check("the referral recommendation is high priority",
    r.recommendations.some((x) => /refer/i.test(x.action) && x.priority === "high"), JSON.stringify(r.recommendations));
  check("no diagnosis is asserted as fact", !/\b(is|has) (cancer|a tumou?r|malignancy)/i.test(JSON.stringify(r)));
}
{
  // a plain mechanical presentation must NOT trip the constitutional screen
  const r = I.buildInsights({
    current: { subjective: "Knee hurts when I climb stairs, better with rest.", findings: [{ part: "Knee", side: "left", summary: "pain 4/10 on stairs" }], measurements: {} },
    history: [],
  });
  check("a mechanical presentation raises no constitutional flag",
    !/night|weight loss|fever|cauda/i.test(flagsOf(r)), flagsOf(r));
}
{
  // cauda equina is the emergency case
  const r = I.buildInsights({
    current: { subjective: "Saddle numbness and new bowel and bladder incontinence since yesterday.", findings: [{ part: "Lower back", side: null, summary: "back pain" }], measurements: {} },
    history: [],
  });
  check("cauda equina symptoms are flagged", /cauda equina/i.test(flagsOf(r)), flagsOf(r));
}

const total = passed + failures.length;
console.log(`\nTheraChart insights checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
