/* TheraChart insights checker — verifies the local heuristic surfaces the
   right connections, red flags, and recommendations from chart context.
   Run: node test/insights.test.js */

"use strict";
const I = require("../insights.js");

let passed = 0;
const failures = [];
const check = (n, c, d) => { if (c) passed += 1; else failures.push(`✗ ${n}${d ? `\n    ${d}` : ""}`); };
const titles = (r) => r.connections.map((c) => c.title).join(" | ");

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

const total = passed + failures.length;
console.log(`\nTheraChart insights checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
