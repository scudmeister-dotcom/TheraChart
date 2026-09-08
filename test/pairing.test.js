/* TheraChart dictation-pairing checker — the one setting that silently
   degrades every visit when it is wrong.

   Dictation sends ONE language code per request — fil-PH ("English & Tagalog")
   or ceb-PH ("English & Cebuano") — because Chirp 2 refuses a list. Before
   this, the choice was stored per device, set once, and never mentioned again.
   A tablet left on English & Tagalog in a Bisaya-speaking clinic degraded
   every Cebuano utterance and nothing on screen said so; test/voice/ measures
   what that costs (Cebuano scripts run 14–16% word error where English-only
   runs 0%).

   There were two ways to arrive at the wrong pairing and neither was visible:

     1. Nobody ever looked at the control again.
     2. A device with NOTHING stored — a new tablet, a cleared browser, a
        second profile, a legacy "en-US" — fell back to fil-PH regardless of
        where the clinic was. A Cebuano clinic could revert with nobody
        touching anything.

   So there are two guards, and this file covers both: a per-clinic default
   that decides (2), and a transcript check that catches (1) by reading the
   words that came back.

   THE DETECTOR IS MEASURED, NOT ASSERTED. Its corpus is the real Chirp 2
   output kept in test/voice/baseline.json — 32 transcripts of scripted visits
   actually spoken through Google's recogniser. Inventing Cebuano strings and
   checking they are detected proves only that the author can write a regex
   that matches their own examples. The whole value of the threshold is what it
   does to real recogniser output, including its errors.

   Run: node test/pairing.test.js */

"use strict";

const fs = require("fs");
const path = require("path");
const { reporter } = require("./helpers/server.js");

const PR = require("../parser.js");
const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const STORE_SRC = fs.readFileSync(path.join(__dirname, "..", "store.js"), "utf8");
const BASELINE = require("./voice/baseline.json");

const r = reporter("dictation pairing");
const OTHER = { "fil-PH": "ceb-PH", "ceb-PH": "fil-PH" };

/* ------------------------------------------------------------------ *
 *  1. The detector, against real recogniser output
 * ------------------------------------------------------------------ */
{
  const cases = BASELINE.cases.filter((c) => (c.heard || "").trim());
  r.check("the voice baseline still carries transcripts to measure against",
    cases.length >= 30, `only ${cases.length} usable cases`);

  /* NO FALSE POSITIVES is the property that matters most here, and it is not
     symmetric with the other one. A missed mismatch costs one visit's word
     error. A false alarm invites a therapist whose pairing was CORRECT to
     change it, and then every visit afterwards pays. */
  const falsePositives = cases.filter((c) => PR.pairingMismatch(c.heard, c.lang));
  r.check("no transcript is flagged under the code it was actually recorded with",
    falsePositives.length === 0,
    falsePositives.map((c) => `${c.id} [${c.lang}] flagged as ${PR.pairingMismatch(c.heard, c.lang).lang}`).join("\n    "));

  /* The Cebuano visits are the whole point: these are the ones a Bisaya clinic
     runs all day, and every one of them must be caught on a device left on
     Tagalog. */
  const ceb = cases.filter((c) => c.lang === "ceb-PH");
  r.check("the baseline still contains Cebuano visits", ceb.length === 4, `found ${ceb.length}`);
  const missed = ceb.filter((c) => !PR.pairingMismatch(c.heard, "fil-PH"));
  r.check("every Cebuano visit is caught on a device left on English & Tagalog",
    missed.length === 0,
    missed.map((c) => `${c.id} went undetected`).join("\n    "));

  /* And the reverse door — a Manila tablet that someone set to Cebuano. */
  const caughtBackwards = cases.filter((c) => c.lang === "fil-PH" && PR.pairingMismatch(c.heard, "ceb-PH"));
  r.check("Tagalog visits are caught on a device left on English & Cebuano",
    caughtBackwards.length >= 8, `only ${caughtBackwards.length} of the Tagalog visits were caught`);

  /* An English-only visit is not evidence against either code — English rides
     on both (app.js: "English spoken under fil-PH comes back as English"). A
     detector that fired on those would be telling clinics to change a setting
     the visit said nothing about. */
  const englishOnly = cases.filter((c) => !PR.markersFound(c.heard, "fil-PH").length
    && !PR.markersFound(c.heard, "ceb-PH").length);
  r.check("English-only visits stay silent under both codes",
    englishOnly.length >= 15
      && englishOnly.every((c) => !PR.pairingMismatch(c.heard, "fil-PH") && !PR.pairingMismatch(c.heard, "ceb-PH")),
    `${englishOnly.length} English-only transcripts`);
}

