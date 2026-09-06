/* TheraChart parser checker.
   Feeds realistic physical-therapy intake transcripts through the parser and
   verifies every clinically valuable finding is captured — and that no false
   points are invented. Run: node test/parser.test.js */

"use strict";

const { parseUtterance, classifyUtterance, guessSpeaker, refineTranscript,
        correctDictation, extractMeasurements, isDenial, isPaired,
        aggregateMeasurements } = require("../parser.js");

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

{
  // Tagalog/Cebuano pain ratings. README advertises "pito sa sampu" alongside
  // "7 out of 10", but only the English numerals were in the lexicon, so the
  // Filipino form scored nothing at all.
  const score = (s) => { const p = parseUtterance(s).measurements.pain; return p.length ? p[0].score : null; };
  check("'pito sa sampu' → 7/10", score("mga pito sa sampu ang sakit") === 7, String(score("mga pito sa sampu ang sakit")));
  check("'walo sa sampu' → 8/10", score("walo sa sampu") === 8, String(score("walo sa sampu")));
  check("'tatlo sa sampu' → 3/10", score("tatlo sa sampu") === 3, String(score("tatlo sa sampu")));
  check("Cebuano 'lima sa napulo' → 5/10", score("lima sa napulo") === 5, String(score("lima sa napulo")));
  check("English ratings still work", score("seven out of ten") === 7 && score("6/10") === 6);
}

{
  // Special tests are dictated in both word orders. Only "positive Neer test"
  // parsed, so "Neer is positive" was missed — and a missed test meant the
  // clinician's read-out was scored as PATIENT speech and pinned to the body map.
  const r1 = parseUtterance("special test, Neer is positive on the right shoulder");
  check("'Neer is positive' parses as a special test", r1.measurements.special.length === 1, JSON.stringify(r1.measurements.special));
  check("'Neer is positive' captures the result", (r1.measurements.special[0] || {}).result === "positive", JSON.stringify(r1.measurements.special));
  const r2 = parseUtterance("the Hawkins test was positive");
  check("'Hawkins test was positive' parses", r2.measurements.special.length === 1, JSON.stringify(r2.measurements.special));
  check("reversed order does not drop the article into the name",
    !/^The\b/i.test(((r2.measurements.special[0] || {}).name) || ""), JSON.stringify(r2.measurements.special));
  const r3 = parseUtterance("positive Neer test on the right");
  check("original word order still parses", r3.measurements.special.length === 1, JSON.stringify(r3.measurements.special));
  check("a test read-out is attributed to the clinician",
    guessSpeaker("special test, Neer is positive on the right shoulder") === "clinician");
  check("'I am going to…' is attributed to the clinician",
    guessSpeaker("alright I am going to test your strength now") === "clinician");
  // ordinary prose must not become a clinical finding
  const r4 = parseUtterance("she said the news from the doctor is positive");
  check("prose 'is positive' is not read as a special test", r4.measurements.special.length === 0, JSON.stringify(r4.measurements.special));
}

{
  // The whole point of the two-pass design: a clinician-only stretch must not
  // put pins on the body map.
  const r = refineTranscript([
    "alright I am going to test your strength now",
    "quad strength is four out of five on the right",
    "special test, Neer is positive on the right shoulder",
  ]);
  check("clinician-only dictation pins nothing", r.findings.length === 0,
    JSON.stringify(r.findings.map((f) => `${f.part}|${f.side || ""}`)));
  check("clinician-only dictation is all clinician turns",
    r.dialogue.every((d) => d.speaker === "clinician"), JSON.stringify(r.dialogue.map((d) => d.speaker)));
}

/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * 1c-bis. Measurements as a therapist actually dictates them
 *
 * The joint is stated ONCE and then a run of motions follows, usually with
 * the unit dropped after the first: "right shoulder abduction 90 degrees,
 * external rotation 45, flexion 120". Requiring a joint and a unit on every
 * motion meant only the first number of a run was ever recorded — three
 * measurements spoken, one filed, and no error to say so.
 * ------------------------------------------------------------------ */

{
  const r = parseUtterance("right shoulder abduction 90 degrees, external rotation 45, flexion 120");
  const rom = r.measurements.rom;
  check("run of motions: all three are captured", rom.length === 3, JSON.stringify(rom));
  check("run of motions: every one inherits the joint",
    rom.every((x) => x.joint === "shoulder"), JSON.stringify(rom));
  check("run of motions: every one inherits the side",
    rom.every((x) => x.side === "right"), JSON.stringify(rom));
  check("run of motions: degrees are right",
    JSON.stringify(rom.map((x) => x.degrees)) === "[90,45,120]", JSON.stringify(rom));
  check("run of motions: motions are right",
    JSON.stringify(rom.map((x) => x.motion)) === '["abduction","external rotation","flexion"]',
    JSON.stringify(rom));
}

{
  const r = parseUtterance("left knee flexion 130 degrees, extension 5");
  check("a small trailing value is still a measurement",
    r.measurements.rom.length === 2 && r.measurements.rom[1].degrees === 5,
    JSON.stringify(r.measurements.rom));
}

{
  const r = parseUtterance("shoulder ER 45 degrees and IR 60 degrees");
  const motions = r.measurements.rom.map((x) => x.motion);
  check("spoken abbreviations expand to full motion names",
    JSON.stringify(motions) === '["external rotation","internal rotation"]', JSON.stringify(motions));
}

{
  const r = parseUtterance("both shoulders flexion 150 degrees, abduction 140");
  const rom = r.measurements.rom;
  check("a plural joint is recognised", rom.length === 4, JSON.stringify(rom));
  check("'both' still splits into left and right",
    rom.filter((x) => x.side === "left").length === 2 && rom.filter((x) => x.side === "right").length === 2,
    JSON.stringify(rom));
}

/* The guards. A number near a motion word is only an angle in the right
   company — otherwise the parser would invent measurements out of prose. */
{
  const r = parseUtterance("abduction is 90 degrees");
  check("a motion with no joint anywhere is dropped, not guessed",
    r.measurements.rom.length === 0, JSON.stringify(r.measurements.rom));
}
{
  const r = parseUtterance("knee flexion 4 out of 5");
  check("a muscle grade is not read as an angle", r.measurements.rom.length === 0, JSON.stringify(r.measurements.rom));
  check("…it is read as MMT instead", r.measurements.mmt.length === 1, JSON.stringify(r.measurements.mmt));
}
{
  const r = parseUtterance("patient did abduction exercises, 3 sets of 10");
  check("prose near a motion word does not become a measurement",
    r.measurements.rom.length === 0, JSON.stringify(r.measurements.rom));
}
{
  const r = parseUtterance("shoulder flexion 120 degrees then we did abduction work for 3 minutes");
  const rom = r.measurements.rom;
  check("the unitless pass does not swallow unrelated numbers",
    rom.length === 1 && rom[0].degrees === 120, JSON.stringify(rom));
}

