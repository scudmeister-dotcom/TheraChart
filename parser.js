/* TheraChart parser — the listening brain, kept free of DOM code so the
   exact same logic runs in the browser app and in the offline test checker
   (node test/parser.test.js). */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- *
   *  Body-part lexicon
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
    P("Lower back", "lower\\s+back|lumbar(?:\\s+region)?|small of (?:my|the|his|her) back", { view: "back", y: 178 }),
    P("Upper back", "upper\\s+back", { view: "back", y: 110 }),
    P("Mid back", "mid(?:dle)?[-\\s]?back", { view: "back", y: 145 }),
    P("Shoulder blade", "shoulder\\s+blades?|scapula", { view: "back", dx: 24, y: 112, sided: true }),
    P("Back of head", "back of (?:my|the|his|her) head", { view: "back", y: 36 }),
    P("Back of neck", "back of (?:my|the|his|her) neck", { view: "back", y: 66 }),
    P("Tailbone", "tail\\s?bone|coccyx", { view: "back", y: 200 }),
    P("Spine", "spine|spinal", { view: "back", y: 140 }),
    P("Buttock", "buttocks?|glutes?|gluteal|rear end", { view: "back", dx: 15, y: 210, sided: true }),
    P("Hamstring", "hamstrings?", { view: "back", dx: 16, y: 265, sided: true }),
    P("Achilles", "achilles(?:\\s+tendon)?", { view: "back", dx: 15, y: 398, sided: true }),
    P("Heel", "heels?", { view: "back", dx: 15, y: 410, sided: true }),
    P("Calf", "calf|calves", { view: "back", dx: 16, y: 350, sided: true }),
    // Generic "back" only when clearly the body part:
    // needs a possessive before it, and not "back of" / "behind my back".
    P("Back", "(?<=\\b(?:my|his|her|your|the)\\s)(?<!behind (?:my|his|her|your|the)\\s)back\\b(?!\\s+of)", { view: "back", y: 150 }),

    // Head & face
    P("Forehead", "forehead", { y: 24 }),
    P("Temple", "temples?", { dx: 14, y: 28, sided: true }),
    P("Eye", "eyes?|eyebrows?|eyelids?", { dx: 8, y: 32, sided: true }),
    P("Ear", "ears?|earlobes?", { dx: 18, y: 36, sided: true }),
    P("Nose", "nose|sinus(?:es)?", { y: 38 }),
    P("Jaw", "jaws?|tmj", { dx: 10, y: 48, sided: true }),
    P("Mouth", "mouth|teeth|tooth|gums?|tongue|lips?", { y: 46 }),
    P("Head", "head|skull|headaches?|migraines?", { y: 34 }),
    P("Throat", "throat", { y: 70 }),
    P("Neck", "neck", { y: 66 }),

    // Torso
    P("Collarbone", "collar\\s?bones?|clavicle", { dx: 22, y: 84, sided: true }),
    P("Armpit", "armpits?|underarms?", { dx: 38, y: 100, sided: true }),
    P("Shoulder", "shoulders?|rotator cuff|deltoids?", { dx: 40, y: 86, sided: true }),
    P("Heart", "heart", { dx: 14, y: 112, fixedSide: "left" }),
    P("Chest", "chest|pec(?:toral)?s?|breast\\s?bone|sternum", { dx: 14, y: 112, sided: true }),
    P("Ribs", "ribs?|rib\\s?cage", { dx: 20, y: 135, sided: true }),
    P("Navel", "navel|belly\\s?button", { y: 170 }),
    P("Stomach", "stomach(?:\\s?aches?)?|belly|abdomen|abdominal|tummy|gut", { y: 160 }),
    P("Pelvis", "pelvis|pelvic", { y: 200 }),
    P("Groin", "groin", { y: 206 }),
    P("Hip", "hips?", { dx: 30, y: 196, sided: true }),

    // Arms (specific before generic "arm")
    P("Upper arm", "upper\\s+arms?|biceps?|triceps?", { dx: 48, y: 120, sided: true }),
    P("Elbow", "elbows?", { dx: 53, y: 155, sided: true }),
    P("Forearm", "forearms?", { dx: 57, y: 185, sided: true }),
    P("Wrist", "wrists?", { dx: 61, y: 215, sided: true }),
    P("Thumb", "thumbs?", { dx: 60, y: 246, sided: true }),
    P("Finger", "fingers?|knuckles?|pinky", { dx: 66, y: 248, sided: true }),
    P("Hand", "hands?|palms?", { dx: 64, y: 236, sided: true }),
    P("Arm", "arms?", { dx: 52, y: 150, sided: true }),

    // Legs (specific before generic "leg")
    P("Thigh", "thighs?|quad(?:ricep)?s?", { dx: 16, y: 260, sided: true }),
    P("Kneecap", "knee\\s?caps?|patella", { dx: 15, y: 303, sided: true }),
    P("Knee", "knees?", { dx: 15, y: 305, sided: true }),
    P("Shin", "shins?", { dx: 16, y: 350, sided: true }),
    P("Ankle", "ankles?", { dx: 15, y: 392, sided: true }),
    P("Toe", "(?:big\\s+)?toes?", { dx: 24, y: 416, sided: true }),
    P("Foot", "foot|feet", { dx: 21, y: 408, sided: true }),
    P("Leg", "legs?", { dx: 16, y: 300, sided: true }),
  ];

  // Compile one regex per entry, with an optional left/right capture in front.
  for (const part of BODY_PARTS) {
    part.re = new RegExp(
      `\\b(?:(left|right)\\s+(?:\\w+\\s+)??)?(?:${part.kw})\\b`,
      "gi"
    );
  }

  /* ---------------------------------------------------------------- *
   *  Symptom vocabulary used to write the summary "in my own words"
   * ---------------------------------------------------------------- */

  const ADJECTIVES = [
    ["sharp", /\bsharp\b/i],
    ["dull", /\bdull\b/i],
    ["throbbing", /\bthrobbing\b/i],
    ["stabbing", /\bstabbing\b/i],
    ["shooting", /\bshoot(?:s|ing)?\b/i],
    ["burning", /\bburn(?:s|ing)?\b/i],
    ["radiating", /\bradiat(?:es|ing)\b/i],
    ["constant", /\bconstant(?:ly)?\b/i],
    ["intermittent", /\b(?:intermittent|comes and goes|on and off)\b/i],
    ["deep", /\bdeep\b/i],
    ["chronic", /\bchronic\b/i],
  ];

  const NOUNS = [
    ["headache", /\b(?:headaches?|migraines?)\b/i],
    ["pain", /\b(?:pain(?:ful)?|hurt(?:s|ing)?|ach(?:e|es|ing|y)|sting(?:s|ing)?|killing me|agony)\b/i],
    ["soreness", /\bsore(?:ness)?\b/i],
    ["stiffness", /\bstiff(?:ness)?\b/i],
    ["tightness", /\btight(?:ness)?\b/i],
    ["numbness", /\bnumb(?:ness)?\b/i],
    ["tingling", /\b(?:tingl(?:e|es|ing|y)|pins and needles)\b/i],
    ["cramping", /\b(?:cramp(?:s|ing)?|spasm(?:s|ing)?)\b/i],
    ["swelling", /\b(?:swollen|swelling|puffy|inflam(?:ed|mation))\b/i],
    ["weakness", /\b(?:weak(?:ness)?|giv(?:es?|ing) out)\b/i],
    ["bruising", /\bbruis(?:e|ed|es|ing)\b/i],
    ["itching", /\bitch(?:y|ing|es)?\b/i],
    ["tenderness", /\btender(?:ness)?\b/i],
    ["clicking", /\b(?:click(?:s|ing)?|pop(?:s|ping)|crack(?:s|ing)|grind(?:s|ing))\b/i],
    ["locking", /\block(?:s|ed|ing)(?:\s+up)?\b/i],
    ["dizziness", /\b(?:dizzy|dizziness|light-?headed)\b/i],
    ["pressure", /\b(?:pressure|tension)\b/i],
    ["instability", /\b(?:unstable|instability|wobbly|buckl(?:es|ing))\b/i],
    ["a possible sprain", /\bsprain(?:ed)?\b/i],
    ["a possible strain", /\b(?:strain(?:ed)?|pulled)\b/i],
    ["a possible tear", /\b(?:tore|torn)\b/i],
    ["a possible fracture", /\b(?:broke(?:n)?|fracture(?:d)?)\b/i],
    ["a twist injury", /\btwisted\b/i],
  ];

  const SEVERE_RE = /\b(really|very|extremely|severe(?:ly)?|terribl[ye]|excruciating|unbearable|awful|so much|super|badly|killing me)\b/i;
  const MILD_RE = /\b(slightly|a\s+(?:little|bit|touch)|mild(?:ly)?|minor|somewhat|kind of|sort of)\b/i;
  const RATING_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\/|out of)\s*(?:10|ten)\b/i;
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const DURATION_RE = /\b((?:for|since|over)\s+(?:the\s+)?(?:last\s+|past\s+)?(?:about\s+)?(?:a\s+|an\s+|few\s+|couple(?:\s+of)?\s+|\w+\s+)?(?:days?|weeks?|months?|years?|hours?|nights?|mornings?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|christmas|childhood|surgery|accident|fall|injury))\b/i;
  const TRIGGER_RE = /\b((?:when(?:ever)?|every time|after|while)\s+(?:(?:i|he|she|they)\s+)?[a-z' ]{2,36})/i;
  // A symptom is treated as denied when a negation sits shortly before it.
  const NEG_TAIL_RE = /\b(?:no|not|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|never|without|denies|denied)\b[\w\s']{0,22}$/i;

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
   * Returns { text, mentions, loose }:
   *  - mentions: body-part hits, each with map coordinates, a summarized
   *    note, and character ranges into `text` (for transcript highlighting)
   *  - loose: set when no body part was named but symptoms/ratings/triggers
   *    were — the app attaches it to the last point or flags it for review,
   *    so nothing a physical therapist would care about gets dropped.
   */
  function parseUtterance(rawText) {
    const text = String(rawText || "").trim().replace(/\s+/g, " ");
    const mentions = [];
    if (!text) return { text, mentions, loose: null };

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
        else if (part.sided && m[1]) side = m[1].toLowerCase();

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
    return { text, mentions, loose };
  }

  return { parseUtterance, summarize, coordFor, BODY_PARTS };
});
