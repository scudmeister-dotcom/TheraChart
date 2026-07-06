/* Offline checker for the scanned-record import path and the history digest:
   ai.normalizeExtraction (shaping Gemini's output), insights.buildHistoryDigest
   (compressing old visits), and store.addImportedDoc (locked historical docs).
   Run: node test/import.test.js */
"use strict";

// in-memory storage shim so store.js doesn't touch disk/localStorage
const mem = {};
globalThis.THERACHART_STORAGE = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};

const ai = require("../ai.js");
const I = require("../insights.js");
const S = require("../store.js");

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) passed++;
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

/* ---------------- normalizeExtraction ---------------- */
{
  const raw = {
    patientName: "  Reyes, Juan  ",
    docDescription: "Scanned PT daily notes",
    visits: [
      { type: "daily", date: "May 12, 2023", subjective: " pain better ",
        rom: [{ side: "left", joint: "Shoulder", motion: "Flexion", degrees: 999 }],
        pain: [{ score: 15, location: "shoulder" }],
        special: [{ name: "Neer test", result: "weird" }],
        findings: [{ bodyPart: "left shoulder", side: "left", summary: "sharp pain" }, { bodyPart: "x", summary: "  " }] },
      { type: "nonsense", date: "not-a-date", subjective: "second visit" },
      { type: "eval", date: "2023-05-01", assessment: "rotator cuff strain" },
      { type: "daily" }, // fully empty → dropped
    ],
  };
  const r = ai.normalizeExtraction(raw);
  check("empty visits are dropped", r.visits.length === 3, `got ${r.visits.length}`);
  check("visits sorted chronologically, undated last",
    r.visits[0].date === "2023-05-01" && r.visits[1].date === "2023-05-12" && r.visits[2].date === "",
    JSON.stringify(r.visits.map((v) => v.date)));
  const daily = r.visits[1];
  check("loose date parsed to ISO", daily.date === "2023-05-12", daily.date);
  check("unknown type falls back to daily", r.visits[2].type === "daily");
  check("ROM degrees clamped", daily.rom[0].degrees === 360, String(daily.rom[0].degrees));
  check("ROM joint/motion lowercased", daily.rom[0].joint === "shoulder" && daily.rom[0].motion === "flexion");
  check("pain score clamped to 10", daily.pain[0].score === 10);
  check("special result coerced to positive/negative", daily.special[0].result === "positive");
  check("findings get map coordinates", daily.findings.length === 1 &&
    daily.findings[0].part === "Shoulder" && daily.findings[0].side === "left" &&
    typeof daily.findings[0].x === "number" && daily.findings[0].view === "front",
    JSON.stringify(daily.findings));
  check("empty-summary findings dropped", !daily.findings.some((f) => !f.summary));
  check("patientName/docDescription trimmed", r.patientName === "Reyes, Juan" && r.docDescription === "Scanned PT daily notes");
  check("text fields trimmed", daily.subjective === "pain better");

  // duplicate visits (same content) collapse to one
  const dup = ai.normalizeExtraction({ visits: [
    { type: "eval", date: "2023-05-01", subjective: "same" },
    { type: "eval", date: "2023-05-01", subjective: "same" },
    { type: "eval", date: "2023-05-01", subjective: "different" },
  ] });
  check("exact duplicate visits are dropped", dup.visits.length === 2, `got ${dup.visits.length}`);
}