/* A comma between the motion and its value — the shape the refine pass writes
   ("right ankle dorsiflexion is limited, about ten degrees" comes back
   punctuated) and the shape a therapist types. Every one of these dropped the
   angle entirely, silently: the transcript held the number, the chart did not,
   and nothing on screen said a measurement had been spoken. */
{
  const romOf = (t) => parseUtterance(t).measurements.rom;

  const flex = romOf("Knee flexion, 130 degrees");
  check("a comma before the value still reads as a measurement",
    flex.length === 1 && flex[0].joint === "knee" && flex[0].motion === "flexion" && flex[0].degrees === 130,
    JSON.stringify(flex));

  const abd = romOf("Shoulder abduction, 110 degrees");
  check("…for the joint-first form too",
    abd.length === 1 && abd[0].joint === "shoulder" && abd[0].motion === "abduction" && abd[0].degrees === 110,
    JSON.stringify(abd));

  // the visit that exposed this: Chirp 2 heard it correctly, the refine pass
  // punctuated it, and the ROM row never reached the chart
  const ankle = romOf("Right ankle dorsiflexion is limited, about 10 degrees");
  check("a comma in the middle of the filler run does not stop it",
    ankle.length === 1 && ankle[0].side === "right" && ankle[0].joint === "ankle"
      && ankle[0].motion === "dorsiflexion" && ankle[0].degrees === 10,
    JSON.stringify(ankle));

  const abbrev = romOf("R ankle DF limited, 10 deg");
  check("the abbreviated form reads across the comma as well",
    abbrev.length === 1 && abbrev[0].joint === "ankle" && abbrev[0].motion === "dorsiflexion"
      && abbrev[0].degrees === 10,
    JSON.stringify(abbrev));

  const stacked = romOf("Right shoulder abduction is, approximately, 90 degrees");
  check("filler set off by commas on both sides is still filler",
    stacked.length === 1 && stacked[0].degrees === 90, JSON.stringify(stacked));

  // motion first, joint after it — the comma lands between them
  const listed = romOf("Dorsiflexion, right ankle, 10 degrees");
  check("a comma between the motion and the joint after it is read",
    listed.length === 1 && listed[0].side === "right" && listed[0].joint === "ankle"
      && listed[0].motion === "dorsiflexion" && listed[0].degrees === 10,
    JSON.stringify(listed));

  const linked = romOf("Flexion of the right knee, 120 degrees");
  check("…and after the linker form as well",
    linked.length === 1 && linked[0].side === "right" && linked[0].joint === "knee" && linked[0].degrees === 120,
    JSON.stringify(linked));

  // the rest of what a reading carries has to survive the comma too
  const trail = romOf("Knee extension, 5 degrees, on the right");
  check("a trailing side is still read past the value's comma",
    trail.length === 1 && trail[0].side === "right" && trail[0].degrees === 5, JSON.stringify(trail));

  const bilat = romOf("Knee flexion, 130 degrees bilaterally");
  check("'bilaterally' still splits a comma form into both sides",
    bilat.length === 2 && bilat.every((x) => x.degrees === 130)
      && bilat.map((x) => x.side).sort().join() === "left,right",
    JSON.stringify(bilat));

  const arom = romOf("AROM shoulder flexion, 120 degrees");
  check("the active/passive qualifier still governs a comma form",
    arom.length === 1 && arom[0].quality === "active", JSON.stringify(arom));

  const tall = romOf("Knee flexion, 200 degrees");
  check("an impossible angle is still rejected past a comma",
    tall.length === 0, JSON.stringify(tall));
}

/* The comma must not become a licence to reach into the NEXT clause. A comma
   between a motion and its own value is punctuation; a comma between two
   clauses is a boundary, and a number on the far side of it belongs to
   whatever the speaker turned to. */
{
  const romOf = (t) => parseUtterance(t).measurements.rom;

  check("a clause that changes subject at the comma keeps its own number",
    romOf("shoulder flexion is fine, knee is 90 degrees").length === 0,
    JSON.stringify(romOf("shoulder flexion is fine, knee is 90 degrees")));

  /* MMT_RE joins the words before the grade with \\s+ the same way ROM_FILLER
     did, so this grade is not read as a muscle grade either — a separate gap,
     left alone here. What matters for ROM is that the 5 is not filed as an
     angle. */
  const grade = parseUtterance("knee flexion is good, 5 out of 5");
  check("a muscle grade after a comma is not an angle",
    grade.measurements.rom.length === 0, JSON.stringify(grade.measurements.rom));

  const both = romOf("Right knee flexion is 130 degrees, extension is 5 degrees");
  check("the run form is unchanged by all of this",
    both.length === 2 && both[1].motion === "extension" && both[1].degrees === 5
      && both.every((x) => x.side === "right" && x.joint === "knee"),
    JSON.stringify(both));

  /* The unitless pass deliberately does NOT cross a comma: with the unit gone
     there is nothing to say the number is an angle, and "3 sets of 10" sits in
     exactly the same shape. Inventing an angle is worse than dropping one. */
  const reps = romOf("we worked on knee flexion, 3 sets of 10 reps, and shoulder flexion 120 degrees");
  check("a rep count after a comma does not become an angle",
    reps.length === 1 && reps[0].joint === "shoulder" && reps[0].degrees === 120, JSON.stringify(reps));

  /* "er" is both an abbreviation and a hesitation. Reading the hesitation
     would file the right number under a motion nobody measured, so the
     abbreviation does not reach across a comma for its value. */
  check("a hesitation before the value is not read as external rotation",
    romOf("Right shoulder flexion is, er, 130 degrees").length === 0,
    JSON.stringify(romOf("Right shoulder flexion is, er, 130 degrees")));
  const er = romOf("right shoulder abduction 90 degrees, ER 45");
  check("…and the spoken abbreviation still reads when the value follows it",
    er.length === 2 && er[1].motion === "external rotation" && er[1].degrees === 45, JSON.stringify(er));
}

