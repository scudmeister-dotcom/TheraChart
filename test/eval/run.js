#!/usr/bin/env node
/* TheraChart AI eval runner.

   Scores whichever AI engine is configured against the golden cases in
   cases.js, so a prompt or model change produces a NUMBER instead of an
   impression. Run it before and after editing a prompt.

     node test/eval/run.js                       # local heuristic (free, deterministic)
     GEMINI_API_KEY=... node test/eval/run.js     # consumer Gemini
     GEMINI_VERTEX=1 GCP_PROJECT=... node test/eval/run.js   # Vertex (BAA path)

     node test/eval/run.js --save-baseline        # record this run as the bar
     node test/eval/run.js --json                 # machine-readable output
     node test/eval/run.js --case refine/         # only ids with this prefix
     node test/eval/run.js --runs 3               # repeat, to see model variance

   A later run is compared against test/eval/baseline.<engine>.json and any
   assertion that flipped is called out by name. Exit code is non-zero when a
   run scores below its saved baseline, so CI can gate on it.
*/

"use strict";

const fs = require("fs");
const path = require("path");
const ai = require("../../ai.js");
const { REFINE_CASES, INSIGHTS_CASES } = require("./cases.js");

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAVE = has("--save-baseline");
const JSON_OUT = has("--json");
const ONLY = val("--case", "");
const RUNS = Math.max(1, Number(val("--runs", "1")) || 1);

/* ---------- engine selection (mirrors server.js) ---------- */
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const VERTEX = /^(1|true|yes|on)$/i.test(process.env.GEMINI_VERTEX || "") && !!process.env.GCP_PROJECT;
const engineName = VERTEX ? "vertex" : GEMINI_KEY ? "gemini" : "local";
const opts = VERTEX
  ? { vertex: true, project: process.env.GCP_PROJECT, location: process.env.GEMINI_LOCATION || "global",
      model: process.env.GEMINI_MODEL || ai.DEFAULT_MODEL, insightsModel: process.env.GEMINI_INSIGHTS_MODEL || ai.DEFAULT_INSIGHTS_MODEL,
      getToken: null, onError: (w, e) => console.error(`  ! ${w}: ${e.message}`) }
  : GEMINI_KEY
    ? { key: GEMINI_KEY, model: process.env.GEMINI_MODEL || ai.DEFAULT_MODEL,
        insightsModel: process.env.GEMINI_INSIGHTS_MODEL || ai.DEFAULT_INSIGHTS_MODEL,
        base: process.env.GEMINI_BASE_URL || ai.DEFAULT_BASE,
        onError: (w, e) => console.error(`  ! ${w}: ${e.message}`) }
    /* The local engine is the OFFLINE HEURISTIC being scored on purpose. The
       product no longer offers it — a review the model did not do is not a
       smaller version of this feature — so ai.refine refuses it by default and
       this harness has to ask for it explicitly. Keeping the score is still
       worth it: the heuristic supplies per-field fallbacks inside
       normalizeRefinement whenever the model omits a section, so its quality
       still reaches real notes even though it can no longer stand in for a
       whole review. */
    : { allowLocalFallback: true };

// Optional override so thinking levels can be A/B'd against the scored cases:
//   GEMINI_THINKING_LEVEL=low|medium|high npm run eval
// It overrides every path (refine AND the deep ones), so low = thinking off.
// Unset = the shipped defaults (medium for refine, high for the rest).
if (process.env.GEMINI_THINKING_LEVEL) opts.thinkingLevel = process.env.GEMINI_THINKING_LEVEL.trim();

if (VERTEX) {
  // Vertex needs an OAuth token; reuse gcloud's if one is available, else bail
  // clearly rather than silently scoring the local fallback as if it were Vertex.
  try {
    const { execFileSync } = require("child_process");
    const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
    opts.getToken = async () => token;
  } catch {
    console.error("GEMINI_VERTEX=1 but no OAuth token available (tried `gcloud auth print-access-token`).");
    process.exit(2);
  }
}

/* ---------- scoring ---------- */

const applies = (a) => !a.engines || a.engines.includes(engineName === "vertex" ? "gemini" : engineName);

async function scoreCase(c, run) {
  let result, error = null;
  try {
    result = c.kind === "insights" ? await ai.insightsRun(c.input, opts) : await ai.refine(c.input, opts);
  } catch (e) {
    error = e.message;
    result = null;
  }

  /* Guard against grading something the model did not produce.

     This used to sniff for "local" in `source`, because a failed call answered
     with the heuristic. It no longer does — a refusal comes back empty — so the
     honest signal is the flag the result now carries. The old test is kept
     alongside it: a run with `allowLocalFallback` set, or an older recorded
     result, still says "local" in `source`, and grading either as if it were
     the model is the mistake this line exists to prevent. */
  const sourceUsed = (result && result.source) || "error";
  const fellBack = engineName !== "local"
    && (/local|unavailable|^failed$/.test(sourceUsed) || (result && result.aiFailed === true));

  const graded = [];
  for (const a of c.assertions) {
    if (!applies(a)) { graded.push({ name: a.name, weight: a.weight, skipped: true }); continue; }
    let ok = false, thrown = null;
    try { ok = !!(result && a.test(result)); } catch (e) { thrown = e.message; }
    graded.push({ name: a.name, weight: a.weight, ok, thrown });
  }
  const scored = graded.filter((g) => !g.skipped);
  const earned = scored.reduce((n, g) => n + (g.ok ? g.weight : 0), 0);
  const possible = scored.reduce((n, g) => n + g.weight, 0);
  return { id: c.id, what: c.what, run, sourceUsed, fellBack, error, graded, earned, possible };
}

