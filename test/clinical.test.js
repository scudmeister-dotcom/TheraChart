/* TheraChart clinical-rules checker — the service catalogue and its
   subtotal, the legacy 8-minute rule, outcome measure trending against MCID,
   and goal target dates.
   Run: node test/clinical.test.js */

"use strict";
const C = require("../clinical.js");

let passed = 0;
const failures = [];
const check = (n, c, d) => { if (c) passed += 1; else failures.push(`✗ ${n}${d ? `\n    ${d}` : ""}`); };

/* ---------------------------------------------------------------- *
 *  8-minute rule
 * ---------------------------------------------------------------- */

check("under 8 timed minutes bills nothing", C.unitsForMinutes(7) === 0);
check("8 minutes is the first unit", C.unitsForMinutes(8) === 1);
check("22 minutes is still one unit", C.unitsForMinutes(22) === 1);
check("23 minutes tips into two units", C.unitsForMinutes(23) === 2);
check("37 minutes is two units", C.unitsForMinutes(37) === 2);
check("38 minutes is three units", C.unitsForMinutes(38) === 3);
check("53 minutes is four units", C.unitsForMinutes(53) === 4);
check("68 minutes is five units", C.unitsForMinutes(68) === 5);
check("zero and junk minutes bill nothing",
  C.unitsForMinutes(0) === 0 && C.unitsForMinutes(null) === 0 && C.unitsForMinutes("x") === 0);

{
  const r = C.minutesForUnits(2);
  check("two units span 23–37 minutes", r.min === 23 && r.max === 37, JSON.stringify(r));
  const one = C.minutesForUnits(1);
  check("one unit spans 8–22 minutes", one.min === 8 && one.max === 22, JSON.stringify(one));
}

/* ---------------------------------------------------------------- *
 *  Billing summary
 * ---------------------------------------------------------------- */

{
  // 30 timed minutes -> 2 units allowed, 2 claimed, plus an untimed hot pack
  const s = C.billingSummary([
    { code: "97110", minutes: 15, units: 1 },
    { code: "97140", minutes: 15, units: 1 },
    { code: "97010", minutes: 0, units: 1 },
  ]);
  check("timed minutes total across timed codes only", s.timedMinutes === 30, String(s.timedMinutes));
  check("8-minute rule allows 2 units for 30 minutes", s.timedUnitsAllowed === 2);
  check("a balanced claim reports balanced", s.balanced === true);
  check("untimed code counted separately", s.untimedUnits === 1);
  check("total units add timed and untimed", s.totalUnits === 3, String(s.totalUnits));
  check("a balanced claim raises no bad issues", !s.issues.some((i) => i.level === "bad"), JSON.stringify(s.issues));
}

{
  // over-billing: 20 timed minutes supports 1 unit, 3 claimed
  const s = C.billingSummary([{ code: "97110", minutes: 20, units: 3 }]);
  check("over-claimed units are flagged as bad",
    s.issues.some((i) => i.level === "bad"), JSON.stringify(s.issues));
  check("over-claimed reports not balanced", s.balanced === false);
}

{
  // under-billing: 40 timed minutes supports 3 units, 1 claimed
  const s = C.billingSummary([{ code: "97110", minutes: 40, units: 1 }]);
  check("under-claimed units are surfaced", s.issues.some((i) => /only 1 claimed/.test(i.text)), JSON.stringify(s.issues));
  check("under-claim is informational, not an error", !s.issues.some((i) => i.level === "bad"));
}

{
  // 21 minutes is 2 short of the 23-minute second unit
  const s = C.billingSummary([{ code: "97110", minutes: 21, units: 1 }]);
  check("near-miss on the next unit is pointed out",
    s.issues.some((i) => /2 more timed minutes/.test(i.text)), JSON.stringify(s.issues));
}

{
  const s = C.billingSummary([{ code: "97010", minutes: 0, units: 3 }]);
  check("an untimed code billed more than once is flagged",
    s.issues.some((i) => /untimed/.test(i.text)), JSON.stringify(s.issues));
}

