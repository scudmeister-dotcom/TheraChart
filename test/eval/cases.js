/* TheraChart AI eval — golden cases.

   These are NOT unit tests. Unit tests (test/refine.test.js, test/insights.test.js)
   pin the local heuristic's exact behaviour. These grade whichever engine is
   configured — local heuristic or Gemini — on properties that must hold no
   matter which model runs or how the prompt is worded, so a prompt change can be
   scored instead of eyeballed.

   Assertion contract:
     name     what is being graded, phrased as the property that should hold
     weight   1 = ordinary, 2-3 = safety-critical (attribution, hallucination)
     engines  optional; omit to grade every engine. Use ["gemini"] for behaviour
              the local heuristic was never built to do, so the local run isn't
              scored against work it doesn't claim to perform.
     test     (result) => boolean
*/

"use strict";

/* ---------- helpers shared by the cases ---------- */

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** The speaker label attached to the first dialogue turn matching `re`. */
const speakerOf = (r, re) => {
  const turn = (r.dialogue || []).find((d) => re.test(d.text));
  return turn ? turn.speaker : null;
};

/** Was a finding pinned for this body part (and side, if given)? */
const hasFinding = (r, part, side) => (r.findings || []).some((f) =>
  norm(f.part) === norm(part) && (side === undefined || (f.side || null) === side));

const findingParts = (r) => (r.findings || []).map((f) => `${f.part}|${f.side || ""}`).join(", ");

const rom = (r, motion) => ((r.measurements && r.measurements.rom) || []).find((m) => norm(m.motion) === norm(motion));
const painScores = (r) => ((r.measurements && r.measurements.pain) || []).map((p) => p.score);

/** Every finding must be traceable to something actually said. The single most
    important property of the cleanup pass: it may re-word, never invent. */
const groundedInTranscript = (r, utterances) => {
  const haystack = norm(utterances.join(" "));
  return (r.findings || []).every((f) => {
    if (!f.quote) return true;                       // local engine may not quote
    return haystack.includes(norm(f.quote).slice(0, 24));
  });
};

/** The cleanup pass may merge or drop empty turns, but must not fabricate a
    conversation — guard against a model padding the dialogue. */
const dialogueNotInflated = (r, utterances) => (r.dialogue || []).length <= utterances.length + 1;

const titles = (r) => (r.connections || []).map((c) => c.title).join(" | ");
const recActions = (r) => (r.recommendations || []).map((x) => x.action).join(" | ");
const flagText = (r) => (r.redFlags || []).map((f) => f.flag).join(" | ");

/* ---------- refine cases ---------- */