/* THE SIGN ON A ROM READING.
   "Extension is negative five degrees" is a flexion contracture. "Extension is
   five degrees" is hyperextension — the opposite finding, and the sentence
   reads perfectly either way, so nothing on the review screen gives the
   therapist a reason to look twice. The pattern had no way to capture a sign,
   which dropped the reading whenever the word survived transcription and filed
   the wrong direction whenever it did not. */
{
  const forms = [
    ["knee extension is negative 5 degrees", "the spoken word"],
    ["knee extension is minus 5 degrees", "\"minus\""],
    ["knee extension is -5 degrees", "the typed symbol"],
  ];
  for (const [said, how] of forms) {
    const rom = parseUtterance(said).measurements.rom;
    check(`a negative angle is kept — ${how}`,
      rom.length === 1 && rom[0].degrees === -5, JSON.stringify(rom));
  }
}
{
  // the line from the voice run, exactly as Chirp 2 punctuates it: the sign
  // rides the unitless pass, where the therapist stated "degrees" only once
  const rom = parseUtterance("right knee flexion is 130 degrees, extension is negative 5").measurements.rom;
  check("the dictated line files a contracture, not a hyperextension",
    rom.length === 2 && rom[0].degrees === 130 && rom[1].degrees === -5, JSON.stringify(rom));
  check("…and both readings keep the side that was stated once",
    rom.every((x) => x.side === "right" && x.joint === "knee"), JSON.stringify(rom));
}
{
  // the other direction still means what it always did — the sign is read, not applied
  const rom = parseUtterance("knee extension is 5 degrees").measurements.rom;
  check("an unsigned angle stays positive",
    rom.length === 1 && rom[0].degrees === 5, JSON.stringify(rom));
}
{
  // the floor mirrors the 180° ceiling: no contracture is 120° deep
  const rom = parseUtterance("knee extension is negative 120 degrees").measurements.rom;
  check("an implausible negative is rejected like an implausible positive",
    rom.length === 0, JSON.stringify(rom));
}
{
  /* A hyphen is punctuation far more often than it is a minus. A range and a
     dash-as-separator must not come back as negative angles. */
  const range = parseUtterance("shoulder flexion 120-130 degrees").measurements.rom;
  check("a range is not read as a negative angle",
    range.every((x) => x.degrees >= 0), JSON.stringify(range));
  const dash = parseUtterance("shoulder flexion - 120 degrees").measurements.rom;
  check("a spaced dash is not read as a minus",
    dash.every((x) => x.degrees >= 0), JSON.stringify(dash));
}

/* MMT: the side is the point of measuring it, and the muscle is often named
   after the grade in Taglish word order. */
{
  const r = parseUtterance("deltoid strength is 4 out of 5 on the right");
  const mmt = r.measurements.mmt;
  check("a trailing side is attached to the grade",
    mmt.length === 1 && mmt[0].side === "right", JSON.stringify(mmt));
  check("…and the muscle is kept", mmt[0] && mmt[0].context === "deltoid", JSON.stringify(mmt));
}
{
  const r = parseUtterance("right deltoid strength 4/5");
  check("a leading side is attached to the grade",
    r.measurements.mmt[0] && r.measurements.mmt[0].side === "right", JSON.stringify(r.measurements.mmt));
}
{
  const r = parseUtterance("strength 4 over 5 sa deltoid");
  const mmt = r.measurements.mmt;
  check("'4 over 5' is a grade", mmt.length === 1 && mmt[0].grade === "4/5", JSON.stringify(mmt));
  check("a muscle named after the grade is captured",
    mmt[0] && mmt[0].context === "deltoid", JSON.stringify(mmt));
}
{
  const r = parseUtterance("quad strength is 5 out of 5 and she reports pain");
  check("trailing prose is not filed as a muscle",
    r.measurements.mmt[0] && r.measurements.mmt[0].context === "quad",
    JSON.stringify(r.measurements.mmt));
}
{
  const r = parseUtterance("she has 4 out of 5 kids at home");
  check("an unrelated 'out of 5' is still not a muscle grade",
    r.measurements.mmt.length === 0, JSON.stringify(r.measurements.mmt));
}

/* The refine pass punctuates dictated speech, so the pause a therapist takes
   between the muscle and the grade comes back as a comma. It used to stop the
   words before the grade from being read at all, and the grade went with them:
   a spoken "deltoid strength, four out of five" reached the chart with no MMT
   row and nothing on screen to say a number had been said. */
{
  // the comma form must read exactly the same as the same words without it
  const reading = (text) => {
    const m = parseUtterance(text).measurements.mmt;
    return m.length === 1 ? `${m[0].context}|${m[0].grade}|${m[0].side}` : JSON.stringify(m);
  };
  for (const [comma, plain] of [
    ["deltoid strength, 4 out of 5", "deltoid strength 4 out of 5"],
    ["deltoid strength, four out of five", "deltoid strength four out of five"],
    ["knee flexion is good, 5 out of 5", "knee flexion is good 5 out of 5"],
    ["right deltoid strength, 4/5", "right deltoid strength 4/5"],
    ["grip strength is, 5 out of 5", "grip strength is 5 out of 5"],
    ["lakas ng quad, apat sa lima", "lakas ng quad apat sa lima"],   // tl
  ]) {
    check(`a comma before the grade reads the same as none: "${comma}"`,
      reading(comma) === reading(plain), `${reading(comma)} vs ${reading(plain)}`);
  }
  check("the comma form still keeps the muscle and the grade",
    reading("deltoid strength, 4 out of 5") === "deltoid|4/5|null",
    reading("deltoid strength, 4 out of 5"));
  // a therapist reels several muscles off in one comma-separated run
  const run = parseUtterance("quad strength 4 out of 5, hamstring strength, 3 out of 5").measurements.mmt;
  check("every grade in a comma-separated run is kept",
    run.length === 2 && run[0].context === "quad" && run[1].context === "hamstring",
    JSON.stringify(run));
}
/* The comma may only be crossed by the grade itself. Letting the muscle reach
   further would invent a grade out of an ordinary sentence. */
{
  check("the muscle is not read across a clause boundary",
    parseUtterance("her knee, she has 5 out of 5 kids").measurements.mmt.length === 0,
    JSON.stringify(parseUtterance("her knee, she has 5 out of 5 kids").measurements.mmt));
  check("two pain ratings in one line are still not muscle grades",
    parseUtterance("my neck is a 3 out of 10 but my shoulder is an 8 out of 10").measurements.mmt.length === 0,
    JSON.stringify(parseUtterance("my neck is a 3 out of 10 but my shoulder is an 8 out of 10").measurements.mmt));
  const r = parseUtterance("quad strength is 4 out of 5");
  check("and the plain form is untouched",
    r.measurements.mmt.length === 1 && r.measurements.mmt[0].context === "quad"
      && r.measurements.mmt[0].grade === "4/5", JSON.stringify(r.measurements.mmt));
}

/* The whole utterance from the live Vertex run that exposed all of this. */
{
  const r = parseUtterance("right shoulder abduction 90 degrees, external rotation 45, deltoid strength 4 over 5");
  check("the reported dictation yields 2 ROM + 1 MMT",
    r.measurements.rom.length === 2 && r.measurements.mmt.length === 1,
    JSON.stringify(r.measurements));
  check("…with the side carried onto the muscle grade too",
    r.measurements.mmt[0] && r.measurements.mmt[0].side === "right",
    JSON.stringify(r.measurements.mmt));
}