(async () => {
  const cases = [
    ...REFINE_CASES.map((c) => ({ ...c, kind: "refine" })),
    ...INSIGHTS_CASES.map((c) => ({ ...c, kind: "insights" })),
  ].filter((c) => !ONLY || c.id.startsWith(ONLY));

  if (!cases.length) { console.error(`no cases match --case ${ONLY}`); process.exit(2); }

  const all = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) all.push(await scoreCase(c, run));
  }

  // average across runs, per case
  const byId = new Map();
  for (const r of all) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const perCase = [...byId.entries()].map(([id, runs]) => {
    const earned = runs.reduce((n, r) => n + r.earned, 0);
    const possible = runs.reduce((n, r) => n + r.possible, 0);
    const failedNames = new Set();
    for (const r of runs) for (const g of r.graded) if (!g.skipped && !g.ok) failedNames.add(g.name);
    // an assertion that passes in one run and fails in another = model variance
    const flaky = new Set();
    if (runs.length > 1) {
      for (const name of failedNames) {
        const outcomes = runs.map((r) => (r.graded.find((g) => g.name === name) || {}).ok);
        if (outcomes.some(Boolean)) flaky.add(name);
      }
    }
    return {
      id, what: runs[0].what, earned, possible,
      pct: possible ? earned / possible : 1,
      failed: [...failedNames], flaky: [...flaky],
      fellBack: runs.some((r) => r.fellBack), error: runs.find((r) => r.error) ? runs.find((r) => r.error).error : null,
    };
  });

  const earned = perCase.reduce((n, c) => n + c.earned, 0);
  const possible = perCase.reduce((n, c) => n + c.possible, 0);
  const overall = possible ? earned / possible : 1;
  const summary = { engine: engineName, model: opts.model || "n/a", runs: RUNS, earned, possible, overall, cases: perCase };

  /* ---------- baseline comparison ---------- */
  const baselinePath = path.join(__dirname, `baseline.${engineName}.json`);
  let baseline = null;
  if (fs.existsSync(baselinePath)) {
    try { baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch { /* corrupt: ignore */ }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ...summary, baseline: baseline && { overall: baseline.overall } }, null, 2));
  } else {
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    // floor, so anything short of perfect never renders as a full bar
    const bar = (x) => { const n = x >= 1 ? 20 : Math.floor(x * 20); return "█".repeat(n) + "░".repeat(20 - n); };
    console.log(`\nTheraChart AI eval — engine: ${engineName}${opts.model ? ` (${opts.model})` : ""}${RUNS > 1 ? ` · ${RUNS} runs` : ""}\n`);
    for (const c of perCase) {
      const flag = c.fellBack ? "  ⚠ FELL BACK TO LOCAL" : "";
      console.log(`  ${bar(c.pct)} ${pct(c.pct).padStart(6)}  ${c.id}${flag}`);
      console.log(`  ${" ".repeat(20)}         ${c.what}`);
      for (const f of c.failed) console.log(`  ${" ".repeat(20)}         ✗ ${f}${c.flaky.includes(f) ? "  (flaky across runs)" : ""}`);
      if (c.error) console.log(`  ${" ".repeat(20)}         ! ${c.error}`);
    }
    console.log(`\n  OVERALL  ${bar(overall)} ${pct(overall)}  (${earned}/${possible} weighted points)`);

    if (baseline) {
      const delta = overall - baseline.overall;
      const dir = delta > 0.0001 ? "improved" : delta < -0.0001 ? "REGRESSED" : "unchanged";
      console.log(`  vs baseline (${pct(baseline.overall)}): ${dir}${Math.abs(delta) > 0.0001 ? ` by ${pct(Math.abs(delta))}` : ""}`);
      const bById = new Map((baseline.cases || []).map((c) => [c.id, c]));
      for (const c of perCase) {
        const b = bById.get(c.id);
        if (!b) { console.log(`    + new case ${c.id}`); continue; }
        const was = new Set(b.failed || []);
        const now = new Set(c.failed);
        for (const n of now) if (!was.has(n)) console.log(`    ✗ newly failing — ${c.id}: ${n}`);
        for (const n of was) if (!now.has(n)) console.log(`    ✓ newly passing — ${c.id}: ${n}`);
      }
    } else {
      console.log(`  no baseline yet — record one with:  node test/eval/run.js --save-baseline`);
    }
    console.log("");
  }

  if (SAVE) {
    fs.writeFileSync(baselinePath, JSON.stringify(summary, null, 2));
    if (!JSON_OUT) console.log(`  baseline written to ${path.relative(process.cwd(), baselinePath)}\n`);
    process.exit(0);
  }

  // fail the run if it scored below a recorded baseline (small tolerance for
  // model non-determinism; the local engine is deterministic so it gets none)
  if (baseline) {
    const tolerance = engineName === "local" ? 0 : 0.02;
    if (overall < baseline.overall - tolerance) process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error("eval runner crashed:", e); process.exit(2); });