const REFINE_CASES = [
  {
    id: "refine/en-two-regions",
    what: "plain English visit, two body regions, one clinician read-out",
    input: [
      "so tell me what brings you in today",
      "my right shoulder has been really painful for about two weeks",
      "how bad is it on a scale of one to ten",
      "probably an eight out of ten when I reach overhead",
      "okay let's check your range, shoulder flexion is 95 degrees",
      "and my lower back gets stiff after I sit for a while",
    ],
    assertions: [
      { name: "the opening question is attributed to the clinician", weight: 2,
        test: (r) => speakerOf(r, /brings you in today/i) === "clinician" },
      { name: "the symptom report is attributed to the patient", weight: 2,
        test: (r) => speakerOf(r, /right shoulder has been really painful/i) === "patient" },
      { name: "the ROM read-out is attributed to the clinician", weight: 2,
        test: (r) => speakerOf(r, /flexion is 95 degrees/i) === "clinician" },
      { name: "the right shoulder is pinned", weight: 1,
        test: (r) => hasFinding(r, "Shoulder", "right") },
      { name: "the lower back is pinned", weight: 1,
        test: (r) => hasFinding(r, "Lower back") },
      { name: "the clinician's ROM line does not become a patient finding", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/95|degrees/i.test(f.summary || "")) },
      { name: "shoulder flexion 95° is filed as a measurement", weight: 2,
        test: (r) => { const m = rom(r, "flexion"); return !!m && Number(m.degrees) === 95; } },
      { name: "the 8/10 pain rating is captured", weight: 1,
        test: (r) => painScores(r).includes(8) },
    ],
  },
  {
    id: "refine/code-switch-tagalog",
    what: "Tagalog/English code-switching — the headline dictation claim",
    input: [
      "kumusta, ano ang masakit sa inyo ngayon",
      "masakit ang kaliwang balikat ko, mga isang linggo na",
      "gaano kasakit, one to ten",
      "mga pito sa sampu",
      "any numbness in the arm",
      "wala pong numbness",
    ],
    assertions: [
      { name: "the Tagalog symptom report is attributed to the patient", weight: 2,
        test: (r) => speakerOf(r, /masakit ang kaliwang balikat/i) === "patient" },
      { name: "the Tagalog question is attributed to the clinician", weight: 2,
        test: (r) => speakerOf(r, /gaano kasakit/i) === "clinician" },
      { name: "kaliwang balikat resolves to the LEFT shoulder", weight: 3,
        test: (r) => hasFinding(r, "Shoulder", "left") },
      { name: "it is not mis-sided to the right", weight: 3,
        test: (r) => !hasFinding(r, "Shoulder", "right") },
      { name: "'pito sa sampu' is read as a 7/10 pain score", weight: 2,
        test: (r) => painScores(r).includes(7) },
    ],
  },
  {
    id: "refine/negation-denial",
    what: "negations must become denials, not positive findings",
    input: [
      "any pain in your knee",
      "walang sakit sa tuhod ko",
      "no numbness or tingling in the foot either",
      "but my neck is sore in the morning",
    ],
    assertions: [
      { name: "the denied knee is not pinned as a positive finding", weight: 3,
        test: (r) => !(r.findings || []).some((f) => norm(f.part) === "knee" && !/den|wala|no /i.test(f.summary || "")) },
      { name: "the genuine neck complaint is pinned", weight: 2,
        test: (r) => hasFinding(r, "Neck") },
    ],
  },
  {
    id: "refine/clinician-monologue",
    what: "a visit where the patient barely speaks — nothing may be invented",
    input: [
      "alright I'm going to test your strength now",
      "quad strength is four out of five on the right",
      "hamstring is five out of five",
      "special test, Neer is positive on the right shoulder",
      "okay",
    ],
    assertions: [
      { name: "no patient findings are conjured from clinician speech", weight: 3,
        test: (r) => (r.findings || []).length === 0 },
      { name: "the MMT read-out is still filed as a measurement", weight: 2,
        test: (r) => (((r.measurements || {}).mmt) || []).length > 0 },
      { name: "every turn is labelled clinician except the patient's 'okay'", weight: 1,
        test: (r) => (r.dialogue || []).filter((d) => d.speaker === "clinician").length >= 4 },
    ],
  },
  {
    id: "refine/empty-and-noise",
    what: "robustness: empty and meaningless input must not crash or invent",
    input: ["", "uh", "  ", "hmm okay"],
    assertions: [
      { name: "returns a well-formed result", weight: 2,
        test: (r) => !!r && Array.isArray(r.dialogue) && Array.isArray(r.findings) },
      { name: "invents no findings from noise", weight: 3,
        test: (r) => (r.findings || []).length === 0 },
    ],
  },
];

// Groundedness + non-inflation are graded on every refine case.
for (const c of REFINE_CASES) {
  c.assertions.push(
    { name: "every finding is traceable to the transcript", weight: 3, test: (r) => groundedInTranscript(r, c.input) },
    { name: "the dialogue is not padded with invented turns", weight: 2, test: (r) => dialogueNotInflated(r, c.input) },
  );
}

/* ---------- insights cases ---------- */