/* ------------------------------------------------------------------ *
 * Head-to-toe anatomy sweep.
 *
 * A patient saying "butt" got nothing on the chart, because the lexicon only
 * knew "buttock" and "glutes". Nobody notices a region that silently isn't
 * there — it just looks like the patient never mentioned it. This walks the
 * body in the words patients actually use, so the next gap fails a test
 * instead of a visit.
 * ------------------------------------------------------------------ */
{
  const ANATOMY = [
    // head & face
    ["my scalp is itchy", "Scalp"], ["my forehead is tight", "Forehead"],
    ["my temples throb", "Temple"], ["my left eye twitches", "Eye"],
    ["my right ear aches", "Ear"], ["my nose is blocked", "Nose"],
    ["my cheek is numb", "Cheek"], ["my chin is sore", "Chin"],
    ["my jaw clicks", "Jaw"], ["my teeth hurt", "Mouth"],
    ["my head is pounding", "Head"], ["my throat is sore", "Throat"],
    // neck & shoulder girdle
    ["my neck is stiff", "Neck"], ["cervical pain since the accident", "Neck"],
    ["the nape of my neck aches", "Back of neck"], ["the back of my head hurts", "Back of head"],
    ["my upper traps are tight", "Trapezius"], ["my left shoulder blade aches", "Shoulder blade"],
    ["my collarbone is tender", "Collarbone"], ["my armpit hurts", "Armpit"],
    ["my right shoulder is painful", "Shoulder"], ["my AC joint is tender", "Shoulder"],
    // trunk
    ["my chest feels tight", "Chest"], ["my breast is tender", "Breast"],
    ["my ribs hurt when I breathe", "Ribs"], ["my flank is sore", "Flank"],
    ["my stomach hurts", "Stomach"], ["my obliques are strained", "Stomach"],
    ["my navel area is sore", "Navel"], ["my pelvis feels unstable", "Pelvis"],
    ["my groin is pulled", "Groin"], ["my pelvic floor is weak", "Pelvic floor"],
    ["my perineum is sore", "Pelvic floor"],
    ["my right hip clicks", "Hip"], ["my hip flexors are tight", "Hip"],
    // arms
    ["my upper arm aches", "Upper arm"], ["my elbow is sore", "Elbow"],
    ["golfers elbow on the left", "Elbow"], ["my forearm burns", "Forearm"],
    ["my wrist is stiff", "Wrist"], ["carpal tunnel symptoms", "Wrist"],
    ["my thumb is numb", "Thumb"], ["my index finger tingles", "Finger"],
    ["my hand cramps", "Hand"], ["my arm feels heavy", "Arm"],
    // back & pelvis
    ["my upper back aches", "Upper back"], ["my mid back is stiff", "Mid back"],
    ["my lower back is in spasm", "Lower back"], ["my spine feels crooked", "Spine"],
    ["my sacrum is tender", "Sacrum"], ["my SI joint hurts", "SI joint"],
    ["my tailbone hurts", "Tailbone"],
    ["my butt is sore", "Buttock"], ["my bottom hurts when I sit", "Buttock"],
    ["my glutes are weak", "Buttock"],
    // legs
    ["my hamstring is tight", "Hamstring"], ["my IT band is tight", "IT band"],
    ["my thigh burns", "Thigh"], ["my inner thigh is pulled", "Groin"],
    ["my kneecap grinds", "Kneecap"], ["my knee gives way", "Knee"],
    ["my meniscus tore", "Knee"], ["my shin hurts", "Shin"],
    ["shin splints again", "Shin"], ["my calf cramps", "Calf"],
    ["my achilles is sore", "Achilles"], ["my heel hurts in the morning", "Heel"],
    ["my ankle rolled", "Ankle"], ["my foot is numb", "Foot"],
    ["plantar fascia pain", "Foot"], ["my big toe is swollen", "Toe"],
    ["my leg is weak", "Leg"],
  ];
  const missed = ANATOMY.filter(([phrase, part]) =>
    !parseUtterance(phrase).mentions.some((m) => m.partName === part));
  check(`anatomy sweep: all ${ANATOMY.length} regions are reachable`,
    missed.length === 0, missed.map(([p, w]) => `"${p}" → ${w}`).join("; "));
}

/* Words that look anatomical but are not the region, and must stay out. */
{
  check("'belly button' is the navel, not the buttock",
    labels(parseUtterance("I pressed my belly button and it hurt")).join() === "navel",
    JSON.stringify(labels(parseUtterance("I pressed my belly button and it hurt"))));
  check("'bottom of my foot' is the foot, not the buttock",
    labels(parseUtterance("the bottom of my foot burns")).join() === "foot",
    JSON.stringify(labels(parseUtterance("the bottom of my foot burns"))));
  check("'breast bone' is still the sternum",
    labels(parseUtterance("my breast bone is sore")).join() === "chest",
    JSON.stringify(labels(parseUtterance("my breast bone is sore"))));
}

/* Sidedness, however the patient phrases it. "the left side of my butt" is
   the exact shape that used to land unsided. */
{
  const sideOf = (s, part) => (mention(parseUtterance(s), part) || {}).side;
  check("side: 'the left side of my butt'", sideOf("the left side of my butt is painful", "Buttock") === "left");
  check("side: 'my butt on the right side'", sideOf("my butt on the right side hurts", "Buttock") === "right");
  check("side: 'tennis elbow on the right'", sideOf("tennis elbow on the right", "Elbow") === "right");
  check("side: 'my shoulder, on the left,'", sideOf("my shoulder, on the left, has been aching", "Shoulder") === "left");
  check("side: 'right now' still doesn't side the knee", sideOf("my knee right now is fine", "Knee") === null);
  /* The written shorthand a typed note uses. A bare letter is only a side
     with the part right behind it — over an anatomy word at the most. */
  check("side: 'R shoulder' is the shorthand for right", sideOf("R shoulder is sore", "Shoulder") === "right");
  check("side: 'L lateral knee' reaches over the anatomy word", sideOf("L lateral knee pain", "Knee") === "left");
  check("side: an initial before a part is not a side", sideOf("assessed by R Cruz, knee pain", "Knee") === null);
  check("side: 'L5' is a spinal level, not a left", sideOf("L5-S1 disc, pain down the leg", "Leg") === null);
  const both = parseUtterance("both butt cheeks are tight").mentions.map((m) => m.side).sort();
  check("side: 'both butt cheeks' pins each side", both.join() === "left,right", JSON.stringify(both));
}

/* One region named twice in one breath is one pin, and it keeps the side. */
{
  const r = parseUtterance("plantar fasciitis in my left foot");
  check("no duplicate sideless pin beside the sided one",
    r.mentions.length === 1 && r.mentions[0].side === "left",
    JSON.stringify(labels(r)));
}


/* ------------------------------------------------------------------ *
 * Measurements: the numbers a therapist reads out loud
 * ------------------------------------------------------------------ *
   Three silent losses lived here, and every one of them threw away the
   single most useful part of the reading. A ROM angle with no side on it
   cannot show a left/right difference, which is most of why it is measured.
   A strength grade counted in Filipino was not a grade at all. And only the
   first pain rating in a line was read, so "my neck is a 3 out of 10 but my
   shoulder is an 8 out of 10" charted the 3 and dropped the 8. */

