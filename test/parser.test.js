/* TheraChart parser checker.
   Feeds realistic physical-therapy intake transcripts through the parser and
   verifies every clinically valuable finding is captured — and that no false
   points are invented. Run: node test/parser.test.js */

"use strict";

const { parseUtterance, classifyUtterance } = require("../parser.js");

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
 * 1b. Tagalog & Cebuano (code-switching is normal in clinic speech)
 * ------------------------------------------------------------------ */

{
  const r = parseUtterance("masakit ang kaliwang balikat ko simula noong isang linggo");
  const m = mention(r, "Shoulder", "left");
  check("tl: kaliwang balikat → left shoulder", !!m, JSON.stringify(labels(r)));
  check("tl: masakit reads as pain", m && /pain/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("sobrang sakit ng tuhod ko kapag umaakyat ako ng hagdan");
  const m = mention(r, "Knee");
  check("tl: tuhod → knee", !!m, JSON.stringify(labels(r)));
  check("tl: sobrang → significant", m && /significant/i.test(m.summary), m && m.summary);
  check("tl: kapag trigger captured", m && /kapag/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("namamaga at manhid ang kanang kamay niya");
  const m = mention(r, "Hand", "right");
  check("tl: kanang kamay → right hand", !!m, JSON.stringify(labels(r)));
  check("tl: namamaga/manhid → swelling + numbness", m && /swelling/i.test(m.summary) && /numbness/i.test(m.summary), m && m.summary);
}

{
  // Tagalog negation: walang = none/no — must be a denial, not left side of a symptom
  const r = parseUtterance("walang sakit ang kanang tuhod niya ngayon");
  const m = mention(r, "Knee", "right");
  check("tl: right knee detected under negation", !!m, JSON.stringify(labels(r)));
  check("tl: walang sakit → denies pain", m && /denies pain/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("grabe ang ngutngut sa akong likod");
  const m = mention(r, "Back");
  check("ceb: likod → back", !!m, JSON.stringify(labels(r)));
  check("ceb: ngutngut → throbbing pain", m && /pain/i.test(m.summary), m && m.summary);
  check("ceb: grabe → significant", m && /significant/i.test(m.summary), m && m.summary);
}

{
  const r = parseUtterance("sakit akong tuo nga abaga ug naluya akong bukton");
  const m = mention(r, "Shoulder", "right");
  check("ceb: tuo nga abaga → right shoulder", !!m, JSON.stringify(labels(r)));
  const arm = mention(r, "Arm");
  check("ceb: bukton → arm with weakness", !!arm && /weakness/i.test(arm.summary), arm && arm.summary);
}

{
  const r = parseUtterance("nabinhod ang wala nga kamot sa pasyente");
  const m = mention(r, "Hand", "left");
  check("ceb: wala nga kamot → left hand", !!m, JSON.stringify(labels(r)));
  check("ceb: nabinhod → numbness", m && /numbness/i.test(m.summary), m && m.summary);
}

/* ------------------------------------------------------------------ *
 * 1c. Clinical measurements
 * ------------------------------------------------------------------ */

{
  const r = parseUtterance("left shoulder flexion measured at 120 degrees today");
  const rom = r.measurements.rom;
  check("rom: one measurement", rom.length === 1, JSON.stringify(rom));
  check("rom: side/joint/motion/degrees", rom[0] && rom[0].side === "left" && rom[0].joint === "shoulder" && rom[0].motion === "flexion" && rom[0].degrees === 120, JSON.stringify(rom[0]));
}

{
  const r = parseUtterance("knee extension is limited to 10 degrees and hip abduction to 30 degrees");
  check("rom: two measurements in one breath", r.measurements.rom.length === 2, JSON.stringify(r.measurements.rom));
}

{
  const r = parseUtterance("quad strength is 4 out of 5 on the right");
  const mmt = r.measurements.mmt;
  check("mmt: grade captured", mmt.length === 1 && mmt[0].grade === "4/5", JSON.stringify(mmt));
  check("mmt: context kept", mmt[0] && /quad/i.test(mmt[0].context || ""), JSON.stringify(mmt[0]));
}

{
  const r = parseUtterance("pain is about 7 out of 10 in the left shoulder");
  const pain = r.measurements.pain;
  check("pain measure: score 7", pain.length === 1 && pain[0].score === 7, JSON.stringify(pain));
  check("pain measure: located to left shoulder", pain[0] && pain[0].location === "left shoulder", JSON.stringify(pain[0]));
  check("pain measure: not mistaken for MMT", r.measurements.mmt.length === 0, JSON.stringify(r.measurements.mmt));
}

{
  const r = parseUtterance("positive Neer test and negative drop arm test on the left shoulder");
  const sp = r.measurements.special;
  check("special: two tests captured", sp.length === 2, JSON.stringify(sp));
  check("special: results kept", sp[0] && sp[0].result === "positive" && sp[1] && sp[1].result === "negative", JSON.stringify(sp));
}

/* ------------------------------------------------------------------ *
 * 1d. Section classifier (evaluations / progress notes)
 * ------------------------------------------------------------------ */

{
  const cls = (t) => {
    const r = parseUtterance(t);
    return classifyUtterance(r.text, r, r.measurements);
  };
  check("classify: precautions", cls("precaution no lifting over 10 pounds") === "precautions");
  check("classify: reason for referral", cls("she was referred by Dr Cruz for shoulder pain") === "reason");
  check("classify: past medical history", cls("history of diabetes and hypertension, surgery two years ago") === "pmh");
  check("classify: assessment", cls("findings are consistent with subacromial impingement") === "assessment");
  check("classify: objective when measured", cls("shoulder flexion at 95 degrees") === "objective");
  check("classify: subjective by default", cls("my knee hurts when I climb stairs") === "subjective");
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

/* ------------------------------------------------------------------ *
 * Edge cases from the 2026-07 dictation stress test
 * ------------------------------------------------------------------ */

{
  // a rating after a denial belongs to the OTHER body part
  const r = parseUtterance("no pain in the neck, but the shoulder is a 7 out of 10");
  const neck = mention(r, "Neck");
  const sh = mention(r, "Shoulder");
  check("denial+rating: neck stays denied", neck && /denies pain/i.test(neck.summary), neck && neck.summary);
  check("denial+rating: shoulder not denied", sh && !/denies/i.test(sh.summary), sh && sh.summary);
  check("denial+rating: pain located to shoulder", r.measurements.pain[0] && r.measurements.pain[0].location === "shoulder", JSON.stringify(r.measurements.pain));
}

{
  // hyperbole caps at the top of the scale
  const r = parseUtterance("the pain is 11 out of 10 in my lower back");
  check("11/10 capped to 10", r.measurements.pain[0] && r.measurements.pain[0].score === 10, JSON.stringify(r.measurements.pain));
}

{
  // "on 6/10" is a date, not a rating; "6/10/25" too
  const r1 = parseUtterance("on 6/10 he reported pain in the wrist");
  const r2 = parseUtterance("seen on 6/10/25, pain is 4 out of 10 in the knee");
  check("date on 6/10 not a rating", r1.measurements.pain.length === 0, JSON.stringify(r1.measurements.pain));
  check("full date skipped, real rating kept", r2.measurements.pain.length === 1 && r2.measurements.pain[0].score === 4, JSON.stringify(r2.measurements.pain));
}

{
  // "5 out of 5 kids" is not a muscle grade; real MMT still works
  const r1 = parseUtterance("he is 5 out of 5 kids and has knee pain");
  const r2 = parseUtterance("biceps 4 out of 5 on the left");
  check("kids not MMT", r1.measurements.mmt.length === 0, JSON.stringify(r1.measurements.mmt));
  check("kids sentence stays subjective", classifyUtterance(r1.text, r1, r1.measurements) === "subjective");
  check("biceps 4/5 still MMT", r2.measurements.mmt.length === 1 && r2.measurements.mmt[0].grade === "4/5", JSON.stringify(r2.measurements.mmt));
}

{
  // implausible ROM (>180°) rejected as a mis-transcription
  const r = parseUtterance("knee flexion 200 degrees");
  check("ROM over 180 rejected", r.measurements.rom.length === 0, JSON.stringify(r.measurements.rom));
}

{
  // "back pain" / "low back pain" without a possessive
  const r1 = parseUtterance("presenting with back pain and stiffness");
  const r2 = parseUtterance("chronic low back pain for years");
  check("'back pain' pins the back", !!mention(r1, "Back"), JSON.stringify(labels(r1)));
  check("'low back pain' pins the lower back", !!mention(r2, "Lower back"), JSON.stringify(labels(r2)));
}

{
  // both/bilateral expands to two pins
  const r1 = parseUtterance("pain in both knees, worse on the left");
  const r2 = parseUtterance("bilateral shoulder tightness");
  check("both knees → left + right", !!mention(r1, "Knee", "left") && !!mention(r1, "Knee", "right"), JSON.stringify(labels(r1)));
  check("bilateral shoulders → left + right", !!mention(r2, "Shoulder", "left") && !!mention(r2, "Shoulder", "right"), JSON.stringify(labels(r2)));
}

{
  // a family member's injury is not the patient's finding
  const r = parseUtterance("my daughter broke her arm last year; my elbow is what hurts");
  check("daughter's arm not pinned", !mention(r, "Arm"), JSON.stringify(labels(r)));
  check("patient's elbow kept", !!mention(r, "Elbow") && /pain/i.test(mention(r, "Elbow").summary), JSON.stringify(labels(r)));
}

{
  // reassurance is not a complaint
  const r = parseUtterance("my own knee is fine, no pain");
  const m = mention(r, "Knee");
  check("'knee is fine' reads as fine", m && /feeling fine/i.test(m.summary), m && m.summary);
}

{
  // body parts inside special-test names are vocabulary, not complaints
  const r = parseUtterance("positive straight leg raise test on the left, pain is 6 out of 10 in the lower back");
  check("SLR does not pin the leg", !mention(r, "Leg"), JSON.stringify(labels(r)));
  check("SLR still recorded as a test", r.measurements.special.length === 1 && /straight leg raise/i.test(r.measurements.special[0].name), JSON.stringify(r.measurements.special));
  check("SLR: pain still located to lower back", r.measurements.pain[0] && r.measurements.pain[0].location === "lower back", JSON.stringify(r.measurements.pain));
}

{
  // emotional "heart" idiom is not a cardiac pin
  const r = parseUtterance("my heart wasn't in it but I did my exercises, shoulder feels tight");
  check("heart idiom not pinned", !mention(r, "Heart"), JSON.stringify(labels(r)));
  check("real complaint kept", !!mention(r, "Shoulder"), JSON.stringify(labels(r)));
}

{
  // symptoms must not leak across a contrast clause
  const r = parseUtterance("it's about a six out of ten in the wrist and ibuprofen helps a bit but my neck is also stiff");
  const neck = mention(r, "Neck");
  check("clause break: rating stays off the neck", neck && !/6\/10/.test(neck.summary), neck && neck.summary);
  check("clause break: rating located to wrist", r.measurements.pain[0] && r.measurements.pain[0].location === "wrist", JSON.stringify(r.measurements.pain));
}

{
  // pathological repetition collapses to one mention per finding
  const r = parseUtterance("my knee hurts and my shoulder aches. ".repeat(50));
  check("repeated text deduplicated", r.mentions.length <= 4, `${r.mentions.length} mentions`);
}

{
  // "blood pressure" is vitals, not a pressure symptom
  const r = parseUtterance("blood pressure was 120 over 80, knee pain 3 out of 10");
  const m = mention(r, "Knee");
  check("blood pressure not a symptom", m && !/pressure/i.test(m.summary), m && m.summary);
}

{
  // cloud STT (chirp) spells small numbers out — word numerals must parse
  const r1 = parseUtterance("deltoid strength four out of five");
  const r2 = parseUtterance("quad strength four plus out of five");
  check("chirp: 'four out of five' → MMT 4/5", r1.measurements.mmt.length === 1 && r1.measurements.mmt[0].grade === "4/5", JSON.stringify(r1.measurements.mmt));
  check("chirp: 'four plus out of five' → MMT 4+/5", r2.measurements.mmt.length === 1 && r2.measurements.mmt[0].grade === "4+/5", JSON.stringify(r2.measurements.mmt));
}

{
  // "zero out of ten" is a real (resolved-pain) rating, not a dropped one
  const r = parseUtterance("the knee pain is zero out of ten today");
  check("'zero out of ten' → pain 0/10", r.measurements.pain.length === 1 && r.measurements.pain[0].score === 0, JSON.stringify(r.measurements.pain));
  const m = mention(r, "Knee");
  check("'zero out of ten' rated in summary", m && /rated 0\/10/.test(m.summary), m && m.summary);
}

/* ------------------------------------------------------------------ */

const total = passed + failures.length;
console.log(`\nTheraChart parser checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
