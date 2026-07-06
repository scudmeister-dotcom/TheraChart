/* TheraChart parser — the listening brain, kept free of DOM code so the
   exact same logic runs in the browser app and in the offline test checker
   (node test/parser.test.js).

   Understands English, Tagalog, and Cebuano at the same time (code-switching
   like Taglish is common in clinic speech), extracts clinical measurements
   (ROM, MMT, pain ratings, special tests), and classifies utterances into
   evaluation sections. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- *
   *  Body-part lexicon (en + tl Tagalog + ceb Cebuano)
   *  dx = horizontal offset from the body's centreline (x = 100).
   *  Front view is mirrored (patient's left shows on the viewer's right);
   *  the back view is not.
   *  Order matters: more specific phrases must come before generic ones —
   *  a match claims its text range so later entries can't reuse it.
   * ---------------------------------------------------------------- */

  const P = (name, kw, opts = {}) =>
    Object.assign({ name, kw, dx: 0, y: 0, view: "front", sided: false }, opts);

  const BODY_PARTS = [
    // Back view, specific first
    P("Lower back", "lower\\s+back|lumbar(?:\\s+region)?|small of (?:my|the|his|her) back|baywang|hawak", { view: "back", y: 178 }),
    P("Upper back", "upper\\s+back", { view: "back", y: 110 }),
    P("Mid back", "mid(?:dle)?[-\\s]?back", { view: "back", y: 145 }),
    P("Shoulder blade", "shoulder\\s+blades?|scapula|paypay", { view: "back", dx: 24, y: 112, sided: true }),
    P("Back of head", "back of (?:my|the|his|her) head|batok", { view: "back", y: 36 }),
    P("Back of neck", "back of (?:my|the|his|her) neck", { view: "back", y: 66 }),
    P("Tailbone", "tail\\s?bone|coccyx", { view: "back", y: 206 }),
    P("Spine", "spine|spinal|gulugod", { view: "back", y: 140 }),
    P("Buttock", "buttocks?|glutes?|gluteal|rear end|puwit|pwet|lubot", { view: "back", dx: 15, y: 214, sided: true }),
    P("Hamstring", "hamstrings?", { view: "back", dx: 16, y: 265, sided: true }),
    P("Achilles", "achilles(?:\\s+tendon)?", { view: "back", dx: 15.5, y: 392, sided: true }),
    P("Heel", "heels?|sakong|tikod", { view: "back", dx: 16, y: 404, sided: true }),
    P("Calf", "calf|calves|binti|b[ai]tiis", { view: "back", dx: 16, y: 350, sided: true }),
    // Generic "back" only when clearly the body part:
    // needs a possessive before it, and not "back of" / "behind my back".
    // "likod" (tl/ceb) is always the body part.
    P("Back", "(?<=\\b(?:my|his|her|your|the)\\s)(?<!behind (?:my|his|her|your|the)\\s)back\\b(?!\\s+of)|likod", { view: "back", y: 150 }),

    // Head & face
    P("Forehead", "forehead|noo|agtang", { y: 24 }),
    P("Temple", "temples?", { dx: 14, y: 28, sided: true }),
    P("Eye", "eyes?|eyebrows?|eyelids?|mata", { dx: 8, y: 32, sided: true }),
    P("Ear", "ears?|earlobes?|tenga|tainga|dalunggan", { dx: 18, y: 36, sided: true }),
    P("Nose", "nose|sinus(?:es)?|ilong", { y: 38 }),
    P("Jaw", "jaws?|tmj|panga", { dx: 10, y: 48, sided: true }),
    P("Mouth", "mouth|teeth|tooth|gums?|tongue|lips?|bibig|ngipin|ngipon|dila", { y: 46 }),
    P("Head", "head|skull|headaches?|migraines?|ulo", { y: 34 }),
    P("Throat", "throat|lalamunan|tutunlan", { y: 70 }),
    P("Neck", "neck|leeg|liog", { y: 66 }),

    // Torso
    P("Collarbone", "collar\\s?bones?|clavicle", { dx: 13, y: 88, sided: true }),
    P("Armpit", "armpits?|underarms?|kilikili|ilok", { dx: 38, y: 105, sided: true }),
    P("Shoulder", "shoulders?|rotator cuff|deltoids?|balikat|abaga", { dx: 46, y: 95, sided: true }),
    P("Heart", "heart|puso", { dx: 14, y: 112, fixedSide: "left" }),
    P("Chest", "chest|pec(?:toral)?s?|breast\\s?bone|sternum|dibdib|dughan", { dx: 14, y: 112, sided: true }),
    P("Ribs", "ribs?|rib\\s?cage|tadyang|gusok", { dx: 20, y: 135, sided: true }),
    P("Navel", "navel|belly\\s?button|pusod", { y: 170 }),
    P("Stomach", "stomach(?:\\s?aches?)?|belly|abdomen|abdominal|tummy|gut|tiyan|sikmura", { y: 160 }),
    P("Pelvis", "pelvis|pelvic", { y: 205 }),
    P("Groin", "groin|singit", { y: 224 }),
    P("Hip", "hips?|balakang|bat-?ang", { dx: 31, y: 202, sided: true }),

    // Arms (specific before generic "arm")
    P("Upper arm", "upper\\s+arms?|biceps?|triceps?", { dx: 51, y: 125, sided: true }),
    P("Elbow", "elbows?|siko", { dx: 55, y: 154, sided: true }),
    P("Forearm", "forearms?|bisig", { dx: 59, y: 182, sided: true }),
    P("Wrist", "wrists?|pulso|galang-?galangan", { dx: 63, y: 210, sided: true }),
    P("Thumb", "thumbs?|hinlalaki|kumagko", { dx: 61, y: 238, sided: true }),
    // Toe phrases must win over Finger ("daliri sa paa" = toe, not finger)
    P("Toe", "(?:big\\s+)?toes?|daliri sa paa|tudlo sa tiil", { dx: 21.5, y: 412, sided: true }),
    P("Finger", "fingers?|knuckles?|pinky|daliri|tudlo", { dx: 67, y: 243, sided: true }),
    P("Hand", "hands?|palms?|kamay|kamot|palad", { dx: 65, y: 228, sided: true }),
    P("Arm", "arms?|braso|bukton", { dx: 54, y: 150, sided: true }),

    // Legs (specific before generic "leg")
    P("Thigh", "thighs?|quad(?:ricep)?s?|hita", { dx: 16, y: 260, sided: true }),
    P("Kneecap", "knee\\s?caps?|patella", { dx: 16, y: 308, sided: true }),
    P("Knee", "knees?|tuhod", { dx: 16, y: 310, sided: true }),
    P("Shin", "shins?|lulod", { dx: 16, y: 350, sided: true }),
    P("Ankle", "ankles?|bukong-?bukong|buol-?buol", { dx: 15, y: 392, sided: true }),
    P("Foot", "foot|feet|talampakan|tiil", { dx: 18.5, y: 403, sided: true }),
    // "paa" is foot/leg in Tagalog and thigh in Cebuano — mapped to the leg
    P("Leg", "legs?|paa", { dx: 16, y: 300, sided: true }),
  ];

  // Optional left/right words, in all three languages.
  // kaliwa(ng) = left (tl) · wala(ng) = left (ceb) · kanan(g) = right (tl)
  // tuo(ng) = right (ceb). Normalized by sideWord().
  const SIDE_WORDS = "left|right|kaliwang?|kanang?|walang?|wala|tuong?|tuo";
  const LEFT_RE = /^(left|kaliwa|wala)/i;

  function sideWord(raw) {
    if (!raw) return null;
    return LEFT_RE.test(raw) ? "left" : "right";
  }

  // Compile one regex per entry, with an optional side capture in front.
  for (const part of BODY_PARTS) {
    part.re = new RegExp(
      `\\b(?:(${SIDE_WORDS})\\s+(?:nga\\s+)?(?:\\w+\\s+)??)?(?:${part.kw})\\b`,
      "gi"
    );
  }

  /* ---------------------------------------------------------------- *
   *  Symptom vocabulary used to write the summary "in my own words"
   * ---------------------------------------------------------------- */

  const ADJECTIVES = [
    ["sharp", /\b(?:sharp|kirot|kumikirot)\b/i],
    ["dull", /\bdull\b/i],
    ["throbbing", /\b(?:throbbing|ngutngut|nagangutngut)\b/i],
    ["stabbing", /\bstabbing\b/i],
    ["shooting", /\bshoot(?:s|ing)?\b/i],
    ["burning", /\b(?:burn(?:s|ing)?|hapdi|mahapdi)\b/i],
    ["radiating", /\bradiat(?:es|ing)\b/i],
    ["constant", /\bconstant(?:ly)?\b/i],
    ["intermittent", /\b(?:intermittent|comes and goes|on and off)\b/i],
    ["deep", /\bdeep\b/i],
    ["chronic", /\bchronic\b/i],
  ];

  const NOUNS = [
    ["headache", /\b(?:headaches?|migraines?)\b/i],
    ["pain", /\b(?:pain(?:ful)?|hurt(?:s|ing)?|ach(?:e|es|ing|y)|sting(?:s|ing)?|killing me|agony|(?:napaka|ma)?sakit|sumasakit|kirot|kumikirot|ngutngut|nagangutngut|hapdi|mahapdi)\b/i],
    ["soreness", /\bsore(?:ness)?\b/i],
    ["stiffness", /\b(?:stiff(?:ness)?|naninigas|matigas|gahi)\b/i],
    ["tightness", /\btight(?:ness)?\b/i],
    ["numbness", /\b(?:numb(?:ness)?|manhid|namamanhid|binhod|nabinhod)\b/i],
    ["tingling", /\b(?:tingl(?:e|es|ing|y)|pins and needles|tusok-?tusok|tinutusok)\b/i],
    ["cramping", /\b(?:cramp(?:s|ing)?|spasm(?:s|ing)?|pulikat|kalambr[ei])\b/i],
    ["swelling", /\b(?:swollen|swelling|puffy|inflam(?:ed|mation)|n?a?mamaga|namaga|maga|hubag|nanghubag|gihubag)\b/i],
    ["weakness", /\b(?:weak(?:ness)?|giv(?:es?|ing) out|mahina|nanghihina|luya|naluya|giluya)\b/i],
    ["bruising", /\b(?:bruis(?:e|ed|es|ing)|pasa)\b/i],
    ["itching", /\b(?:itch(?:y|ing|es)?|makati|katol)\b/i],
    ["tenderness", /\btender(?:ness)?\b/i],
    ["clicking", /\b(?:click(?:s|ing)?|pop(?:s|ping)|crack(?:s|ing)|grind(?:s|ing))\b/i],
    ["locking", /\block(?:s|ed|ing)(?:\s+up)?\b/i],
    ["dizziness", /\b(?:dizzy|dizziness|light-?headed|nahihilo|hilo|naglipong|lipong)\b/i],
    ["pressure", /\b(?:pressure|tension)\b/i],
    ["instability", /\b(?:unstable|instability|wobbly|buckl(?:es|ing))\b/i],
    ["a possible sprain", /\bsprain(?:ed)?\b/i],
    ["a possible strain", /\b(?:strain(?:ed)?|pulled)\b/i],
    ["a possible tear", /\b(?:tore|torn)\b/i],
    ["a possible fracture", /\b(?:broke(?:n)?|fracture(?:d)?|nabali|nabuak)\b/i],
    ["a twist injury", /\b(?:twisted|napilay|nalisa)\b/i],
  ];

  const SEVERE_RE = /\b(really|very|extremely|severe(?:ly)?|terribl[ye]|excruciating|unbearable|awful|so much|super|badly|killing me|sobrang?|grabe(?:\s+kaayo)?|kaayo|napaka\w+)\b/i;
  const MILD_RE = /\b(slightly|a\s+(?:little|bit|touch)|mild(?:ly)?|minor|somewhat|kind of|sort of|medyo|gamay|konti|onti)\b/i;
  const RATING_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\/|out of|sa)\s*(?:10|ten|sampu)\b/i;
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const DURATION_RE = /\b((?:for|since|over|mula|simula|sukad)\s+(?:the\s+)?(?:last\s+|past\s+)?(?:about\s+|pa\s+)?(?:a\s+|an\s+|few\s+|couple(?:\s+of)?\s+|\w+\s+)?(?:days?|weeks?|months?|years?|hours?|nights?|mornings?|yesterday|today|kahapon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|christmas|childhood|surgery|accident|fall|injury)|\w+\s+(?:linggo|araw|buwan|taon|semana|adlaw|bulan|tuig)\s+na)\b/i;
  const TRIGGER_RE = /\b((?:when(?:ever)?|every time|after|while|kapag|tuwing|kada|inig|pag)\s+(?:(?:i|he|she|they)\s+)?[a-z' ]{2,36})/i;
  // A symptom is treated as denied when a negation sits shortly before it.
  // hindi/wala(ng) (tl) · dili/walay (ceb)
  const NEG_TAIL_RE = /\b(?:no|not|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|never|without|denies|denied|hindi|walang?|walay|dili)\b[\w\s']{0,22}$/i;

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ---------------------------------------------------------------- *
   *  Summarizer
   * ---------------------------------------------------------------- */

  /** Turn the text around a body-part mention into a short paraphrase.
      ms/me mark where the body part sits inside windowText, so symptoms
      spoken close to the mention outrank ones from a different clause. */
  function summarize(windowText, ms, me) {
    const distFrom = (idx, len) => {
      if (idx + len <= ms) return ms - (idx + len);
      if (idx >= me) return idx - me;
      return 0;
    };
    const found = (vocab) =>
      vocab
        .map(([word, re]) => {
          const m = re.exec(windowText);
          if (!m) return null;
          const negated = NEG_TAIL_RE.test(
            windowText.slice(Math.max(0, m.index - 30), m.index)
          );
          return { word, d: distFrom(m.index, m[0].length), idx: m.index, negated };
        })
        .filter(Boolean)
        .sort((a, b) => a.d - b.d);

    const adjs = found(ADJECTIVES)
      .filter((a) => a.d <= 45 && !a.negated)
      .map((a) => a.word);
    const nearNouns = found(NOUNS).filter((n) => n.d <= 55);
    const posNouns = nearNouns.filter((n) => !n.negated);
    const negNouns = nearNouns.filter((n) => n.negated);

    let main = "";
    let denial = false;
    if (posNouns.length) {
      const primary = posNouns[0].word;
      const extra = posNouns.slice(1, 3).filter((n) => n.d <= 40).map((n) => n.word);
      main = adjs.length ? `${adjs.slice(0, 3).join(", ")} ${primary}` : primary;
      if (extra.length) main += ` with ${extra.join(" and ")}`;
      if (SEVERE_RE.test(windowText)) main = `significant ${main}`;
      else if (MILD_RE.test(windowText)) main = `mild ${main}`;
    } else if (negNouns.length) {
      denial = true;
      const spokenOrder = negNouns.slice(0, 3).sort((a, b) => a.idx - b.idx);
      main = `denies ${spokenOrder.map((n) => n.word).join(" and ")}`;
    } else if (adjs.length) {
      main = `${adjs.slice(0, 3).join(", ")} discomfort`;
      if (SEVERE_RE.test(windowText)) main = `significant ${main}`;
      else if (MILD_RE.test(windowText)) main = `mild ${main}`;
    }

    const bits = [];
    if (main) bits.push(cap(main));

    const rating = windowText.match(RATING_RE);
    if (rating && !denial) {
      const n = NUM_WORDS[rating[1].toLowerCase()] || rating[1];
      bits.push(`rated ${n}/10`);
    }

    const duration = windowText.match(DURATION_RE);
    if (duration) bits.push(`ongoing ${duration[1].trim()}`);

    const trigger = windowText.match(TRIGGER_RE);
    if (trigger && !denial) bits.push(`worse ${trigger[1].trim()}`);

    if (!bits.length) {
      const snippet = windowText.trim().replace(/\s+/g, " ").slice(0, 90);
      return `Mentioned this area — “${snippet}${windowText.trim().length > 90 ? "…" : ""}”`;
    }
    if (bits[0] !== cap(main) || !main) bits[0] = cap(bits[0]);
    return bits.join(" · ");
  }

  /* ---------------------------------------------------------------- *
   *  Clinical measurements (ROM, MMT, pain rating, special tests)
   * ---------------------------------------------------------------- */

  const ROM_RE = new RegExp(
    `\\b(?:(${SIDE_WORDS})\\s+)?` +
      `(shoulder|knee|hip|elbow|ankle|wrist|neck|cervical|lumbar|trunk|balikat|abaga|tuhod|siko|leeg|liog)\\s+` +
      `(flexion|extension|abduction|adduction|internal rotation|external rotation|rotation|dorsiflexion|plantar\\s?flexion|supination|pronation|lateral flexion)` +
      `(?:\\s+(?:is|was|to|at|measured|limited|now|about|around|approximately))*\\s+(\\d{1,3})\\s*degrees?\\b`,
    "gi"
  );
  const MMT_RE = /\b((?:[A-Za-z][\w-]*\s+){0,3}?)(?:strength|mmt)?\s*(?:is|was|graded?(?:\s+at)?|at)?\s*([0-5](?:\s*(?:plus|minus)|[+-])?)\s*(?:out of|\/)\s*(?:5|five)\b/gi;
  const SPECIAL_RE = /\b(positive|negative)\s+((?:[A-Za-z'’-]+\s+){1,4}?)(?:test|sign)\b/gi;

  function extractMeasurements(text, mentions) {
    const rom = [];
    const mmt = [];
    const special = [];
    const pain = [];

    ROM_RE.lastIndex = 0;
    let m;
    while ((m = ROM_RE.exec(text)) !== null) {
      rom.push({
        side: sideWord(m[1]),
        joint: m[2].toLowerCase(),
        motion: m[3].toLowerCase().replace(/\s+/g, " "),
        degrees: Number(m[4]),
      });
    }

    MMT_RE.lastIndex = 0;
    while ((m = MMT_RE.exec(text)) !== null) {
      // "6 out of 10" style pain ratings must not read as MMT
      const grade = m[2].replace(/\s*plus/i, "+").replace(/\s*minus/i, "-").trim();
      const context = m[1].trim();
      mmt.push({ context: context || null, grade: `${grade}/5` });
    }

    SPECIAL_RE.lastIndex = 0;
    while ((m = SPECIAL_RE.exec(text)) !== null) {
      special.push({ result: m[1].toLowerCase(), name: cap(m[2].trim()) + " test" });
    }

    const rating = text.match(RATING_RE);
    if (rating && !NEG_TAIL_RE.test(text.slice(Math.max(0, rating.index - 30), rating.index))) {
      const score = NUM_WORDS[rating[1].toLowerCase()] || Number(rating[1]);
      const where = mentions && mentions.length
        ? `${mentions[0].side ? mentions[0].side + " " : ""}${mentions[0].partName.toLowerCase()}`
        : null;
      pain.push({ score: Number(score), location: where });
    }

    return { rom, mmt, special, pain };
  }

  /* ---------------------------------------------------------------- *
   *  Section classifier (for evaluations / progress reports)
   * ---------------------------------------------------------------- */

  const SECTION_RULES = [
    ["precautions", /\b(precaution|avoid|do not|don't lift|no lifting|weight.?bearing|contraindicat|restrict|bawal|iwasan|ingat|likayan)\b/i],
    ["reason", /\b(referr(?:ed|al)|prescri(?:bed|ption)|sent (?:by|from)|doctor (?:sent|wants)|dahilan|ipinadala)\b/i],
    ["pmh", /\b(history of|diagnosed with|surgery|surgeries|underwent|operation|hypertension|diabetes|arthritis|years? ago|noong|kaniadto|inopera|opera(?:syon|tion))\b/i],
    ["assessment", /\b(assessment|impression|consistent with|likely|appears to (?:be|have)|prognosis|suspect)\b/i],
  ];

  /** Decide which documentation section an utterance belongs to.
      parsed = result of parseUtterance; measurements = extractMeasurements. */
  function classifyUtterance(text, parsed, measurements) {
    for (const [section, re] of SECTION_RULES) {
      if (re.test(text)) return section;
    }
    const meas = measurements || { rom: [], mmt: [], special: [], pain: [] };
    if (meas.rom.length || meas.mmt.length || meas.special.length) return "objective";
    if (parsed && (parsed.mentions.length || parsed.loose)) return "subjective";
    return "subjective";
  }

  /* ---------------------------------------------------------------- *
   *  Coordinates
   * ---------------------------------------------------------------- */

  function coordFor(part, side) {
    // dx offsets are from the centreline. In the front view the figure is
    // mirrored (patient's left = viewer's right); in the back view it isn't.
    let x = 100;
    if (part.dx) {
      let dir; // +1 => viewer's right
      if (side === "left") dir = part.view === "front" ? 1 : -1;
      else if (side === "right") dir = part.view === "front" ? -1 : 1;
      else dir = part.view === "front" ? -1 : 1; // unspecified: pick one side
      x = 100 + dir * part.dx;
    }
    return { x, y: part.y };
  }

  /* ---------------------------------------------------------------- *
   *  Utterance parsing
   * ---------------------------------------------------------------- */

  function expandLeft(t, i) {
    while (i > 0 && /\S/.test(t[i - 1]) && /\S/.test(t[i] || " ")) i--;
    return i;
  }
  function expandRight(t, i) {
    while (i < t.length && /\S/.test(t[i]) && /\S/.test(t[i - 1] || " ")) i++;
    return i;
  }

  function snippet(text, start, end) {
    const s = expandLeft(text, Math.max(0, start - 45));
    const e = expandRight(text, Math.min(text.length, end + 45));
    return (
      (s > 0 ? "…" : "") + text.slice(s, e).trim() + (e < text.length ? "…" : "")
    );
  }

  /** Earliest clinically interesting signal in a mention-free utterance —
      used to catch follow-up sentences like "It's a 6 out of 10 at night." */
  function firstSignal(text) {
    let best = null;
    const consider = (m) => {
      if (m && (best === null || m.index < best[0])) best = [m.index, m.index + m[0].length];
    };
    for (const [, re] of NOUNS) consider(re.exec(text));
    for (const [, re] of ADJECTIVES) consider(re.exec(text));
    consider(RATING_RE.exec(text));
    consider(TRIGGER_RE.exec(text));
    consider(DURATION_RE.exec(text));
    return best;
  }

  /**
   * Parse one finished utterance.
   * Returns { text, mentions, loose, measurements }:
   *  - mentions: body-part hits, each with map coordinates, a summarized
   *    note, and character ranges into `text` (for transcript highlighting)
   *  - loose: set when no body part was named but symptoms/ratings/triggers
   *    were — the app attaches it to the last point or flags it for review,
   *    so nothing a physical therapist would care about gets dropped.
   *  - measurements: {rom, mmt, special, pain} found in the utterance
   */
  function parseUtterance(rawText) {
    const text = String(rawText || "").trim().replace(/\s+/g, " ");
    const mentions = [];
    if (!text) return { text, mentions, loose: null, measurements: { rom: [], mmt: [], special: [], pain: [] } };

    const claimed = [];
    for (const part of BODY_PARTS) {
      part.re.lastIndex = 0;
      let m;
      while ((m = part.re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        claimed.push([start, end]);

        let side = null;
        if (part.fixedSide) side = part.fixedSide;
        else if (part.sided && m[1]) side = sideWord(m[1]);

        const winStart = expandLeft(text, Math.max(0, start - 80));
        const winEnd = expandRight(text, Math.min(text.length, end + 80));
        const windowText = text.slice(winStart, winEnd);
        const summary = summarize(windowText, start - winStart, end - winStart);
        const { x, y } = coordFor(part, side);

        mentions.push({
          partName: part.name,
          side,
          view: part.view,
          x,
          y,
          start,
          end,
          winStart,
          winEnd,
          summary,
          quote: snippet(text, start, end),
        });
      }
    }
    mentions.sort((a, b) => a.start - b.start);

    let loose = null;
    if (!mentions.length) {
      const anchor = firstSignal(text);
      if (anchor) {
        loose = {
          summary: summarize(text, anchor[0], anchor[1]),
          quote: snippet(text, anchor[0], anchor[1]),
        };
      }
    }

    const measurements = extractMeasurements(text, mentions);
    return { text, mentions, loose, measurements };
  }

  /* ---------------------------------------------------------------- *
   *  Coordinates by name — so a saved finding (from any past dictation,
   *  or from the AI refiner) always re-pins to the CURRENT mannequin,
   *  even if the figure's proportions change later.
   * ---------------------------------------------------------------- */

  const partByName = {};
  for (const p of BODY_PARTS) partByName[p.name.toLowerCase()] = p;

  function coordForName(name, side) {
    const clean = String(name || "").toLowerCase().trim();
    let part = partByName[clean];
    if (!part) {
      // free-form name (e.g. from Gemini): parse it to find the region
      const r = parseUtterance(name || "");
      if (r.mentions.length) {
        const m = r.mentions[0];
        return { x: coordFor(partByName[m.partName.toLowerCase()], side || m.side).x, y: m.y, view: m.view, part: m.partName, side: side || m.side || null };
      }
      part = partByName["back"]; // last-resort fallback
    }
    const { x, y } = coordFor(part, side || null);
    return { x, y, view: part.view, part: part.name, side: side || null };
  }

  /* ---------------------------------------------------------------- *
   *  Local transcript refiner (the offline / no-key fallback for the
   *  "Review & clean up with AI" pass). Splits a raw transcript into
   *  patient vs clinician turns and re-extracts findings from what the
   *  PATIENT said. The Gemini refiner returns the same shape but smarter.
   * ---------------------------------------------------------------- */

  // Marks a turn as the clinician speaking: a question, an instruction, or a
  // called-out objective measurement.
  const CLINICIAN_RE = /\?\s*$|\b(can you|could you|do you|does (?:it|that|this)|did (?:you|it)|are you|have you|where (?:is|does|do|are)|how (?:does|is|bad|long|much|old|many)|on a scale|rate (?:your|the|it)|point to|show me|let me|let's|lets|i'?m going to|i will|i'?ll|push (?:against|into|up|down)|resist|relax|breathe|turn (?:your|to|over)|lie (?:down|back|on)|stand (?:up|straight)|sit (?:up|down)|hold (?:still|this|that)|squeeze|tell me|any (?:pain|numbness|tingling|weakness)|follow my|repeat after|palpat|assess|saan|kailan|gaano|ituro|itudlo|subukan|asa|kanus-?a|pila ka|unsa imong)\b/i;

  function guessSpeaker(raw) {
    const t = String(raw || "").trim();
    if (!t) return "clinician";
    const r = parseUtterance(t);
    const hasObjMeas = r.measurements.rom.length || r.measurements.mmt.length || r.measurements.special.length;
    if (hasObjMeas) return "clinician"; // therapist reads out ROM/MMT/tests
    if (CLINICIAN_RE.test(t)) return "clinician";
    // the therapist narrates the interventions performed ("we did scaption…")
    if (TREATMENT_NARRATION_RE.test(t)) return "clinician";
    return "patient"; // default: hone in on the patient
  }

  // therapist narrating what was done this visit (distinct from a patient
  // simply mentioning "exercise"): needs an action verb or a clinical technique
  const TREATMENT_NARRATION_RE = /\b(perform|administered|applied|complete[ds]?|we did|did (?:some|the)|therex|scaption|manual therapy|soft tissue|mobiliz|ultrasound|e-?stim|dry needl|traction|taping|modalit)\w*/i;

  function tidy(raw) {
    let t = String(raw || "").trim().replace(/\s+/g, " ");
    if (!t) return "";
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (!/[.?!]$/.test(t)) t += ".";
    return t;
  }

  const uniqueJoin = (arr) => [...new Set(arr.filter(Boolean))].join(" · ");

  // treatments the therapist narrates ("we did scaption, manual therapy…")
  const TREATMENT_RE = /\b(perform|did|complete|exercis|therex|scaption|isometric|stretch|mobiliz|manual therapy|soft tissue|ultrasound|e-?stim|tens|modalit|hot pack|cold pack|ice|heat|gait|balance|strengthen|hep|home (?:exercise )?program|educat|taping|traction|dry needl)\w*/i;

  function refineTranscript(utterances) {
    const dialogue = [];
    const findingsMap = new Map();
    const patientSentences = [];
    const treatmentSentences = [];
    let lastKey = null;

    (utterances || []).forEach((raw) => {
      const text = tidy(raw);
      if (!text) return;
      const speaker = guessSpeaker(raw);
      const turnIndex = dialogue.length;
      dialogue.push({ speaker, text });

      if (TREATMENT_RE.test(raw)) treatmentSentences.push(text);
      if (speaker !== "patient") return;
      patientSentences.push(text);

      const r = parseUtterance(raw);
      if (r.mentions.length) {
        for (const m of r.mentions) {
          const key = `${m.partName}|${m.side || ""}`;
          let f = findingsMap.get(key);
          if (!f) {
            f = { key, part: m.partName, side: m.side, view: m.view, x: m.x, y: m.y, summaries: [], quotes: [], turns: [] };
            findingsMap.set(key, f);
          }
          f.summaries.push(m.summary);
          f.quotes.push(m.quote);
          f.turns.push(turnIndex);
          lastKey = key;
        }
      } else if (r.loose && lastKey) {
        const f = findingsMap.get(lastKey);
        if (f) { f.summaries.push(r.loose.summary); f.quotes.push(r.loose.quote); f.turns.push(turnIndex); }
      }
    });

    const findings = [...findingsMap.values()].map((f) => ({
      key: f.key, part: f.part, side: f.side, view: f.view, x: f.x, y: f.y,
      summary: uniqueJoin(f.summaries), quote: f.quotes[0] || "", turns: f.turns,
    }));

    const measurements = aggregateMeasurements(dialogue.map((d) => d.text));
    return {
      dialogue, findings, measurements, source: "local",
      subjective: patientSentences.join(" "),
      treatment: treatmentSentences.join(" "),
    };
  }

  // run measurement extraction across every turn and de-duplicate
  function aggregateMeasurements(texts) {
    const out = { rom: [], mmt: [], special: [], pain: [] };
    const seen = new Set();
    for (const t of texts) {
      const m = extractMeasurements(t, []);
      for (const kind of ["rom", "mmt", "special", "pain"]) {
        for (const item of m[kind]) {
          const sig = kind + ":" + JSON.stringify(item);
          if (!seen.has(sig)) { seen.add(sig); out[kind].push(item); }
        }
      }
    }
    return out;
  }

  return {
    parseUtterance,
    summarize,
    coordFor,
    coordForName,
    extractMeasurements,
    aggregateMeasurements,
    classifyUtterance,
    guessSpeaker,
    refineTranscript,
    BODY_PARTS,
  };
});
