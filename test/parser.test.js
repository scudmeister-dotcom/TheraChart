/* TheraChart parser checker.
   Feeds realistic physical-therapy intake transcripts through the parser and
   verifies every clinically valuable finding is captured — and that no false
   points are invented. Run: node test/parser.test.js */

"use strict";

const { parseUtterance, classifyUtterance, guessSpeaker, refineTranscript,
        correctDictation, extractMeasurements, isDenial, isPaired } = require("../parser.js");

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

const total = passed + failures.length;
console.log(`\nTheraChart parser checker: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
