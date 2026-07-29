#!/usr/bin/env node
/* TheraChart scanned-record import eval.

   Scores ai.extractRecords against fixture charts whose correct answer we
   know, so a prompt or schema change to the import path produces a NUMBER
   instead of an impression. Companion to run.js, which scores refine/insights.

   The scan fixtures are image-only PDFs (see fixtures/make-scan.py) — no text
   layer, so the model has to OCR them the way it OCRs a real chart scan. The
   text fixture is the older style, kept as a control: it is much easier, and
   a regression that only shows up on the scans is exactly the kind this eval
   exists to catch.

     node test/eval/extract.js                    # needs a live engine (see below)
     GEMINI_VERTEX=1 GCP_PROJECT=... node test/eval/extract.js
     GEMINI_API_KEY=... node test/eval/extract.js

     node test/eval/extract.js --runs 3           # repeat, to see model variance
     node test/eval/extract.js --fixture scan_4visit
     node test/eval/extract.js --json             # machine-readable output
     node test/eval/extract.js --min 0.8          # required pass rate (default 0.8)

   There is no local fallback for document reading, so unlike run.js this eval
   cannot score the local engine — without a key or Vertex it exits 2.

   Exit code is non-zero when any fixture scores below --min, so CI can gate.
*/

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ai = require("../../ai.js");

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const JSON_OUT = has("--json");
const RUNS = Math.max(1, Number(val("--runs", "1")) || 1);
const ONLY = val("--fixture", "");
const MIN = Number(val("--min", "0.8"));

/* ---------- engine selection (mirrors run.js) ---------- */
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const VERTEX = /^(1|true|yes|on)$/i.test(process.env.GEMINI_VERTEX || "") && !!process.env.GCP_PROJECT;
const engineName = VERTEX ? "vertex" : GEMINI_KEY ? "gemini" : "local";
const opts = VERTEX
  ? { vertex: true, project: process.env.GCP_PROJECT, location: process.env.GEMINI_LOCATION || "global",
      model: process.env.GEMINI_MODEL || ai.DEFAULT_MODEL, getToken: null }
  : GEMINI_KEY
    ? { key: GEMINI_KEY, model: process.env.GEMINI_MODEL || ai.DEFAULT_MODEL,
        base: process.env.GEMINI_BASE_URL || ai.DEFAULT_BASE }
    : {};

if (process.env.GEMINI_THINKING_LEVEL) opts.thinkingLevel = process.env.GEMINI_THINKING_LEVEL.trim();

if (engineName === "local") {
  console.error("Reading documents has no local fallback — set GEMINI_API_KEY, or GEMINI_VERTEX=1 with GCP_PROJECT.");
  process.exit(2);
}
if (VERTEX) {
  try {
    const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
    opts.getToken = async () => token;
  } catch {
    console.error("GEMINI_VERTEX=1 but no OAuth token available (tried `gcloud auth print-access-token`).");
    process.exit(2);
  }
}

/* ---------- fixtures ----------
   Each fixture states what a correct extraction looks like. `visits` is the
   number of distinct visits on the document; `dates` and `types` are what
   those visits must normalize to, in chronological order. */

const FIXTURE_DIR = __dirname + "/fixtures";

// The pre-scan style: a PDF assembled from text operators, so it carries a
// text layer and needs no OCR. Kept as an easy control.
function makeTextPdf(lines) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = "BT /F1 11 Tf 56 760 Td 15 TL\n" +
    lines.map((l) => `(${esc(l)}) Tj T*`).join("\n") + "\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

const TEXT_PDF_LINES = [
  "BAYANIHAN PHYSICAL THERAPY CENTER — PATIENT RECORD (photocopy)",
  "Patient: REYES, JUAN   DOB: 04/12/1988   Dx: R rotator cuff strain",
  "",
  "INITIAL EVALUATION — 05/02/2023   Therapist: R. Villanueva, PT",
  "S: Right shoulder pain 8/10 after lifting at work, worse overhead.",
  "   Denies numbness or tingling.",
  "O: Guarding noted. Shoulder flexion 95 degrees. Abduction 85 degrees.",
  "   MMT right shoulder abduction 3+/5. Positive Neer test.",
  "A: Findings consistent with right rotator cuff strain.",
  "P: PT 3x/week for 6 weeks - therex, manual therapy, modalities.",
  "",
  "DAILY TREATMENT NOTE — 05/09/2023   Therapist: R. Villanueva, PT",
  "S: Pain improved to 5/10. Still sore reaching overhead.",
  "O: Shoulder flexion 115 degrees.",
  "Rx: Scaption raises 3x10, ER isometrics, posterior capsule",
  "    mobilization grade III, HEP reviewed. Tolerated well.",
];