const meas = (t) => parseUtterance(t).measurements;

{
  // ROM: the side is as often stated AFTER the number as before it
  for (const [text, side] of [
    ["knee flexion is 110 degrees on the right", "right"],
    ["shoulder flexion 95 degrees on the left", "left"],
    ["shoulder flexion 100 degrees sa kanan", "right"],       // tl
    ["knee flexion 110 degrees sa tuo", "right"],             // ceb
    ["knee flexion 110 degrees sa kaliwa", "left"],           // tl
    ["right knee flexion is 110 degrees", "right"],           // leading still wins
  ]) {
    const r = meas(text).rom;
    check(`rom side: ${text}`, r.length === 1 && r[0].side === side, JSON.stringify(r));
  }

  /* Bare "kaliwa" had no spelling in the side vocabulary while bare "kanan"
     accidentally did, so laterality was lost on one side of the body only. */
  for (const [text, want] of [
    ["masakit ang kaliwa kong tuhod", "left knee"],
    ["masakit ang kanan kong tuhod", "right knee"],
    ["sakit sa kaliwa nga tuhod", "left knee"],
  ]) {
    const r = parseUtterance(text);
    check(`bare side word: ${text}`, labels(r).join() === want, JSON.stringify(labels(r)));
  }
  check("bare 'pareho' still means both sides",
    labels(parseUtterance("pareho ang tuhod ko masakit")).sort().join() === "left knee,right knee",
    JSON.stringify(labels(parseUtterance("pareho ang tuhod ko masakit"))));
  // …without turning the Tagalog negation "wala" into a left side
  for (const text of ["walang sakit ang tuhod ko", "wala akong problema sa balikat"]) {
    check(`'wala' as a negation is not a side: ${text}`,
      parseUtterance(text).mentions.every((m) => m.side === null),
      JSON.stringify(labels(parseUtterance(text))));
  }

  // "bilaterally" is how it is actually dictated; it means both readings
  const bi = meas("knee flexion 130 degrees bilaterally").rom;
  check("rom: 'bilaterally' records both sides",
    bi.length === 2 && bi.map((x) => x.side).sort().join(",") === "left,right", JSON.stringify(bi));

  /* A trailing "right" is as often a discourse marker as a side — the
     connector is what makes it anatomy. */
  const disc = meas("knee flexion 110 degrees, right, let's move on").rom;
  check("rom: a trailing discourse 'right' is not a side",
    disc.length === 1 && disc[0].side === null, JSON.stringify(disc));

  /* "R knee" is how a typed note spells laterality, and the single letter was
     no side at all: the angle reached the chart unsided, where it cannot join
     the per-side trend it was measured for. */
  for (const [text, side] of [
    ["R ankle dorsiflexion 10 degrees", "right"],
    ["L knee flexion 120 degrees", "left"],
    ["r hip flexion 100 degrees", "right"],             // typed in lower case
    ["flexion of the L knee 120 degrees", "left"],      // motion stated first
  ]) {
    const r = meas(text).rom;
    check(`rom side abbrev: ${text}`, r.length === 1 && r[0].side === side, JSON.stringify(r));
  }
  /* "L" is not a prefix of "left", so read as a spelled-out word it would
     default to the RIGHT side — the opposite reading, which is worse in a
     chart than the missing one. */
  check("rom: 'L' reads as left, not as the right-hand default",
    meas("L knee flexion 120 degrees").rom[0].side === "left");
  // an abbreviated side governs the run that follows it, like a spelled-out one
  const abbrRun = meas("R shoulder abduction 90 degrees, ER 45, flexion 120").rom;
  check("rom: an abbreviated side carries down the run",
    abbrRun.length === 3 && abbrRun.every((x) => x.side === "right"), JSON.stringify(abbrRun));

  /* A bare letter is an initial, a spinal level and a discourse marker at
     least as often as it is a side, so it only counts with a joint behind
     it — never on its own, and never trailing the number. */
  for (const text of [
    "L5 radiculopathy, knee flexion 120 degrees",
    "seen by R. Cruz, knee flexion 120 degrees",
    "knee flexion 120 degrees, R, let's move on",
  ]) {
    const r = meas(text).rom;
    check(`rom: a bare letter with no joint behind it is not a side: ${text}`,
      r.length === 1 && r[0].side === null, JSON.stringify(r));
  }
}

{
  // MMT: the grade gets spoken in whichever language the therapist counts in
  for (const [text, grade] of [
    ["quad strength four out of five", "4/5"],
    ["quad strength 4 out of 5", "4/5"],
    ["lakas ng quad apat sa lima", "4/5"],        // tl
    ["quad strength upat sa lima", "4/5"],        // ceb
    ["grip strength lima sa lima", "5/5"],
  ]) {
    const r = meas(text).mmt;
    check(`mmt: ${text}`, r.length === 1 && r[0].grade === grade, JSON.stringify(r));
  }
  check("mmt: the Filipino linker is not filed as the muscle",
    meas("lakas ng quad apat sa lima").mmt[0].context === "quad",
    JSON.stringify(meas("lakas ng quad apat sa lima").mmt));
  check("mmt: a trailing Cebuano side is read",
    meas("hamstring strength tulo sa lima sa tuo").mmt[0].side === "right",
    JSON.stringify(meas("hamstring strength tulo sa lima sa tuo").mmt));
  /* The same shorthand on a grade. Unread, the letter was not just a lost
     side — it was filed as part of the muscle's name ("R deltoid"). */
  const abbrMmt = meas("R deltoid strength is 4 out of 5").mmt;
  check("mmt: an abbreviated side is read, and is not left in the muscle name",
    abbrMmt.length === 1 && abbrMmt[0].side === "right" && abbrMmt[0].context === "deltoid",
    JSON.stringify(abbrMmt));
  // the context guard still holds — not every "out of 5" is a muscle grade
  check("mmt: '5 out of 5 kids' is not a strength grade",
    meas("he has 5 out of 5 kids").mmt.length === 0);
}