/* ------------------------------------------------------------------ *
 *  2. The threshold, and the words it must refuse to count
 * ------------------------------------------------------------------ */
{
  /* One marker and NOTHING against it — the case that isolates the threshold
     from the outvoting rule below. A clinic set to Cebuano whose therapist
     says one Tagalog body part has not told anybody anything. */
  r.check("one borrowed word is never enough to tell a clinic it is misconfigured",
    PR.markersFound("the right balikat is still sore", "fil-PH").length === 1
      && PR.pairingMismatch("the right balikat is still sore", "ceb-PH") === null,
    "a single marker fires the warning — a Taglish visit would raise it constantly");

  r.check("a borrowed word does not become evidence by being outnumbered later",
    PR.pairingMismatch("kaayo", "fil-PH") === null,
    "the threshold is on DISTINCT markers, not on the absence of counter-evidence");

  r.check("two markers with nothing against them do fire",
    (PR.pairingMismatch("unsa may imong gibati", "fil-PH") || {}).lang === "ceb-PH");

  r.check("the selected language's own words outvote a couple of borrowings",
    PR.pairingMismatch(
      "magandang umaga po ano ang nararamdaman ninyo ngayon hindi po ako makatulog kapag masakit unsa imong",
      "fil-PH") === null,
    "a Tagalog visit carrying two Cebuano words must not be read as a Cebuano visit");

  r.check("an empty transcript says nothing",
    PR.pairingMismatch("", "fil-PH") === null && PR.pairingMismatch("   ", "ceb-PH") === null);

  r.check("an unknown code is not second-guessed",
    PR.pairingMismatch("unsa may imong gibati sa imong tuhod", "en-US") === null,
    "there is no third pairing to recommend");

  /* The exclusions are the hard part of this list and the easy thing to undo.
     Each of these is in BOTH corpora in test/voice/baseline.json; adding any
     of them as a marker would fire on visits where nothing is wrong. `taas`
     in particular reads as Cebuano until you find it in a Tagalog visit. */
  for (const shared of ["sakit", "masakit", "kung", "mga", "siko", "tuhod", "sige", "taas", "paa", "po", "kanang", "lima", "pito", "walo", "siyam"]) {
    r.check(`"${shared}" is shared vocabulary and counts for neither language`,
      !PR.markersFound(shared, "fil-PH").length && !PR.markersFound(shared, "ceb-PH").length,
      `it is a marker, and both languages say it`);
  }

  /* Bare "wala" means LEFT in Cebuano and "none" in Tagalog — parser.js
     already carries a bug note about exactly this word costing a laterality
     reading. It must not be a language marker either. */
  r.check("bare \"wala\" is not a marker in either direction",
    !PR.markersFound("wala", "fil-PH").length && !PR.markersFound("wala", "ceb-PH").length,
    "in Cebuano it also means left; parser.js:NEG_TAIL_RE carries the same warning");

  r.check("markers are reported so the therapist can check the claim",
    (PR.pairingMismatch("unsa may imong gibati karon", "fil-PH") || {}).markers.length >= 2,
    "a warning whose evidence is hidden can only be obeyed or ignored");

  r.check("the same word twice is one piece of evidence, not two",
    PR.pairingMismatch("kaayo kaayo kaayo kaayo", "fil-PH") === null,
    "counting repeats would let one word clear a threshold set at two");
}