/* ---------------- buildHistoryDigest ---------------- */
{
  check("digest of nothing is null", I.buildHistoryDigest([]) === null && I.buildHistoryDigest(null) === null);

  const mk = (date, type, deg, pain, region) => ({
    date, type,
    subjective: "s", assessment: type === "eval" ? "initial strain assessment" : "improving steadily",
    findings: region ? [{ part: region, side: "right", summary: `${region} pain` }] : [],
    measurements: { rom: deg ? [{ side: "right", joint: "shoulder", motion: "flexion", degrees: deg }] : [],
      mmt: [], special: [], pain: pain ? [{ location: "shoulder", score: pain }] : [] },
  });
  // newest-first, the order the app passes
  const older = [
    mk("2023-08-01", "progress", 150, 2, "Shoulder"),
    mk("2023-07-01", "daily", 130, 4, "Shoulder"),
    mk("2023-06-01", "daily", 110, 6, "Shoulder"),
    mk("2023-05-01", "eval", 90, 8, "Shoulder"),
  ];
  const dg = I.buildHistoryDigest(older);
  check("digest counts visits", dg.visits === 4);
  check("digest date range oldest→newest", dg.from === "2023-05-01" && dg.to === "2023-08-01", `${dg.from} → ${dg.to}`);
  check("digest type counts", dg.types.daily === 2 && dg.types.eval === 1 && dg.types.progress === 1);
  check("digest top region", dg.regions[0].region === "right shoulder" && dg.regions[0].count === 4, JSON.stringify(dg.regions));
  check("digest ROM endpoints chronological", dg.romTrends[0].first === 90 && dg.romTrends[0].last === 150, JSON.stringify(dg.romTrends));
  check("digest pain endpoints chronological", dg.pain.first === 8 && dg.pain.last === 2, JSON.stringify(dg.pain));
  check("digest keeps first eval assessment", dg.assessments.some((a) => /initial strain/.test(a.text)));

  // digest feeds the prompt
  const prompt = I.insightsPrompt({ current: { findings: [], measurements: {} }, history: [], historyDigest: dg });
  check("prompt includes digest header", /DIGEST of 4 older visits/.test(prompt), prompt.slice(-400));
  check("prompt includes digest ROM trend", /90° → 150°/.test(prompt));

  // digest feeds the local reviewer: recurrence + improving trend span the digest
  const local = I.buildInsights({
    current: { findings: [{ part: "Shoulder", side: "right", summary: "mild ache" }],
      measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 160 }], pain: [{ score: 1 }] } },
    history: [], historyDigest: dg,
  });
  check("local recurrence sees digest regions", local.connections.some((c) => /recurrent right shoulder/i.test(c.title)),
    JSON.stringify(local.connections.map((c) => c.title)));
  check("local ROM trend spans digest (90→160 improving)", local.connections.some((c) => /improving .*flexion/i.test(c.title)));
  check("local pain trend spans digest (8→1 decreasing)", local.connections.some((c) => /pain decreasing/i.test(c.title)));
}

/* ---------------- store.addImportedDoc ---------------- */
{
  S.load();
  const maria = S.getUser("u-maria"); // licensed therapist
  const ana = S.getUser("u-ana");     // front desk — cannot document
  const before = S.docsFor("p-juan").length;

  const denied = S.addImportedDoc("p-juan", { type: "daily", date: "2023-05-12", data: {} }, ana, "old.pdf");
  check("front desk cannot import documents", !!denied.error);

  const res = S.addImportedDoc("p-juan", {
    type: "daily", date: "2023-05-12",
    data: { subjective: "Pain 6/10", summary: "TherEx", rom: [{ side: "left", joint: "shoulder", motion: "flexion", degrees: 100 }] },
  }, maria, "old-records.pdf");
  check("import creates a document", !!res.doc && S.docsFor("p-juan").length === before + 1);
  check("imported doc is locked (signed)", res.doc.status === "signed");
  check("imported flag set", res.doc.imported === true);
  check("signature attests the import source", /Imported from scanned document \(old-records\.pdf\)/.test(res.doc.signatures[0].reason),
    res.doc.signatures[0].reason);
  check("createdAt matches the historical visit date", res.doc.createdAt.startsWith("2023-05-1"), res.doc.createdAt);
  check("title carries date + imported tag", /2023-05-12 \(imported\)/.test(res.doc.title), res.doc.title);
  check("doc sorts to the start of the chart chronology", S.docsFor("p-juan")[0].id === res.doc.id);
  check("imported daily counts as a visit", S.visitCount("p-juan") >= 5);
  check("audit logged", S.auditLog().some((e) => e.action === "doc-imported"));

  const undated = S.addImportedDoc("p-juan", { type: "eval", date: "", data: {} }, maria, "x.pdf");
  check("undated import gets 'undated' title and a valid createdAt",
    /undated \(imported\)/.test(undated.doc.title) && !isNaN(new Date(undated.doc.createdAt).getTime()));
  const weird = S.addImportedDoc("p-juan", { type: "bogus", date: "2023-01-01", data: {} }, maria, "x.pdf");
  check("unknown type falls back to daily", weird.doc.type === "daily");
}

console.log(failed ? `\nTheraChart import checker: ${passed} passed, ${failed} FAILED` : `TheraChart import checker: ${passed}/${passed} checks passed`);
process.exit(failed ? 1 : 0);