{
  // Pain: every rating in the line, each on the region it was said about
  const two = meas("my neck is 3 out of 10 but my shoulder is 8 out of 10").pain;
  check("pain: both ratings in one line are captured",
    two.length === 2, JSON.stringify(two));
  check("pain: each rating lands on its own region",
    two.some((p) => p.score === 3 && p.location === "neck")
    && two.some((p) => p.score === 8 && p.location === "shoulder"), JSON.stringify(two));

  /* The second half of a two-sided report elides the body part. Filing the
     four against the LEFT knee is worse than not filing it at all. */
  const sided = meas("left knee is a seven out of ten and the right is a four out of ten").pain;
  check("pain: an elided second side re-sides the rating",
    sided.some((p) => p.score === 7 && p.location === "left knee")
    && sided.some((p) => p.score === 4 && p.location === "right knee"), JSON.stringify(sided));

  const tl = meas("masakit ang kaliwang balikat, mga pito sa sampu, tapos ang tuhod ko mga tatlo sa sampu").pain;
  check("pain: two Tagalog ratings, two regions",
    tl.some((p) => p.score === 7 && p.location === "left shoulder")
    && tl.some((p) => p.score === 3 && p.location === "knee"), JSON.stringify(tl));

  // 0/10 is a real reading, not an absent one — it belongs in the chart
  check("pain: 'zero out of ten' is charted as a zero",
    meas("no pain in the knee, zero out of ten").pain.some((p) => p.score === 0),
    JSON.stringify(meas("no pain in the knee, zero out of ten").pain));
}

/* ------------------------------------------------------------------ *
 * Worked examples, caught live instead of only in the cleanup pass
 * ------------------------------------------------------------------ *
   "For example, you could say my right arm is in a lot of pain" is a
   demonstration of the software, not a complaint. The marker is spoken
   BEFORE the region, so the live pass has everything it needs to decline the
   pin at the moment it hears it — rather than pinning an arm and waiting for
   the cleanup pass to take it back off the chart. */
{
  const demo = parseUtterance("for example you could say my right arm is in a lot of pain");
  check("demo: the illustrated arm is not pinned", demo.mentions.length === 0, JSON.stringify(labels(demo)));
  check("demo: it is recorded as not the patient's", demo.notMine.length === 1, JSON.stringify(demo.notMine));
  check("demo: and no loose signal leaks onto the last pin", demo.loose === null, JSON.stringify(demo.loose));

  /* An example ends at its clause. Suppressing the rest of the sentence
     would throw away a real complaint, which is the worse error. */
  for (const [text, want] of [
    ["kunwari masakit ang balikat ko pero talaga masakit ang kanang tuhod ko", "right knee"],
    ["for instance my knee. but really my neck is the problem", "neck"],
    ["halimbawa po, masakit ang tuhod. pero ang totoo, ang balikat ko po", "shoulder"],
  ]) {
    const r = parseUtterance(text);
    check(`demo: the real complaint after the example survives — ${want}`,
      labels(r).length === 1 && labels(r)[0] === want, JSON.stringify(labels(r)));
  }

  /* "Something like" is how people describe real symptoms. It is in the
     transcript-trimming vocabulary but deliberately NOT in the live one:
     dropping a pin is destructive in a way that dropping a line is not. */
  const real = parseUtterance("it feels something like burning in my left foot");
  check("demo: 'something like' still pins a real symptom",
    labels(real).join() === "left foot", JSON.stringify(labels(real)));
}

/* A loose signal attaches to whatever was pinned last, so an idiom carrying a
   symptom word used to append the price of the medicine to the shoulder. */
{
  const idiom = parseUtterance("masakit sa bulsa ang gamot");
  check("idiom: 'masakit sa bulsa' leaves no loose signal",
    idiom.mentions.length === 0 && idiom.loose === null, JSON.stringify(idiom.loose));
  const still = parseUtterance("it is about a six out of ten at night");
  check("idiom: a genuine follow-up still produces a loose signal",
    !!still.loose, JSON.stringify(still.loose));
}

/* ---------------------------------------------------------------- *
 *  Speech-recognition repair
 *
 *  Every rule here rewrites a word, so the checks that matter most are the
 *  ones proving it DOESN'T: each wrong reading is a real English word
 *  somewhere else, and a correction that fires on the ordinary sentence is
 *  worse than the mis-transcription it was meant to fix.
 * ---------------------------------------------------------------- */

{
  const fix = (t) => correctDictation(t).text;

  // MMT — Kim's field test
  check("MPT next to a muscle grade is MMT", fix("MPT quad strength 4 out of 5") === "MMT quad strength 4 out of 5");
  check("MPT with a slashed grade is MMT", fix("MPT 4/5 on the right") === "MMT 4/5 on the right");
  check("the spelled-out letters are MMT too", fix("em pee tee grade 3 out of 5").startsWith("MMT"));
  check("MPT as a credential is left alone",
    fix("She was seen by Ana Cruz, MPT, last week") === "She was seen by Ana Cruz, MPT, last week");
  check("MPT with no grade in sight is left alone",
    fix("referred by the MPT at the other branch") === "referred by the MPT at the other branch");

  // AROM / PROM
  check("a mis-split AROM is put back together", fix("a rom shoulder flexion 120 degrees") === "AROM shoulder flexion 120 degrees");
  check("a hyphenated one too", fix("a-rom knee extension 5 degrees") === "AROM knee extension 5 degrees");
  check("p rom is PROM", fix("p rom knee flexion 130 degrees") === "PROM knee flexion 130 degrees");
  check("prom becomes PROM only where the motion is passive",
    fix("passive prom knee flexion 130") === "passive PROM knee flexion 130");
  check("the school dance survives", fix("she is going to her prom on Friday") === "she is going to her prom on Friday");
  check("an ordinary promise survives", fix("I promise to do the exercises") === "I promise to do the exercises");

  // therex / HEP
  check("split therex is rejoined", fix("we did there exercises today") === "we did therex today");
  check("HEP is recovered where a programme is reviewed",
    /\bHEP\b/.test(fix("reviewed help, compliance is good")));
  check("somebody needing help still needs help",
    fix("the patient needs help getting off the plinth") === "the patient needs help getting off the plinth");

  // the reported fix list — a silent correction is one nobody can disagree with
  const r = correctDictation("MPT quad strength 4 out of 5");
  check("a correction reports what it changed", r.fixes.length === 1 && r.fixes[0].to === "MMT", JSON.stringify(r.fixes));
  check("an untouched line reports nothing", correctDictation("shoulder flexion 120 degrees").fixes.length === 0);
  check("empty and junk input never throw",
    correctDictation("").text === "" && correctDictation(null).text === "" && correctDictation(undefined).fixes.length === 0);

  /* THE REGRESSION BASELINE. Measurement strings were the one part of
     dictation Kim's field test reported as already working, so nothing above
     may touch them. */
  const baselines = [
    "abduction 90 degrees, external rotation 45",
    "shoulder flexion measured at 130 degrees",
    "quad strength 4 out of 5",
    "pain 7 out of 10",
    "positive Neer test",
    "masakit ang kaliwang balikat ko",
  ];
  check("measurement dictation passes through untouched",
    baselines.every((b) => fix(b) === b), JSON.stringify(baselines.filter((b) => fix(b) !== b)));
}

/* ---------------------------------------------------------------- *
 *  Active vs passive range of motion
 * ---------------------------------------------------------------- */

