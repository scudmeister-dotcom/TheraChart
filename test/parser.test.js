/* TheraChart parser checker.
   Feeds realistic physical-therapy intake transcripts through the parser and
   verifies every clinically valuable finding is captured — and that no false
   points are invented. Run: node test/parser.test.js */

"use strict";

const { parseUtterance } = require("../parser.js");

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

function labels(result) {
  return result.mentions.map((m) =>
    `${m.side ? m.side + " " : ""}${m.partName}`.toLowerCase()
  );
}

function mention(result, partName, side = undefined) {
  return result.mentions.find(
    (m) =>
      m.partName.toLowerCase() === partName.toLowerCase() &&
      (side === undefined || m.side === side)
  );
}

/* ------------------------------------------------------------------ *
 * 1. A realistic PT intake, sentence by sentence
 * ------------------------------------------------------------------ */

{
  const r = parseUtterance(
    "I've been having a sharp pain in my left shoulder for about three weeks now"
  );
  const m = mention(r, "Shoulder", "left");
  check("intake: left shoulder detected", !!m, JSON.stringify(labels(r)));
  check("intake: shoulder summary has sharp pain", m && /sharp/i.test(m.summary) && /pain/i.test(m.summary), m && m.summary);
  check("intake: shoulder duration captured", m && /three weeks/i.test(m.summary), m && m.summary);
  check("intake: shoulder is front view", m && m.view === "front");
}

{
  // "behind my back" is shoulder motion, not the back — must NOT map "back",
  // but the aggravating movement must survive as a loose follow-up.
  const r = parseUtterance("it gets worse when I reach overhead or behind my back");
  check("motion: 'behind my back' creates no point", r.mentions.length === 0, JSON.stringify(labels(r)));
  check("motion: follow-up detail kept as loose finding", !!r.loose, JSON.stringify(r.loose));
  check("motion: loose summary keeps the trigger", r.loose && /when i reach overhead/i.test(r.loose.summary), r.loose && r.loose.summary);
}

{
  // Radiating pattern must produce BOTH points.
  const r = parseUtterance(
    "the pain shoots down from my lower back into my right leg especially after sitting for a long time"
  );
  check("radiation: lower back detected", !!mention(r, "Lower back"), JSON.stringify(labels(r)));
  const leg = mention(r, "Leg", "right");
  check("radiation: right leg detected", !!leg, JSON.stringify(labels(r)));
  check("radiation: leg summary mentions shooting pain", leg && /shooting/i.test(leg.summary) && /pain/i.test(leg.summary), leg && leg.summary);
  check("radiation: lower back is back view", mention(r, "Lower back")?.view === "back");
}