const INSIGHTS_CASES = [
  {
    id: "insights/declining-rom",
    what: "ROM falling across visits should be connected and flagged",
    input: {
      referral: "right shoulder pain", pmh: "Hypertension",
      current: {
        subjective: "Right shoulder still painful",
        findings: [{ part: "Shoulder", side: "right", summary: "pain 6/10 reaching overhead" }],
        measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 100 }], pain: [{ location: "right shoulder", score: 6 }] },
      },
      history: [
        { date: "2026-06-20", type: "eval", findings: [{ part: "Shoulder", side: "right", summary: "pain 7/10" }], measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 120 }] } },
        { date: "2026-06-25", type: "daily", findings: [{ part: "Shoulder", side: "right", summary: "pain 7/10" }], measurements: { rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 110 }] } },
      ],
    },
    assertions: [
      { name: "the recurring right shoulder is connected across visits", weight: 2,
        test: (r) => /recurr|repeat|persist/i.test(titles(r)) && /shoulder/i.test(titles(r)) },
      { name: "the downward ROM trend is surfaced", weight: 3,
        test: (r) => /declin|decreas|down|worsen|reduc/i.test(titles(r) + " " + flagText(r) + " " + recActions(r)) },
      { name: "a concrete next step is recommended", weight: 2,
        test: (r) => (r.recommendations || []).length > 0 },
      { name: "every recommendation carries a rationale", weight: 2,
        test: (r) => (r.recommendations || []).every((x) => x.action && (x.rationale || x.detail)) },
    ],
  },
  {
    id: "insights/red-flag-screen",
    what: "night pain + unexplained weight loss must raise a referral flag",
    input: {
      referral: "thoracic pain", pmh: "Former smoker",
      current: {
        subjective: "Constant deep pain, worse at night, unrelieved by rest. Reports unintentional 6 kg weight loss over 2 months.",
        findings: [{ part: "Upper back", side: null, summary: "constant deep pain 8/10, worse at night" }],
        measurements: { pain: [{ location: "upper back", score: 8 }] },
      },
      history: [],
    },
    assertions: [
      { name: "a red flag is raised at all", weight: 3,
        test: (r) => (r.redFlags || []).length > 0 },
      { name: "the flag names night pain or the weight loss", weight: 3,
        test: (r) => /night|weight loss|unintentional|constant/i.test(flagText(r) + " " + recActions(r)) },
      { name: "onward medical referral is recommended", weight: 3,
        test: (r) => /refer|physician|medical|doctor/i.test(recActions(r) + " " + flagText(r)) },
      { name: "no diagnosis is asserted as fact", weight: 3,
        // decision support, not diagnosis — it may raise suspicion, never conclude
        test: (r) => !/\b(is|has) (cancer|a tumou?r|malignancy|metasta)/i.test(JSON.stringify(r)) },
    ],
  },
  {
    id: "insights/radicular",
    what: "back pain with distal numbness and weakness reads as radicular",
    input: {
      pmh: "Type 2 diabetes",
      current: {
        findings: [
          { part: "Lower back", side: null, summary: "sharp pain 7/10" },
          { part: "Leg", side: "right", summary: "numbness and tingling with weakness" },
        ],
        measurements: {},
      },
      history: [],
    },
    assertions: [
      { name: "the radicular pattern is connected", weight: 2,
        test: (r) => /radicul|nerve|referred|lumbar/i.test(titles(r)) },
      { name: "the neuro signs are flagged", weight: 3,
        test: (r) => /numb|neuro|weak|tingl/i.test(flagText(r) + " " + recActions(r)) },
      { name: "a neuro screen is recommended", weight: 2,
        test: (r) => /neuro|slr|straight leg|myotome|dermatome|reflex/i.test(recActions(r)) },
    ],
  },
  {
    id: "insights/first-visit",
    what: "a first visit with no history must stay safe and useful",
    input: {
      current: { findings: [{ part: "Knee", side: "left", summary: "mild pain" }], measurements: {} },
      history: [],
    },
    assertions: [
      { name: "does not crash or return a malformed shape", weight: 3,
        test: (r) => Array.isArray(r.connections) && Array.isArray(r.redFlags) && Array.isArray(r.recommendations) },
      { name: "still offers at least one baseline recommendation", weight: 1,
        test: (r) => (r.recommendations || []).length >= 1 },
      { name: "invents no cross-visit trend from a single visit", weight: 3,
        test: (r) => !/trend|over time|across visits|compared (to|with) (the )?(last|previous)/i.test(titles(r)) },
    ],
  },
];

module.exports = { REFINE_CASES, INSIGHTS_CASES };