{
  const rom = (t) => extractMeasurements(correctDictation(t).text).rom;

  const active = rom("AROM right shoulder flexion 120 degrees");
  check("AROM records the reading as active", active.length === 1 && active[0].quality === "active", JSON.stringify(active));
  check("…and keeps the joint, side and angle", active[0].joint === "shoulder" && active[0].side === "right" && active[0].degrees === 120);

  const passive = rom("passive knee flexion 130 degrees");
  check("passive records the reading as passive", passive[0].quality === "passive", JSON.stringify(passive));

  check("an unqualified reading is left unqualified",
    rom("shoulder flexion 120 degrees")[0].quality === undefined);

  // the qualifier governs the run that follows it, like the joint does
  const run = rom("AROM shoulder flexion 120 degrees, external rotation 45");
  check("the qualifier carries down a run of motions",
    run.length === 2 && run.every((r) => r.quality === "active"), JSON.stringify(run));

  // …and stops at the next one
  const both = rom("a rom shoulder flexion 120 degrees then PROM flexion 155 degrees");
  check("a second qualifier takes over from the first",
    both.length === 2 && both[0].quality === "active" && both[1].quality === "passive", JSON.stringify(both));
  check("active and passive readings of one motion stay two findings",
    both[0].degrees === 120 && both[1].degrees === 155);
}

/* ---- pertinent negatives are not places on the body ----

   Caught by the voice eval (test/voice), which spoke "walang numbness, walang
   tingling" into the real chain: the note documented the denial correctly AND
   pinned a finding on the leg for it. A marker on the chart reads like a
   symptom the patient has, and this one is the opposite.

   The refine prompt asks for denials deliberately, so nothing here deletes
   them — isDenial only decides whether the review offers the row ticked. That
   is why the second block matters as much as the first: a false positive is a
   real complaint the therapist has to tick back on. */
{
  const denial = (s) => isDenial(s);

  check("a plain denial is recognised", denial("Denies radiating numbness or tingling"));
  check("the exact summary the model produced is recognised",
    denial("Denies numbness or tingling radiating down the lower extremities"));
  check("a third-person relay is recognised", denial("pt denies numbness"));
  check("an absence phrased with 'no' is recognised", denial("No pain in the right knee"));
  check("'negative for' is recognised", denial("Negative for numbness"));
  check("Tagalog negation is recognised", denial("Walang numbness o tingling sa binti"));
  check("Cebuano negation is recognised", denial("Walay sakit sa tuong tuhod"));

  check("an ordinary complaint is left alone", !denial("Sharp left shoulder pain 7/10, worse overhead"));
  check("a complaint that MENTIONS an absence is still a complaint",
    !denial("Sharp pain, but no numbness"));
  check("'not tolerating' is a problem, not a denial", !denial("Not tolerating the exercises well"));
  check("a word merely starting with 'no' is not a denial", !denial("Nocturnal pain in the left shoulder"));
  check("an empty summary is not a denial", !denial(""));
}

/* ---- which regions have a left and a right ----

   Read off the body map rather than a list, so it cannot drift from what the
   figure draws. It decides whether the review asks "which side?" about a
   finding that arrived without one — which is how a Cebuano visit reaches the
   screen after Chirp 2 drops "tuo". Asking about the neck would be noise; not
   asking about a knee would be the bug. */
{
  for (const part of ["Knee", "Shoulder", "Ankle", "Hip", "Elbow", "Wrist"]) {
    check(`${part} is paired, so a missing side is worth asking about`, isPaired(part));
  }
  for (const part of ["Lower back", "Neck", "Head", "Abdomen"]) {
    check(`${part} is midline, so the review must not ask which side`, !isPaired(part));
  }
  check("an unknown region does not claim to be paired", !isPaired("Zorkle"));
  check("an empty name does not claim to be paired", !isPaired(""));
}

/* ---------------------------------------------------------------- *
 *  A bare number answering a scale question
 *
 *    "Gaano po kasakit, kung isa hanggang sampu?"  —  "Mga pito po."
 *
 *  The scale lives in the clinician's turn and the answer carries only the
 *  number, so nothing used to link them. This is NOT a missing-numerals
 *  problem — "pito sa sampu" has always scored — it is the scale being one
 *  turn away, which is why "about a seven" fails in English the same way.
 *  Caught by test/voice (shoulder/tagalog-heavy): the transcript came back at
 *  3.4% word error and the chart still recorded no pain score at all.
 *
 *  The false-positive checks below are the more important half. A bare number
 *  is the most ambiguous token in a clinical transcript, and a wrong pain
 *  score is worse than a missing one.
 * ---------------------------------------------------------------- */