{
  // Negation: a denial is recorded as a denial, never as pain.
  const r = parseUtterance("I don't have any pain in my right knee anymore");
  const m = mention(r, "Knee", "right");
  check("negation: right knee detected", !!m, JSON.stringify(labels(r)));
  check("negation: recorded as denial", m && /denies pain/i.test(m.summary), m && m.summary);
  check("negation: not recorded as positive pain", m && !/^significant|^sharp|^pain/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("I twisted my ankle playing basketball last year");
  const m = mention(r, "Ankle");
  check("history: ankle detected", !!m, JSON.stringify(labels(r)));
  check("history: twist injury captured", m && /twist injury/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("I've also been getting headaches and some stiffness in my neck");
  check("head+neck: head detected via 'headaches'", !!mention(r, "Head"), JSON.stringify(labels(r)));
  const neck = mention(r, "Neck");
  check("head+neck: neck detected", !!neck, JSON.stringify(labels(r)));
  check("head+neck: neck note leads with stiffness", neck && /^(mild |significant )?stiffness/i.test(neck.summary), neck && neck.summary);
}

{
  // Rating-only follow-up sentence, spoken numbers included.
  const r = parseUtterance("it's probably a six out of ten at night");
  check("rating: no body point invented", r.mentions.length === 0, JSON.stringify(labels(r)));
  check("rating: loose finding kept", !!r.loose);
  check("rating: spoken 'six out of ten' → 6/10", r.loose && /6\/10/.test(r.loose.summary), r.loose && r.loose.summary);
}

{
  // Everyday "back" that is not a body part.
  const r = parseUtterance("I'll be back next week, I keep coming back to that");
  check("idiom: 'be back' creates nothing", r.mentions.length === 0, JSON.stringify(labels(r)));
  check("idiom: nothing flagged for review either", r.loose === null, JSON.stringify(r.loose));
}

{
  const r = parseUtterance("my grip feels weak in my left hand");
  const m = mention(r, "Hand", "left");
  check("weakness: left hand detected", !!m, JSON.stringify(labels(r)));
  check("weakness: summary records weakness", m && /weakness/i.test(m.summary), m && m.summary);
}

{
  // Multiple denied symptoms in one breath.
  const r = parseUtterance("no numbness or tingling in my feet");
  const m = mention(r, "Foot");
  check("denial list: feet detected", !!m, JSON.stringify(labels(r)));
  check("denial list: both symptoms denied", m && /denies numbness and tingling/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("my stomach hurts after I eat");
  const m = mention(r, "Stomach");
  check("trigger: stomach pain detected", !!m && /pain/i.test(m.summary), m && m.summary);
  check("trigger: 'after I eat' captured", m && /after i eat/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("my back is killing me");
  const m = mention(r, "Back");
  check("idiom pain: 'killing me' reads as pain", !!m && /pain/i.test(m.summary), m && m.summary);
  check("idiom pain: intensity marked significant", m && /significant/i.test(m.summary), m && m.summary);
}

{
  // Compound-phrase precedence: never double-map.
  const r = parseUtterance("I have a throbbing pain in the back of my head");
  check("precedence: back of head only", labels(r).join(",") === "back of head", JSON.stringify(labels(r)));
  check("precedence: back view", mention(r, "Back of head")?.view === "back");
}

{
  const r = parseUtterance("my right shoulder blade has been aching");
  const m = mention(r, "Shoulder blade", "right");
  check("precedence: shoulder blade beats shoulder", !!m && !mention(r, "Shoulder"), JSON.stringify(labels(r)));
  check("precedence: shoulder blade is back view", m && m.view === "back");
}

{
  // Left/right must not be stolen from unrelated words ("right now").
  const r = parseUtterance("right now my knee really aches");
  const m = mention(r, "Knee");
  check("side: 'right now' does not side the knee", !!m && m.side === null, m && `side=${m.side}`);
}

{
  const r = parseUtterance("my left knee keeps buckling and feels unstable on stairs");
  const m = mention(r, "Knee", "left");
  check("instability: captured", !!m && /instability/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("I think I pulled my right hamstring while sprinting");
  const m = mention(r, "Hamstring", "right");
  check("strain: pulled hamstring detected", !!m, JSON.stringify(labels(r)));
  check("strain: possible strain recorded", m && /possible strain/i.test(m.summary), m && m.summary);
  check("strain: back view", m && m.view === "back");
}

{
  const r = parseUtterance(
    "there's numbness and tingling running down my left arm into my fingers"
  );
  const arm = mention(r, "Arm", "left");
  check("nerve: left arm detected", !!arm, JSON.stringify(labels(r)));
  check("nerve: numbness/tingling captured", arm && /numbness/i.test(arm.summary) && /tingling/i.test(arm.summary), arm && arm.summary);
  check("nerve: fingers also pointed", !!mention(r, "Finger"), JSON.stringify(labels(r)));
}

{
  // Empty / meaningless speech must be silent.
  const r = parseUtterance("um okay so yeah let me think");
  check("noise: nothing detected, nothing flagged", r.mentions.length === 0 && r.loose === null);
}

/* ------------------------------------------------------------------ *
 * 2. Whole-transcript sweep: nothing valuable may be dropped
 * ------------------------------------------------------------------ */

{
  const transcript = [
    "so it started when I slipped on the stairs about a month ago",
    "I landed on my right hip and it's been tender ever since",
    "the soreness wraps around into my groin sometimes",
    "my left wrist also took some of the fall and still clicks",
    "oh and I get this burning between my shoulder blades after a day at the desk",
  ];
  const all = transcript.map(parseUtterance);
  const found = all.flatMap(labels);
  const dropped = all
    .map((r, i) => (r.mentions.length === 0 && r.loose === null ? transcript[i] : null))
    .filter(Boolean)
    // line 1 is pure history with no symptom or body part — allowed to pass
    .filter((line) => !/started when i slipped/.test(line));

  check("sweep: right hip found", found.includes("right hip"), JSON.stringify(found));
  check("sweep: groin found", found.includes("groin"), JSON.stringify(found));
  check("sweep: left wrist found", found.includes("left wrist"), JSON.stringify(found));
  check("sweep: shoulder blade found", found.some((l) => l.includes("shoulder blade")), JSON.stringify(found));
  check("sweep: no symptom line dropped", dropped.length === 0, JSON.stringify(dropped));
}

/* ------------------------------------------------------------------ */

const total = passed + failures.length;
console.log(`\nTheraChart parser checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