const FIXTURES = [
  { id: "text_2visit", label: "text-layer PDF, 2 visits (control — no OCR needed)",
    buf: () => makeTextPdf(TEXT_PDF_LINES), visits: 2,
    dates: ["2023-05-02", "2023-05-09"], types: ["eval", "daily"], name: /reyes/i },
  { id: "scan_2visit", label: "1-page image-only scan, 2 visits",
    file: "scan_2visit.pdf", visits: 2,
    dates: ["2023-05-02", "2023-05-09"], types: ["eval", "daily"], name: /reyes/i },
  { id: "scan_4visit", label: "2-page image-only scan, 4 visits",
    file: "scan_4visit.pdf", visits: 4,
    dates: ["2023-05-02", "2023-05-09", "2023-05-23", "2023-06-13"],
    types: ["eval", "daily", "progress", "discharge"], name: /reyes/i },
];

// Regenerate the image-only fixtures when missing. They are gitignored: a
// bitmap is bulky, and make-scan.py is deterministic so rebuilding is exact.
function ensureScans() {
  const needed = FIXTURES.filter((f) => f.file && !fs.existsSync(path.join(FIXTURE_DIR, f.file)));
  if (!needed.length) return;
  const py = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  console.error(`building ${needed.length} scan fixture(s) with ${py}…`);
  try {
    execFileSync(py, [path.join(FIXTURE_DIR, "make-scan.py")], { stdio: "inherit" });
  } catch {
    console.error(`Could not build the scan fixtures. They need Pillow:\n  ${py} -m pip install Pillow`);
    process.exit(2);
  }
}

/* ---------- assertions ----------
   Beyond "did it find the visits", these check the failure mode that made the
   import unreliable: the model used to cram a whole note into `treatment` and
   leave subjective/objective empty, which normalizeExtraction faithfully kept
   as a content-less visit. `narrativeSplit` is what catches a relapse. */

function assess(fx, r) {
  const v = r.visits;
  const dates = v.map((x) => x.date);
  const types = v.map((x) => x.type);
  const checks = {
    visitCount: v.length === fx.visits,
    datesExact: JSON.stringify(dates) === JSON.stringify(fx.dates),
    typesExact: JSON.stringify(types) === JSON.stringify(fx.types),
    patientName: fx.name.test(r.patientName || ""),
    // every visit says something the patient reported
    subjectiveOnAll: v.length > 0 && v.every((x) => x.subjective),
    // no visit is a bare shell, and none is one giant field
    narrativeSplit: v.length > 0 && v.every((x) => x.objective && x.treatment.length < 400),
    // the eval's measurements survived
    measurements: v.some((x) => x.rom.length >= 2) && v.some((x) => x.mmt.length >= 1) &&
      v.some((x) => x.special.length >= 1) && v.some((x) => x.pain.length >= 1),
  };
  return { checks, passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length };
}

/* ---------- run ---------- */

(async () => {
  ensureScans();
  const chosen = FIXTURES.filter((f) => !ONLY || f.id.startsWith(ONLY));
  if (!chosen.length) { console.error(`No fixture matches --fixture ${ONLY}`); process.exit(2); }

  const report = { engine: engineName, model: opts.model || ai.DEFAULT_MODEL, runs: RUNS, fixtures: {} };

  for (const fx of chosen) {
    const buf = fx.file ? fs.readFileSync(path.join(FIXTURE_DIR, fx.file)) : fx.buf();
    const b64 = buf.toString("base64");
    if (!JSON_OUT) console.log(`\n── ${fx.id} — ${fx.label}`);
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = Date.now();
      try {
        const r = await ai.extractRecords(b64, "application/pdf", opts);
        const a = assess(fx, r);
        runs.push({ ok: true, ms: Date.now() - t0, ...a });
        if (!JSON_OUT) {
          const failed = Object.entries(a.checks).filter(([, ok]) => !ok).map(([k]) => k);
          console.log(`   run ${i + 1}: ${a.passed}/${a.total} [${((Date.now() - t0) / 1000).toFixed(0)}s]` +
            (failed.length ? `  ✗ ${failed.join(", ")}` : "  ✓"));
        }
      } catch (e) {
        const timeout = /timeout|abort/i.test(e.message || "");
        runs.push({ ok: false, ms: Date.now() - t0, error: e.message, timeout });
        if (!JSON_OUT) console.log(`   run ${i + 1}: ERROR${timeout ? " (timeout)" : ""} — ${String(e.message).slice(0, 80)}`);
      }
    }
    const clean = runs.filter((r) => r.ok && r.passed === r.total).length;
    report.fixtures[fx.id] = { rate: clean / RUNS, clean, runs: RUNS, detail: runs };
  }

  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log("\n── SUMMARY ──");
    for (const [id, f] of Object.entries(report.fixtures)) {
      console.log(`${id.padEnd(14)} fully correct ${f.clean}/${f.runs}  (${(f.rate * 100).toFixed(0)}%)` +
        `${f.rate < MIN ? `  ← below --min ${MIN}` : ""}`);
    }
  }

  const worst = Math.min(...Object.values(report.fixtures).map((f) => f.rate));
  process.exit(worst < MIN ? 1 : 0);
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