{
  const s = C.billingSummary([{ code: "99999", minutes: 10, units: 1 }]);
  check("an unknown code is flagged rather than silently accepted",
    s.issues.some((i) => /isn't a PT code/.test(i.text)), JSON.stringify(s.issues));
}

{
  const s = C.billingSummary([{ code: "97140", minutes: 0, units: 1 }]);
  check("a timed code with no minutes is flagged",
    s.issues.some((i) => /no minutes recorded/.test(i.text)), JSON.stringify(s.issues));
}

check("an empty charge sheet totals to nothing",
  C.billingSummary([]).totalUnits === 0 && C.billingSummary(null).timedMinutes === 0);

check("timed and untimed codes are distinguished",
  C.isTimedCode("97110") === true && C.isTimedCode("97010") === false && C.isTimedCode("nope") === false);

/* ---------------------------------------------------------------- *
 *  Code suggestions from the treatment narrative
 * ---------------------------------------------------------------- */

{
  const codes = C.suggestCodes("Performed manual therapy to the posterior capsule, then scaption exercises and gait training. Reviewed HEP. Hot pack after.")
    .map((c) => c.code);
  check("manual therapy suggests 97140", codes.includes("97140"), codes.join(","));
  check("exercise suggests 97110", codes.includes("97110"), codes.join(","));
  check("gait training suggests 97116", codes.includes("97116"), codes.join(","));
  check("HEP review suggests 97535", codes.includes("97535"), codes.join(","));
  check("hot pack suggests 97010", codes.includes("97010"), codes.join(","));
  check("suggestions carry no invented minutes or units",
    C.suggestCodes("manual therapy").every((c) => c.minutes === undefined && c.units === undefined));
  check("nothing recognised yields no codes", C.suggestCodes("patient chatted about the weather").length === 0);
  check("empty text yields no codes", C.suggestCodes("").length === 0 && C.suggestCodes(null).length === 0);
}

{
  const codes = C.suggestCodes("ultrasound to the shoulder and e-stim afterwards").map((c) => c.code);
  check("ultrasound and e-stim both suggested",
    codes.includes("97035") && codes.includes("97032"), codes.join(","));
}

/* ---------------------------------------------------------------- *
 *  Outcome measures
 * ---------------------------------------------------------------- */

check("LEFS is an up-is-better scale", C.findTool("lefs").better === "up");
check("DASH is a down-is-better scale", C.findTool("dash").better === "down");

{
  const ok = C.validateScore("lefs", 52);
  check("a valid LEFS score passes", ok.ok && ok.value === 52);
  check("a LEFS score above 80 is rejected", C.validateScore("lefs", 95).ok === false);
  check("a negative score is rejected", C.validateScore("nprs", -1).ok === false);
  check("a blank score is rejected", C.validateScore("nprs", "").ok === false);
  check("a non-numeric score is rejected", C.validateScore("nprs", "lots").ok === false);
  check("an unknown tool is rejected", C.validateScore("madeup", 5).ok === false);
}

{
  // LEFS up 30 points across the episode — well past its MCID of 9
  const t = C.outcomeTrends([
    { toolId: "lefs", score: 30, date: "2026-06-01" },
    { toolId: "lefs", score: 44, date: "2026-06-15" },
    { toolId: "lefs", score: 60, date: "2026-07-01" },
  ])[0];
  check("baseline is the earliest score", t.first === 30 && t.firstDate === "2026-06-01");
  check("latest is the most recent score", t.latest === 60 && t.latestDate === "2026-07-01");
  check("improvement on an up-scale is positive", t.improvement === 30, String(t.improvement));
  check("a change past the MCID is meaningful", t.meaningful === true);
  check("direction reads as better", t.direction === "better");
  check("every point is retained for trending", t.n === 3);
}

{
  // DASH down 25 points is an improvement even though the number fell
  const t = C.outcomeTrends([
    { toolId: "dash", score: 60, date: "2026-06-01" },
    { toolId: "dash", score: 35, date: "2026-07-01" },
  ])[0];
  check("improvement on a down-scale is still positive", t.improvement === 25, String(t.improvement));
  check("raw change keeps its sign", t.change === -25, String(t.change));
  check("DASH improvement past MCID is meaningful", t.meaningful === true);
}

{
  // 4 points on a DASH is real movement but under the MCID of 10
  const t = C.outcomeTrends([
    { toolId: "dash", score: 40, date: "2026-06-01" },
    { toolId: "dash", score: 36, date: "2026-07-01" },
  ])[0];
  check("a change short of the MCID is not called meaningful", t.meaningful === false, String(t.improvement));
  check("a sub-MCID gain still reads as better", t.direction === "better");
}

{
  const t = C.outcomeTrends([{ toolId: "lefs", score: 40, date: "2026-06-01" }])[0];
  check("a single score cannot be meaningful", t.meaningful === false);
  check("a single score reads as flat", t.direction === "flat");
  check("a single score reports itself as both baseline and latest", t.first === 40 && t.latest === 40);
}

{
  const t = C.outcomeTrends([
    { toolId: "nprs", score: 4, date: "2026-06-01" },
    { toolId: "nprs", score: 7, date: "2026-07-01" },
  ])[0];
  check("worsening pain reads as worse", t.direction === "worse", String(t.improvement));
  check("worsening past the MCID is still flagged meaningful", t.meaningful === true);
}

{
  const trends = C.outcomeTrends([
    { toolId: "lefs", score: 30, date: "2026-06-01" },
    { toolId: "nprs", score: 7, date: "2026-06-01" },
    { toolId: "bogus", score: 5, date: "2026-06-01" },
    { toolId: "lefs", score: "x", date: "2026-06-08" },
  ]);
  check("one entry per tool, unknown tools dropped", trends.length === 2, JSON.stringify(trends.map((t) => t.toolId)));
  check("non-numeric scores are ignored", trends.find((t) => t.toolId === "lefs").n === 1);
  check("an empty series trends to nothing", C.outcomeTrends([]).length === 0 && C.outcomeTrends(null).length === 0);
}

{
  // out of order in, chronological out
  const t = C.outcomeTrends([
    { toolId: "odi", score: 20, date: "2026-07-01" },
    { toolId: "odi", score: 48, date: "2026-06-01" },
  ])[0];
  check("scores are sorted by date regardless of input order", t.first === 48 && t.latest === 20);
}

/* extraction from dictation */
{
  const got = C.extractOutcomes("LEFS 52 out of 80 today and the DASH score is 38.");
  check("LEFS pulled out of dictation", got.some((o) => o.toolId === "lefs" && o.score === 52), JSON.stringify(got));
  check("DASH pulled out of dictation", got.some((o) => o.toolId === "dash" && o.score === 38), JSON.stringify(got));
}
check("Oswestry is recognised as the ODI",
  C.extractOutcomes("Oswestry 24%").some((o) => o.toolId === "odi" && o.score === 24));
check("an out-of-range dictated score is not filed",
  C.extractOutcomes("DASH 400").length === 0);
check("plain conversation yields no outcome scores",
  C.extractOutcomes("she felt good about the session").length === 0);

/* ---------------------------------------------------------------- *
 *  Goals
 * ---------------------------------------------------------------- */

const TODAY = "2026-07-25";

check("a met goal reports met",
  C.goalStatus({ status: "met", targetDate: "2026-07-01" }, TODAY).state === "met");
check("a goal with no target date says so",
  C.goalStatus({ status: "active" }, TODAY).state === "no-date");

{
  const s = C.goalStatus({ status: "active", targetDate: "2026-07-20" }, TODAY);
  check("a passed target date is overdue", s.state === "overdue", JSON.stringify(s));
  check("overdue counts the days", /5 days overdue/.test(s.label), s.label);
}
check("today's target reads as due today",
  C.goalStatus({ status: "active", targetDate: TODAY }, TODAY).label === "Due today");
check("a target inside two weeks is due soon",
  C.goalStatus({ status: "active", targetDate: "2026-08-01" }, TODAY).state === "due-soon");
check("a distant target is on track",
  C.goalStatus({ status: "active", targetDate: "2026-09-30" }, TODAY).state === "on-track");
check("a discontinued goal is closed, not overdue",
  C.goalStatus({ status: "discontinued", targetDate: "2026-01-01" }, TODAY).state === "closed");
check("a malformed target date degrades to no-date",
  C.goalStatus({ status: "active", targetDate: "not-a-date" }, TODAY).state === "no-date");

{
  const sum = C.goalSummary([
    { text: "Climb a flight of stairs", status: "active", targetDate: "2026-07-20" },  // overdue
    { text: "Shoulder flexion to 160", status: "active", targetDate: "2026-08-01" },   // due soon
    { text: "Return to jogging", status: "active", targetDate: "2026-12-01" },         // on track
    { text: "Sleep through the night", status: "met", targetDate: "2026-07-01" },
    { text: "Lift 20kg", status: "discontinued", targetDate: "2026-07-05" },
  ], TODAY);
  check("goal roll-up counts the total", sum.total === 5);
  check("goal roll-up counts what's still open", sum.open === 3, String(sum.open));
  check("goal roll-up counts met goals", sum.met === 1);
  check("goal roll-up counts overdue goals", sum.overdue === 1, String(sum.overdue));
  check("goal roll-up counts goals due soon", sum.dueSoon === 1, String(sum.dueSoon));
  check("an empty goal list rolls up to zero",
    C.goalSummary([], TODAY).total === 0 && C.goalSummary(null, TODAY).open === 0);
}

/* ---------------------------------------------------------------- *
 *  Service catalogue and the visit subtotal
 *
 *  Money is the part of billing a clinic checks by hand, so the failures
 *  that matter here are the quiet ones: a price that moved under a signed
 *  note, or a subtotal that looks complete while a line is missing from it.
 * ---------------------------------------------------------------- */

{
  const codes = C.SERVICE_CODES.map((c) => c.code);
  check("every discipline carries its six codes",
    ["PT", "OT", "ST"].every((d) => [1, 2, 3, 4, 5, 6].every((n) => codes.includes(`${d}0${n}`))),
    codes.join(","));
  check("the four add-ons are on the list",
    ["A01", "A02", "A03", "A04"].every((c) => codes.includes(c)));
  check("no code appears twice", new Set(codes).size === codes.length);
  check("lookup is case-insensitive and trims", C.findService(" pt02 ").code === "PT02");
  check("an unknown code is not invented", C.findService("97110") === null);
  check("the groups keep catalogue order",
    C.serviceGroups().map((g) => g.group).join("|") ===
      "Physical therapy|Occupational therapy|Speech therapy|Add-ons");
  check("every code lands in exactly one group",
    C.serviceGroups().reduce((n, g) => n + g.codes.length, 0) === C.SERVICE_CODES.length);
}

{
  const prices = { PT02: 850, A01: 150, A03: 75 };
  check("a priced code returns its price", C.priceFor("PT02", prices) === 850);
  check("an unpriced code is null, not zero", C.priceFor("PT01", prices) === null);
  check("a blank price is null, not zero", C.priceFor("PT01", { PT01: "" }) === null);
  check("a real zero price is kept", C.priceFor("PT01", { PT01: 0 }) === 0);
  check("a negative price is refused", C.priceFor("PT01", { PT01: -5 }) === null);
  check("no price list at all is null", C.priceFor("PT02", null) === null);
}

{
  const prices = { PT02: 850, A01: 150 };
  const s = C.serviceSummary([{ code: "PT02", units: 1 }, { code: "A01", units: 2 }], prices);
  check("units total across the sheet", s.units === 3, String(s.units));
  check("the subtotal is units x price", s.subtotal === 850 + 300, String(s.subtotal));
  check("a fully priced sheet reads as complete", s.complete === true && s.unpriced === 0);
  check("a priced sheet raises nothing", s.issues.length === 0, JSON.stringify(s.issues));
  check("each line carries its own amount",
    s.rows[0].amount === 850 && s.rows[1].amount === 300);
}

{
  // An unpriced line must be visible, not silently worth nothing.
  const s = C.serviceSummary([{ code: "PT02", units: 1 }, { code: "PT01", units: 1 }], { PT02: 850 });
  check("the subtotal omits an unpriced line", s.subtotal === 850, String(s.subtotal));
  check("the omission is counted", s.unpriced === 1);
  check("an incomplete subtotal never reads as complete", s.complete === false);
  check("the unpriced line says so", s.issues.some((i) => /no price set/i.test(i.text)));
  check("an unpriced line has no amount", s.rows[1].amount === null && s.rows[1].price === null);
}

{
  // The whole point of stamping the price onto the line: a signed note keeps
  // the money it was signed for when the price list moves underneath it.
  const s = C.serviceSummary([{ code: "PT02", units: 2, price: 600 }], { PT02: 850 });
  check("a line's own price beats today's schedule", s.subtotal === 1200, String(s.subtotal));
  const fell = C.serviceSummary([{ code: "PT02", units: 1, price: null }], { PT02: 850 });
  check("a line with no price of its own falls back to the schedule", fell.subtotal === 850);
  const zero = C.serviceSummary([{ code: "PT02", units: 1, price: 0 }], { PT02: 850 });
  check("a line priced at zero stays at zero", zero.subtotal === 0 && zero.unpriced === 0);
}

{
  const s = C.serviceSummary([{ code: "ZZ99", units: 1 }, { code: "PT02", units: 0 }], { PT02: 850 });
  check("a code off the price list is flagged", s.issues.some((i) => /not on this clinic's price list/i.test(i.text)));
  check("a line with no units is flagged", s.issues.some((i) => /no units/i.test(i.text)));
  check("zero units contribute nothing", s.subtotal === 0, String(s.subtotal));
  check("units are whole numbers", C.serviceSummary([{ code: "PT02", units: 2.6 }], { PT02: 100 }).units === 3);
  check("negative units cannot credit a visit",
    C.serviceSummary([{ code: "PT02", units: -4 }], { PT02: 100 }).subtotal === 0);
}

check("an empty charge sheet totals nothing",
  C.serviceSummary([], {}).subtotal === 0 && C.serviceSummary(null, {}).lines === 0 &&
  C.serviceSummary([], {}).complete === false);

/* ---------------------------------------------------------------- *
 *  Outcome measures, scored item by item
 *
 *  The failure that matters here is a HALF-FILLED form being reported as the
 *  instrument's score: ten answered items of a twenty-item LEFS totals to a
 *  number that reads as severe disability and is really an unanswered page.
 * ---------------------------------------------------------------- */

{
  const full = (n, v) => Array.from({ length: n }, () => v);

  check("LEFS sums its twenty items", C.scoreFromItems("lefs", full(20, 3)).score === 60);
  check("…and says so is complete", C.scoreFromItems("lefs", full(20, 3)).complete === true);
  check("a half-filled LEFS is NOT complete",
    C.scoreFromItems("lefs", full(10, 3)).complete === false,
    "a partial total reported as the score reads as severe disability");
  check("…but still reports how far along it is",
    C.scoreFromItems("lefs", full(10, 3)).answered === 10 && C.scoreFromItems("lefs", full(10, 3)).of === 20);

  check("ODI reports a percentage of the possible", C.scoreFromItems("odi", full(10, 2)).score === 40);
  check("NDI scores the same way", C.scoreFromItems("ndi", full(10, 5)).score === 100);
  check("QuickDASH applies its own formula", C.scoreFromItems("quickdash", full(11, 3)).score === 50);
  check("DASH applies it over thirty items", C.scoreFromItems("dash", full(30, 5)).score === 100);
  check("ABC averages its sixteen items", C.scoreFromItems("abc", full(16, 80)).score === 80);

  // PSFS: the patient names three to five activities, so any of them completes it
  const psfs = C.scoreFromItems("psfs", [4, 6, 5]);
  check("PSFS averages the activities the patient named", psfs.score === 5);
  check("…and three of five counts as complete", psfs.complete === true,
    "PSFS asks for three to five activities; requiring all five would never complete");

  check("a single-reading measure has no answer sheet",
    C.itemsFor("tug") === null && C.itemsFor("nprs") === null);
  check("…and refuses to be scored as one",
    C.scoreFromItems("tug", [12]).ok === false);
  check("a questionnaire does have one",
    C.itemsFor("lefs").count === 20 && C.itemsFor("lefs").max === 4);

  const bad = C.scoreFromItems("lefs", [3, 99, 3]);
  check("an out-of-range item is ignored rather than counted", bad.score === 6, String(bad.score));
  check("…and it says one was dropped", /outside 0–4/.test(bad.error), bad.error);
  check("nothing answered scores nothing",
    C.scoreFromItems("lefs", []).ok === false && C.scoreFromItems("lefs", []).answered === 0);
  check("gaps in the middle are skipped, not read as zero",
    C.scoreFromItems("lefs", [4, null, 4]).score === 8);
  check("an unknown tool is refused", C.scoreFromItems("nope", [1]).ok === false);
  check("junk input never throws",
    C.scoreFromItems("lefs", null).ok === false && C.scoreFromItems(null, null).ok === false);
}

/* ---------------------------------------------------------------- *
 *  Goal suggestions
 *
 *  These are PROMPTS. The tests that matter are the ones proving nothing
 *  clinically wrong is ever offered: software that suggests plausible goals
 *  is writing the plan of care while appearing to help with it.
 * ---------------------------------------------------------------- */

{
  const texts = (d, ex) => C.suggestGoals(d, ex || []).map((g) => g.text);

  // --- muscle strength: the next whole grade ---
  check("the next whole grade above 3 is 4", C.nextMmtGrade("3") === "4");
  check("a plus grade still steps to the next whole one", C.nextMmtGrade("3+") === "4");
  check("nothing is suggested above 5/5", C.nextMmtGrade("5") === null);
  check("an unreadable grade suggests nothing", C.nextMmtGrade("banana") === null);
  {
    const g = C.suggestGoals({ mmt: [{ side: "right", context: "quad", grade: "3" }] }, []);
    check("a weak muscle gets a goal one grade up",
      g.length === 1 && g[0].target === "4/5" && g[0].baseline === "3/5", JSON.stringify(g));
    check("…written in sentence case", g[0].text === "Right quad strength 4/5", g[0].text);
    check("a 5/5 muscle gets nothing",
      C.suggestGoals({ mmt: [{ side: "left", context: "quad", grade: "5" }] }, []).length === 0);
  }

  // --- range of motion: the patient's own other side, and only if it's better
  {
    const rom = [
      { side: "right", joint: "shoulder", motion: "flexion", degrees: 120 },
      { side: "left", joint: "shoulder", motion: "flexion", degrees: 165 },
    ];
    const g = C.suggestGoals({ rom }, []);
    check("the restricted side is given the sound side as its target",
      g.length === 1 && g[0].target === "165°" && /matching the left/.test(g[0].text), JSON.stringify(g));
    check("THE SOUND SIDE IS NEVER ASKED TO REGRESS",
      !g.some((x) => x.target === "120°"),
      "offering to bring the good limb down to meet the injured one is a goal no therapist would write");
    check("…and the sound side gets no goal of its own",
      !g.some((x) => /left shoulder/i.test(x.text)),
      "a goal for the reference limb filled the list with the sound side of every joint");
  }
  {
    // no contralateral reading: the baseline goes out, the target does not
    const g = C.suggestGoals({ rom: [{ side: "right", joint: "knee", motion: "flexion", degrees: 95 }] }, []);
    check("a lone reading still prompts a goal", g.length === 1 && g[0].baseline === "95°");
    check("…with the target left to the therapist", g[0].target === "",
      "an invented normative end-range is a number nobody measured and nobody chose");
    check("…and says why it is blank", /set the target yourself/.test(g[0].rule), g[0].rule);
  }

  // --- pain and outcome measures: the published MCID, not a guess ---
  {
    const g = C.suggestGoals({ pain: [{ score: 7, location: "right shoulder" }] }, []);
    check("pain is targeted one NPRS MCID lower", g[0].target === "5/10", JSON.stringify(g));
    check("…and names the rule", /clinically important difference of 2/.test(g[0].rule), g[0].rule);
    check("pain already at or below the MCID prompts nothing",
      C.suggestGoals({ pain: [{ score: 2 }] }, []).length === 0);
  }
  {
    const g = C.suggestGoals({ outcomes: [{ toolId: "lefs", score: 52 }] }, []);
    check("an outcome measure is targeted one MCID better", g[0].target === "61/80", JSON.stringify(g));
    const down = C.suggestGoals({ outcomes: [{ toolId: "odi", score: 40 }] }, []);
    check("…in the improving direction, whichever way the scale runs",
      down[0].target === "30%", JSON.stringify(down));
    check("a score already at the end of the scale prompts nothing",
      C.suggestGoals({ outcomes: [{ toolId: "lefs", score: 80 }] }, []).length === 0);
    check("an unknown tool is skipped rather than guessed at",
      C.suggestGoals({ outcomes: [{ toolId: "nope", score: 5 }] }, []).length === 0);
  }

  // --- never offer what is already committed to ---
  {
    const data = { pain: [{ score: 7, location: "right shoulder" }] };
    check("a goal already in the plan is not offered again",
      C.suggestGoals(data, [{ text: "Pain in the right shoulder at or below 5/10" }]).length === 0);
    check("…matched loosely enough to catch a reworded one",
      C.suggestGoals(data, [{ text: "pain in the right shoulder at or below 5/10, walking" }]).length === 0);
  }

  check("nothing measured suggests nothing",
    C.suggestGoals({}, []).length === 0 && C.suggestGoals(null, null).length === 0);
  check("every suggestion carries the rule that produced it",
    C.suggestGoals({ mmt: [{ side: "right", context: "quad", grade: "3" }],
                     pain: [{ score: 8 }], outcomes: [{ toolId: "lefs", score: 40 }] }, [])
      .every((g) => g.rule && g.text && g.baseline !== undefined));
}

/* ---------------------------------------------------------------- */

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\nTheraChart clinical checker: ${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`TheraChart clinical checker: ${passed}/${passed} checks passed`);