{
  const pain = (turns) => aggregateMeasurements(turns).pain;
  const score = (turns) => (pain(turns)[0] || {}).score ?? null;
  const ASK_TL = "Gaano po kasakit, kung isa hanggang sampu?";
  const ASK_EN = "How bad is it, from one to ten?";
  const ASK_CEB = "Kung isa hangtod napulo, unsa ka sakit?";
  const ASK_TL_SHOULDER = "Gaano po kasakit ang kanang balikat, kung isa hanggang sampu?";

  // the answers the eval caught, in the three languages a PH clinic hears
  check("scale: 'Mga pito po' answers a Tagalog scale question",
    score([ASK_TL, "Mga pito po."]) === 7, JSON.stringify(pain([ASK_TL, "Mga pito po."])));
  check("scale: the same answer in digits",
    score([ASK_TL, "Mga 7 po."]) === 7, JSON.stringify(pain([ASK_TL, "Mga 7 po."])));
  check("scale: 'About a seven' answers the English one",
    score([ASK_EN, "About a seven."]) === 7, JSON.stringify(pain([ASK_EN, "About a seven."])));
  check("scale: 'Maybe a 6' too",
    score([ASK_EN, "Maybe a 6."]) === 6, JSON.stringify(pain([ASK_EN, "Maybe a 6."])));
  check("scale: the Cebuano question is understood",
    score([ASK_CEB, "Mga pito."]) === 7, JSON.stringify(pain([ASK_CEB, "Mga pito."])));
  check("scale: 'on a scale of ten' opens one as well",
    score(["On a scale of ten, how bad?", "Siguro anim po."]) === 6,
    JSON.stringify(pain(["On a scale of ten, how bad?", "Siguro anim po."])));

  // an acknowledgement can sit between the question and the answer
  check("scale: an 'Opo' in between does not close the scale",
    score([ASK_TL, "Opo.", "Mga pito po."]) === 7, JSON.stringify(pain([ASK_TL, "Opo.", "Mga pito po."])));

  // question and answer in ONE turn — parseUtterance can see this much alone
  const sameTurn = parseUtterance("gaano po kasakit kung isa hanggang sampu mga pito po");
  check("scale: question and answer in the same turn",
    (sameTurn.measurements.pain[0] || {}).score === 7, JSON.stringify(sameTurn.measurements.pain));
  const sameTurnEn = parseUtterance("how bad from one to ten about a seven");
  check("scale: same turn, in English",
    (sameTurnEn.measurements.pain[0] || {}).score === 7, JSON.stringify(sameTurnEn.measurements.pain));
  const sided = parseUtterance("gaano kasakit ang kanang balikat, kung isa hanggang sampu, mga pito po");
  check("scale: a region named in the question keeps the score located",
    (sided.measurements.pain[0] || {}).location === "right shoulder", JSON.stringify(sided.measurements.pain));

  // the forms that already worked must keep working
  for (const [text, want] of [["pito sa sampu", 7], ["seven out of ten", 7], ["7/10", 7]]) {
    check(`scale: "${text}" still scores without any question`,
      (parseUtterance(text).measurements.pain[0] || {}).score === want,
      JSON.stringify(parseUtterance(text).measurements.pain));
  }

  /* ---- the guards ---- */

  // a bare number on its own is still nothing at all
  check("scale: a bare number nobody asked for is not a rating",
    parseUtterance("mga pito po").measurements.pain.length === 0);
  check("scale: and not across a conversation that never named a scale",
    pain(["Kumusta po kayo?", "Mga pito po."]).length === 0,
    JSON.stringify(pain(["Kumusta po kayo?", "Mga pito po."])));
  check("scale: the scale does not stay open all visit",
    pain([ASK_TL, "Opo.", "Sige po.", "Ano po ulit?", "Mga pito po."]).length === 0,
    JSON.stringify(pain([ASK_TL, "Opo.", "Sige po.", "Ano po ulit?", "Mga pito po."])));

  // numbers that mean something else, all spoken while a scale is open
  for (const [answer, why] of [
    ["Shoulder flexion 120 degrees, abduction 90.", "ROM degrees"],
    ["Knee flexion 10 degrees lang po.", "a ROM reading inside 0-10"],
    ["Deltoid strength is four out of five.", "an MMT grade"],
    ["Grade 4 lang po ang lakas.", "a spoken grade"],
    ["Mga tatlong araw na po.", "a duration in Tagalog"],
    ["For three weeks now.", "a duration in English"],
    ["I am 8 years old.", "an age"],
    ["This is my 5th visit.", "a visit count"],
    ["Three times a week po.", "a frequency"],
    ["On 6/10 nagsimula po.", "a date"],
    ["I walk about 5 blocks and it starts hurting.", "a number inside a sentence"],
    ["Umiinom po ako ng 2 tablets.", "a dose"],
  ]) {
    check(`scale: ${why} is not read as a pain rating`,
      pain([ASK_TL, answer]).length === 0, `${answer} → ${JSON.stringify(pain([ASK_TL, answer]))}`);
  }
  // the readings themselves must survive the turn they were spoken in
  const run = aggregateMeasurements([ASK_TL, "Shoulder flexion 120 degrees, abduction 90."]);
  check("scale: the measurement run is still recorded in full",
    run.rom.length === 2 && run.pain.length === 0, JSON.stringify(run));
  const grade = aggregateMeasurements([ASK_TL, "Deltoid strength is four out of five."]);
  check("scale: the MMT grade is still recorded", grade.mmt.length === 1 && grade.pain.length === 0, JSON.stringify(grade));

  // counting to ten is not asking for a rating
  check("scale: 'one to ten minutes' opens no scale",
    pain(["I warm up for one to ten minutes.", "Mga pito po."]).length === 0,
    JSON.stringify(pain(["I warm up for one to ten minutes.", "Mga pito po."])));

  /* ---- end to end ---- */

  const visit = refineTranscript([
    "Masakit po ang kanang balikat ko.",
    "Gaano po kasakit, kung isa hanggang sampu?",
    "Mga pito po.",
  ]);
  check("scale: the answering turn is not trimmed away as three empty words",
    (visit.dialogue.find((d) => /pito/i.test(d.text)) || {}).keep === true,
    JSON.stringify(visit.dialogue));
  check("scale: the visit records the score",
    visit.measurements.pain.some((x) => x.score === 7), JSON.stringify(visit.measurements.pain));

  /* ---- the answer inherits the region the question named ---- */

  // null is a real answer here — "scored, but nowhere" — so it must not read
  // the same as "no score at all"
  const at = (turns) => { const first = pain(turns)[0]; return first ? first.location : "(no score)"; };

  check("scale: the answer is filed against the region the question named",
    at(["Gaano po kasakit ang kanang balikat ninyo, kung isa hanggang sampu?", "Mga pito po."]) === "right shoulder",
    at(["Gaano po kasakit ang kanang balikat ninyo, kung isa hanggang sampu?", "Mga pito po."]));
  check("scale: in English too",
    at(["How bad is your left knee, from one to ten?", "About a seven."]) === "left knee",
    at(["How bad is your left knee, from one to ten?", "About a seven."]));
  check("scale: and in Cebuano",
    at(["Pila ka sakit ang imong tuong tuhod, kung isa hangtod napulo?", "Mga unom."]) === "right knee",
    at(["Pila ka sakit ang imong tuong tuhod, kung isa hangtod napulo?", "Mga unom."]));
  check("scale: the region survives an acknowledgement in between",
    at([ASK_TL_SHOULDER, "Opo.", "Mga pito po."]) === "right shoulder",
    at([ASK_TL_SHOULDER, "Opo.", "Mga pito po."]));
  check("scale: an answer that states the scale in full inherits it as well",
    at([ASK_TL_SHOULDER, "Pito sa sampu po."]) === "right shoulder",
    at([ASK_TL_SHOULDER, "Pito sa sampu po."]));

  /* The two ways this must NOT put a number on the wrong body part. */
  check("scale: a question that named nothing leaves the score unlocated",
    at([ASK_TL, "Mga pito po."]) === null, at([ASK_TL, "Mga pito po."]));
  check("scale: a question sweeping two regions guesses at neither",
    at(["Gaano kasakit ang balikat o ang leeg, kung isa hanggang sampu?", "Mga pito po."]) === null,
    at(["Gaano kasakit ang balikat o ang leeg, kung isa hanggang sampu?", "Mga pito po."]));
  check("scale: a patient who answers about somewhere else is taken at their word",
    at([ASK_TL_SHOULDER, "Yung likod ko naman, siyam sa sampu."]) === "back",
    at([ASK_TL_SHOULDER, "Yung likod ko naman, siyam sa sampu."]));

  /* The answer turn names no region — the question did — so the score files
     unlocated. Where the same score was also recorded against a region, the
     two are one report and the table must not show it twice. */
  const twice = aggregateMeasurements([
    "Masakit po ang kanang balikat ko, pito sa sampu.",
    "Gaano po kasakit, kung isa hanggang sampu?",
    "Mga pito po.",
  ]);
  check("scale: the answer adds no second, region-less row",
    twice.pain.length === 1 && twice.pain[0].location === "right shoulder", JSON.stringify(twice.pain));
}

const total = passed + failures.length;
console.log(`\nTheraChart parser checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