/* ------------------------------------------------------------------ *
 *  3. The clinic default — the door a warning cannot close
 * ------------------------------------------------------------------ */
{
  const store = require("../store.js");
  store.resetAll();
  const grace = store.getUser("u-grace");

  r.check("a clinic that has not chosen still gets Tagalog, the lingua franca",
    store.settings().dictationLang === "fil-PH", JSON.stringify(store.settings().dictationLang));

  store.updateSettings({ dictationLang: "ceb-PH" }, grace);
  r.check("a Visayas clinic can set Cebuano once, for the whole clinic",
    store.settings().dictationLang === "ceb-PH");

  r.check("the clinic's pairing survives an unrelated settings save",
    (() => { store.updateSettings({ progressEvery: 7 }, grace); return store.settings().dictationLang === "ceb-PH"; })(),
    "a patch that does not mention the language must not reset it");

  r.check("store.js declares the default rather than leaving it undefined",
    /dictationLang: "fil-PH",/.test(STORE_SRC),
    "an absent default is the fil-PH fallback again, one layer down");

  /* The bind-time fallback is the entire point of the setting. If app.js goes
     back to STT_LANG_DEFAULT here, a new tablet in a Bisaya clinic lands on
     Tagalog again and the clinic setting becomes decoration. */
  r.check("a device with nothing stored falls back to the CLINIC's pairing",
    /langSel\.value = STT_LANG\[stored\] \? stored : clinicLang\(\);/.test(SRC),
    "app.js reverted to a constant — the per-clinic default would stop being read");

  r.check("clinicLang() refuses a stored value that is not one of the two codes",
    /function clinicLang\(\)[\s\S]{0,260}return STT_LANG\[c\] \? c : STT_LANG_DEFAULT;/.test(SRC),
    "an unrecognised clinic setting must not reach the recogniser");

  r.check("the settings screen exposes the clinic pairing",
    /id="st-lang"/.test(SRC) && /Dictation language for this clinic/.test(SRC));

  r.check("…and saves it guarded to the two codes Chirp 2 is offered",
    /dictationLang: document\.getElementById\("st-lang"\)\.value === "ceb-PH" \? "ceb-PH" : "fil-PH",/.test(SRC),
    "an unguarded save lets a stale value become what every new device starts on");

  r.check("the note's <select> opens on the pairing it will actually send",
    /\$\{langOptions\(localStorage\.getItem\("therachart-lang"\)\)\}/.test(SRC),
    "hard-coded <option>s show Tagalog until JS corrects them");
}

/* ------------------------------------------------------------------ *
 *  4. The warning on screen
 * ------------------------------------------------------------------ */
{
  /* Wired to the redraw, not to the three transcript sources. Live dictation,
     the visit recorder and a per-section mic all end up in drawTranscript, so
     that is the one place a fourth path cannot bypass — and it is what lets
     the evidence accumulate across single short utterances. */
  const draw = SRC.slice(SRC.indexOf("  function drawTranscript("));
  r.check("the check runs on every transcript redraw",
    /renderLangMismatch\(doc, editable\);/.test(draw.slice(0, draw.indexOf("\n  }\n") + 5)),
    "wiring it to one recording path leaves the other two uncovered");

  r.check("changing the pairing by hand settles the warning too",
    /langSel\.addEventListener\("change"[\s\S]{0,420}renderLangMismatch\(doc, true\);/.test(SRC),
    "the warning is about disagreeing with this control, so moving it must re-check");

  r.check("the warning sits directly above the transcript that evidences it",
    SRC.indexOf('id="langMismatch"') > 0
      && SRC.indexOf('id="langMismatch"') < SRC.indexOf('<div class="transcript-head"'),
    "the therapist has to be able to read the claim and the words in one glance");

  r.check("it offers the switch rather than only reporting the problem",
    /id="langSwitch"/.test(SRC) && /Switch to \$\{esc\(name\(m\.lang\)\)\}/.test(SRC));

  r.check("switching goes through the <select>'s own change handler",
    /sel\.value = m\.lang;[\s\S]{0,220}sel\.dispatchEvent\(new Event\("change"\)\);/.test(SRC),
    "a second way to write therachart-lang is a second way for it to drift");

  /* Honesty about what the button does not do. Switching cannot re-transcribe
     audio that has already been sent and billed. */
  r.check("it says the recording already transcribed is not sent again",
    /What is already transcribed above is not sent again\./.test(SRC),
    "a therapist who expects the transcript to repair itself will wait for it to");

  r.check("it can be dismissed for the note",
    /id="langKeep"/.test(SRC) && /langWarningOff\.add\(doc\.id\)/.test(SRC),
    "a bilingual clinic that cannot put it away stops reading it, and the next notice too");

  r.check("dismissal is per note and not persisted",
    /const langWarningOff = new Set\(\);/.test(SRC) && !/therachart-langwarn/.test(SRC),
    "a dismissal that outlives the note silences the next visit as well");

  r.check("a signed note never raises it",
    /if \(!sel \|\| !editable \|\| langWarningOff\.has\(doc\.id\)\) return hide\(\);/.test(SRC),
    "a locked note cannot be re-dictated, so the warning would be pure noise on it");

  /* The product used to teach the behaviour that causes this. Both places said
     to set the pairing once. */
  r.check("the walkthrough no longer teaches set-and-forget",
    !/Set the pairing once/.test(SRC),
    "the in-app tour was instructing therapists into the failure this file is about");

  r.check("…and says the note will tell them when it hears the other language",
    /if the transcript comes back sounding like the other language the note tells you/.test(SRC));
}

r.done();
