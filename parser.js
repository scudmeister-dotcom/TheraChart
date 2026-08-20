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
    P("Lower back", "low(?:er)?\\s+back|lumbar(?:\\s+region)?|small of (?:my|the|his|her) back|b[ae]ywang|bewang|hawak", { view: "back", y: 178 }),
    P("Upper back", "upper\\s+back", { view: "back", y: 110 }),
    P("Mid back", "mid(?:dle)?[-\\s]?back", { view: "back", y: 145 }),
    P("Shoulder blade", "shoulder\\s+blades?|scapula[er]?|scapular|paypay", { view: "back", dx: 24, y: 112, sided: true }),
    P("Trapezius", "upper\\s+traps?(?:ezius)?|trapezius", { view: "back", dx: 22, y: 88, sided: true }),
    P("Back of head", "back of (?:my|the|his|her) head|batok", { view: "back", y: 36 }),
    P("Back of neck", "back of (?:my|the|his|her) neck|nape(?: of (?:my|the|his|her) neck)?|tangkugo", { view: "back", y: 66 }),
    P("Tailbone", "tail\\s?bone|coccyx|coccygeal", { view: "back", y: 206 }),
    P("SI joint", "sacro-?iliac(?:\\s+joints?)?|si\\s+joints?", { view: "back", dx: 9, y: 200, sided: true }),
    P("Sacrum", "sacrum|sacral", { view: "back", y: 198 }),
    P("Spine", "spine|spinal|vertebrae?|vertebral|gulugod", { view: "back", y: 140 }),
    /* "Butt", "bum" and "my bottom" are what patients actually say. Leaving
       them out did not make the note more clinical — it made the gluteal
       region silently unrecordable, which is worse. "bottom" needs a
       possessive in front and must not be "bottom OF my foot"; "butt" is safe
       on its own because \b keeps it out of "button". */
    P("Buttock", "buttocks?|butt\\s*cheeks?|butts?|bum\\s*cheeks?|bums?|backside|rear\\s?ends?|glute(?:us|al)?s?|gluteus\\s+(?:maximus|medius|minimus)|sit\\s?bones?|ischial\\s+tuberosit(?:y|ies)|(?<=\\b(?:my|his|her|your|the)\\s)bottom\\b(?!\\s+of)|puwit|pwet|lubot|pigi|samput",
      { view: "back", dx: 15, y: 214, sided: true }),
    /* "The back of my leg" has to land on the BACK view. It used to fall
       through to the generic front-view "Leg", which put a posterior complaint
       on the wrong figure. Posterior thigh is the standard reading. */
    P("Hamstring", "hamstrings?|ham\\s?strings?|biceps femoris|semitendinosus|semimembranosus|backs?\\s+of\\s+(?:my|the|his|her|your)\\s+(?:\\w+\\s+){0,3}?(?:upper\\s+)?(?:legs?|thighs?)|likod\\s+ng\\s+(?:\\w+\\s+){0,3}?(?:hita|paa)|luyo\\s+sa\\s+(?:\\w+\\s+){0,3}?(?:paa|hita)", { view: "back", dx: 16, y: 265, sided: true }),
    P("Flank", "flanks?|love\\s?handles?|tagiliran|(?<=\\bakong\\s)kilid|kilid(?=\\s+(?:ko|nako|nimo|niya))", { view: "back", dx: 26, y: 168, sided: true }),
    P("Achilles", "achilles(?:\\s+tendon)?", { view: "back", dx: 15.5, y: 392, sided: true }),
    P("Heel", "heels?|sakong|tikod", { view: "back", dx: 16, y: 404, sided: true }),
    P("Calf", "backs?\\s+of\\s+(?:my|the|his|her|your)\\s+(?:\\w+\\s+){0,3}?(?:calf|calves|lower\\s+legs?)|likod\\s+ng\\s+(?:\\w+\\s+){0,3}?(?:binti|bitiis)|luyo\\s+sa\\s+(?:\\w+\\s+){0,3}?(?:bitiis|binti)|calf|calves|gastroc(?:nemius)?|soleus|alak-?alakan|binti|b[ai]tiis", { view: "back", dx: 16, y: 350, sided: true }),
    // Generic "back" only when clearly the body part:
    // needs a possessive before it, and not "back of" / "behind my back".
    // "likod" (tl/ceb) is always the body part.
    // …or when a symptom word follows it directly ("back pain", "backache").
    P("Back", "(?<=\\b(?:my|his|her|your|the)\\s)(?<!behind (?:my|his|her|your|the)\\s)back\\b(?!\\s+of)|back(?=\\s*ache|\\s+(?:pain|aches?|aching|hurts?|spasms?|stiffness|soreness|tightness))|likod|buko-?buko", { view: "back", y: 150 }),

    // Head & face
    P("Scalp", "scalps?", { y: 20 }),
    P("Forehead", "forehead|noo|agtang", { y: 24 }),
    P("Temple", "temples?|sentido", { dx: 14, y: 28, sided: true }),
    P("Eye", "eyes?|eyebrows?|eyelids?|mata", { dx: 8, y: 32, sided: true }),
    P("Ear", "ears?|earlobes?|tenga|tainga|dalunggan", { dx: 18, y: 36, sided: true }),
    P("Nose", "nose|sinus(?:es)?|ilong", { y: 38 }),
    P("Jaw", "jaws?|jawlines?|tmj|temporomandibular|panga|apapangig", { dx: 10, y: 48, sided: true }),
    P("Chin", "chins?|suwang|sulang", { y: 54 }),
    P("Cheek", "cheeks?|pisngi|aping", { dx: 13, y: 42, sided: true }),
    P("Mouth", "mouth|teeth|tooth|gums?|tongue|lips?|bibig|bunganga|ngipin|ngipon|dila", { y: 46 }),
    P("Head", "head|skull|headaches?|migraines?|ulo", { y: 34 }),
    P("Throat", "throat|lalamunan|tutunlan", { y: 70 }),
    P("Neck", "neck|cervical(?:\\s+spine)?|leeg|liog", { y: 66 }),

    // Torso
    P("Collarbone", "collar\\s?bones?|clavicle", { dx: 13, y: 88, sided: true }),
    P("Armpit", "armpits?|underarms?|kili-?kili|ilok", { dx: 38, y: 105, sided: true }),
    P("Shoulder", "shoulders?|rotator cuffs?|deltoids?|ac\\s+joints?|acromioclavicular|acromion|supraspinatus|infraspinatus|subscapularis|glenohumeral|balikat|abaga", { dx: 46, y: 95, sided: true }),
    // lookahead skips emotional idioms ("my heart wasn't in it")
    P("Heart", "heart(?!\\s*(?:wasn'?t|isn'?t|was\\s+not|is\\s+not|goes\\s+out|went\\s+out|of\\s+gold|set\\s+on|-?\\s?to-?\\s?heart))|puso", { dx: 14, y: 112, fixedSide: "left" }),
    P("Chest", "chest|pec(?:toral)?s?|breast\\s?bone|sternum|dibdib|dughan", { dx: 14, y: 112, sided: true }),
    /* After Chest, so "breast bone" still reads as the sternum. */
    P("Breast", "breasts?|suso", { dx: 16, y: 118, sided: true }),
    P("Ribs", "ribs?|rib\\s?cage|costal|inter-?costal|tadyang|gusok", { dx: 20, y: 135, sided: true }),
    P("Navel", "navel|belly\\s?button|pusod", { y: 170 }),
    P("Stomach", "stomach(?:\\s?aches?)?|belly|abdomen|abdominal|tummy|gut|obliques?|tiyan|sikmura|puson", { y: 160 }),
    /* Pelvic-health work is physical therapy too, and a patient describing it
       uses lay words. A region the system refuses to hear is a region that
       cannot be treated or billed for. */
    P("Pelvic floor", "pelvic\\s+floors?|perine(?:um|al)|pubic(?:\\s+(?:bone|symphysis|area))?|pubis", { y: 230 }),
    P("Genitals", "genitals?|genital\\s+area|privates?|penis|scrotum|testicles?|vagina|vaginal|vulva|labia|puki|titi|bayag", { y: 226 }),
    P("Pelvis", "pelvis|pelvic|iliac crests?|asis", { y: 205 }),
    P("Groin", "groin|adductors?|inner\\s+thighs?|singit", { y: 224 }),
    P("Hip", "hips?|hip\\s+flexors?|greater\\s+trochanters?|trochanteric|balakang|bat-?ang", { dx: 31, y: 202, sided: true }),

    // Arms (specific before generic "arm")
    P("Upper arm", "upper\\s+arms?|biceps?|triceps?", { dx: 51, y: 125, sided: true }),
    P("Elbow", "elbows?|tennis\\s+elbows?|golfer'?s?\\s+elbows?|olecranon|funny\\s+bones?|(?:lateral|medial)\\s+epicondyl\\w*|siko", { dx: 55, y: 154, sided: true }),
    P("Forearm", "forearms?|bisig", { dx: 59, y: 182, sided: true }),
    P("Wrist", "wrists?|carpal\\s+tunnels?|carpals?|pulso|pulsuhan|galang-?galangan", { dx: 63, y: 210, sided: true }),
    P("Thumb", "thumbs?|hinlalaki|kumagko", { dx: 61, y: 238, sided: true }),
    // Toe phrases must win over Finger ("daliri sa paa" = toe, not finger)
    P("Toe", "(?:big|great|pink(?:y|ie)|little)?\\s*toes?|hallux|toe\\s?nails?|daliri sa paa|tudlo sa tiil", { dx: 21.5, y: 412, sided: true }),
    P("Finger", "fingers?|knuckles?|pink(?:y|ie)|(?:index|middle|ring)\\s+fingers?|daliri|tudlo", { dx: 67, y: 243, sided: true }),
    P("Hand", "hands?|palms?|kamay|kamot|palad", { dx: 65, y: 228, sided: true }),
    P("Arm", "arms?|braso|bukton", { dx: 54, y: 150, sided: true }),

    // Legs (specific before generic "leg")
    P("IT band", "i\\.?t\\.?\\s?bands?|iliotibial(?:\\s+bands?)?", { dx: 22, y: 275, sided: true }),
    P("Thigh", "thighs?|quad(?:ricep)?s?|outer\\s+thighs?|hita", { dx: 16, y: 260, sided: true }),
    P("Kneecap", "knee\\s?caps?|patella[er]?|patellar\\s+tendons?", { dx: 16, y: 308, sided: true }),
    P("Knee", "knees?|meniscus|menisci|acl|mcl|pcl|lcl|tuhod", { dx: 16, y: 310, sided: true }),
    P("Shin", "shins?|shin\\s+splints?|tibias?|tibial|lulod", { dx: 16, y: 350, sided: true }),
    P("Ankle", "ankles?|malleol\\w*|bukong-?bukong|buol-?buol", { dx: 15, y: 392, sided: true }),
    // Longest phrases first so "ball of my foot" isn't just "foot".
    P("Foot", "balls?\\s+of\\s+(?:my|the|his|her|your)\\s+(?:foot|feet)|(?:soles?|arch(?:es)?)\\s+of\\s+(?:my|the|his|her|your)\\s+(?:foot|feet)|plantar\\s+fasci\\w*|plantar\\s+(?:surface|aspect)|insteps?|bunions?|foot|feet|talampakan|lapa-?lapa|tiil", { dx: 18.5, y: 403, sided: true }),
    // "paa" is foot/leg in Tagalog and thigh in Cebuano — mapped to the leg
    P("Leg", "legs?|paa", { dx: 16, y: 300, sided: true }),
  ];

  // Optional left/right words, in all three languages.
  // kaliwa(ng) = left (tl) · wala(ng) = left (ceb) · kanan(g) = right (tl)
  // tuo(ng) = right (ceb). "both"/"bilateral"/"pareho" mark both sides and
  // are expanded into two mentions. Normalized by sideWord().
  /* Every word has to list its BARE form as well as its linked one. "kaliwang?"
     spells kaliwan/kaliwang and so never matched a plain "kaliwa" — while
     "kanang?" happens to spell kanan/kanang and did. The result was a
     laterality bug that only ever lost the LEFT side: "masakit ang kaliwa kong
     tuhod" charted a knee with no side, and "kanan" charted a right one. */
  const SIDE_WORDS = "left|right|both|bilateral(?:ly)?|pareho(?:ng)?|kaliwa(?:ng)?|kanan(?:g)?|wala(?:ng)?|tuo(?:ng)?";
  const LEFT_RE = /^(left|kaliwa|wala)/i;
  const BOTH_RE = /^(both|bilateral|pareho)/i;

  function sideWord(raw) {
    if (!raw) return null;
    if (BOTH_RE.test(raw)) return "both";
    return LEFT_RE.test(raw) ? "left" : "right";
  }

  /* Compile one regex per entry, with an optional side capture on EITHER side
     of the part.

     Group 1 is the leading form ("left knee", "kaliwang tuhod") and now also
     covers "left side of my …", which the one-filler-word lookahead used to
     walk straight past — so "the left side of my butt" pinned the buttock with
     no side at all. Group 2 is the trailing form ("my butt on the left side"),
     which patients use just as often. Whichever fired, sideWord() normalizes
     it the same way. */
  const SIDE_PREFIX = `(?:(${SIDE_WORDS})\\s+(?:sides?\\s+of\\s+(?:my|the|his|her|your)\\s+)?(?:nga\\s+)?(?:\\w+\\s+)??)?`;
  /* Two trailing shapes. The first spells out "side", so it can stand alone.
     The second ("on the right") must keep the word "on" — without it "my knee
     right now" would read as a right knee. */
  /* A third shape, and the one an answer takes: asked "which knee?", nobody
     repeats the word knee — they say "the right one". Dictation puts that in
     the same breath as the region ("my knee, the um, the right one"), so the
     side sat a filler word away from the part and was thrown away. */
  const SIDE_SUFFIX = `(?:[,\\s]+(?:(?:on\\s+)?(?:the\\s+)?(${SIDE_WORDS})\\s+sides?\\b|on\\s+(?:the\\s+)?(${SIDE_WORDS})\\b|(?:the\\s+)?(?:\\w+[,\\s]+){0,2}?(${SIDE_WORDS})\\s+ones?\\b))?`;
  for (const part of BODY_PARTS) {
    part.re = new RegExp(`\\b${SIDE_PREFIX}(?:${part.kw})\\b${SIDE_SUFFIX}`, "gi");
  }

  /* ---------------------------------------------------------------- *
   *  Symptom vocabulary used to write the summary "in my own words"
   * ---------------------------------------------------------------- */

  const ADJECTIVES = [
    ["sharp", /\b(?:sharp|kirot|kumikirot|nangingirot|matalim|parang (?:may )?(?:kutsilyo|tinutusok)|hait)\b/i],
    ["dull", /\b(?:dull|mapurol|mahinang sakit)\b/i],
    ["throbbing", /\b(?:throbbing|ngutngut|nagangutngut|nagngutngot|nangungutngot|pumipintig|kumakabog|nagkutoy)\b/i],
    ["stabbing", /\b(?:stabbing|parang sinasaksak|gitusok)\b/i],
    ["shooting", /\b(?:shoot(?:s|ing)?|parang kuryente|may kuryente|kilat|kuryente)\b/i],
    ["burning", /\b(?:burn(?:s|ing)?|hapdi|mahapdi|nasusunog|parang nasusunog|nagbaga|hapdos)\b/i],
    ["radiating", /\b(?:radiat(?:es|ing)|kumakalat|nagkakalat|gumagapang|mikaylap|nagkatag)\b/i],
    ["constant", /\b(?:constant(?:ly)?|palagi|lagi|parati|kanunay|permi|kada oras)\b/i],
    ["intermittent", /\b(?:intermittent|comes and goes|on and off|paminsan-?minsan|minsan lang|usahay|panagsa)\b/i],
    ["deep", /\b(?:deep|malalim|lawom)\b/i],
    ["chronic", /\b(?:chronic|matagal na|dugay na)\b/i],
  ];

  const NOUNS = [
    ["headache", /\b(?:headaches?|migraines?)\b/i],
    ["pain", /\b(?:pain(?:ful)?|hurt(?:s|ing)?|ach(?:e|es|ing|y)|sting(?:s|ing)?|killing me|agony|(?:napaka|ma)?sakit|sumasakit|nagsakit|ga-?sakit|sakitan|sakit(?:on)?|masakitan|kirot|kumikirot|nangingirot|ngutngut|nagangutngut|nagngutngot|nangungutngot|hapdi|mahapdi|hapdos)\b/i],
    ["soreness", /\bsore(?:ness)?\b/i],
    ["stiffness", /\b(?:stiff(?:ness)?|naninigas|paninigas|matigas|gahi|nagahi|tikig|nanigas)\b/i],
    ["tightness", /\b(?:tight(?:ness)?|hig-?ot|masikip|banat|nabanat)\b/i],
    ["numbness", /\b(?:numb(?:ness)?|manhid|(?:na|nag)ma-?manhid|pamamanhid|binhod|nabinhod|gibinhod|nangalay|nangangalay|ngalay)\b/i],
    ["tingling", /\b(?:tingl(?:e|es|ing|y)|pins and needles|tusok-?tusok|tinutusok)\b/i],
    ["cramping", /\b(?:cramp(?:s|ing)?|spasm(?:s|ing)?|pulikat|nangalambre|kalambr[ei]|kimay)\b/i],
    ["swelling", /\b(?:swollen|swelling|puffy|inflam(?:ed|mation)|n?a?mamaga|pamamaga|namaga|maga|hubag|nanghubag|nihubag|gihubag)\b/i],
    ["weakness", /\b(?:weak(?:ness)?|giv(?:es?|ing) out|mahina|nanghihina|panghihina|walang lakas|luya|naluya|giluya|kaluya|walay kusog)\b/i],
    ["bruising", /\b(?:bruis(?:e|ed|es|ing)|pasa)\b/i],
    ["itching", /\b(?:itch(?:y|ing|es)?|makati|nangangati|pangangati|kati|katol|gipangalot|katlo)\b/i],
    ["tenderness", /\btender(?:ness)?\b/i],
    ["clicking", /\b(?:click(?:s|ing)?|pop(?:s|ped|ping)|crack(?:s|ing)|grind(?:s|ing)|lagutok|naglagutok|kumakalutok|nagkalutok|nagkabuko)\b/i],
    ["locking", /\block(?:s|ed|ing)(?:\s+up)?\b/i],
    ["dizziness", /\b(?:dizzy|dizziness|light-?headed|nahihilo|hilo|nalilipong|naglipong|lipong|gikalipong|liyo)\b/i],
    ["pressure", /\b(?:(?<!blood\s)pressure|tension)\b/i],
    ["instability", /\b(?:unstable|instability|wobbly|buckl(?:es|ing))\b/i],
    ["a possible sprain", /\bsprain(?:ed)?\b/i],
    ["a possible strain", /\b(?:strain(?:ed)?|pulled)\b/i],
    ["a possible tear", /\b(?:tore|torn)\b/i],
    ["a possible fracture", /\b(?:broke(?:n)?|fracture(?:d)?|nabali|nabuak)\b/i],
    ["a twist injury", /\b(?:twisted|napilay|pilay|nalisa|nasalisi|napiang)\b/i],
    /* Tiredness and "I can't move it" are complaints in their own right —
       both are everyday Filipino descriptions of a musculoskeletal problem,
       and both used to land as a bare "Mentioned this area". */
    ["fatigue", /\b(?:fatigue[ds]?|worn out|exhaust(?:ed|ion)|pagod(?: na pagod)?|napapagod|nanlalata|kapoy(?: kaayo)?|gikapoy|hapo)\b/i],
    /* The polite particle and the hyphen are the two things that broke this.
       Filipino speakers say "hindi ko PO maisuot" and "hindi ko MA-LIFT" —
       one particle between the pronoun and the verb, or an English verb
       carrying a Filipino prefix across a hyphen — and neither shape matched,
       so "I can't put my socks on" in Tagalog registered as nothing at all. */
    ["difficulty moving", /\b(?:can'?t (?:move|lift|bend|straighten)|(?:hard|difficult|struggl\w+) to (?:move|lift|bend|walk)|limited motion|hirap(?: ako| akong| na)?|nahihirapan|hindi ko(?:\s+(?:po|nga|talaga|kasi|masyado|na|man))*\s+ma-?\w+|di ko(?:\s+po)?\s+ma-?\w+|hindi ko (?:maigalaw|maiangat)|lisod|naglisod|dili ko(?:\s+(?:kaya|mahimo))|dili (?:ko )?maka-?\w+|dili ko ma-?\w+|dili malihok|wala ko kaya)\b/i],
    /* What the patient can no longer DO is the other half of a subjective
       report, and the vocabulary above only heard about joints. "I can't put
       my socks on" and "I have trouble sleeping through the night" are the
       sentences a therapist writes goals against, and neither registered as
       clinical at all. */
    ["difficulty with daily activity", /\b(?:can'?t|cannot|couldn'?t|unable to|no longer able to)\s+(?:\w+\s+){0,2}?(?:sleep|walk|stand|sit|climb|reach|carry|drive|work|dress|shower|bathe|kneel|squat|run|write|type|cook|garden|put)\b|\b(?:trouble|difficulty|problems?)\s+(?:with\s+)?(?:\w+ing|stairs|sleep|walking|standing|sitting|dressing|driving|work)\b|\bhirap\s+(?:matulog|maglakad|tumayo|umupo|umakyat|magbihis)\b/i],
    ["warmth", /\b(?:warm to the touch|hot to the touch|nag-?init|mainit|init-?init|nag-?ka-?init)\b/i],
    /* What the therapist SEES. Posture and gait are half of an objective
       exam and none of this vocabulary registered as clinical, so "the right
       shoulder sits higher than the left" read as a region named and nothing
       said about it — the same verdict as "point to your shoulder". */
    ["asymmetry", /\b(?:mas\s+(?:mataas|mababa|malaki|maliit|nakaangat)|hindi\s+pantay|dili\s+patas|kumpara\s+sa|compared\s+sa|nakaangat|nakababa|sits?(?: \w+)? (?:higher|lower)|(?:is|are|looks?|appears?)(?: \w+)? (?:higher|lower) than|elevated|depressed shoulder|asymmetr\w*|uneven|drop(?:ped)? shoulder|winging|winged|hik(?:e|ed|ing)|lateral shift|forward head|rounded shoulders|kyphotic|lordotic|scoliotic|antalgic|guard(?:ed|ing)|atroph\w*|wasting)\b/i],
    // Reassurance — "my knee is fine" must never read as a complaint.
    ["feeling fine", /\b(?:fine|feels? (?:good|great|normal|okay)|no (?:issues|problems|complaints)|back to normal|maayos(?: ra)?|ayos(?: lang)?|okay lang)\b/i],
  ];

  const SEVERE_RE = /\b(really|very|extremely|severe(?:ly)?|terribl[ye]|excruciating|unbearable|awful|so much|super|badly|killing me|sobrang?|grabe(?:\s+kaayo)?|kaayo|napaka\w+|matindi|tindi|masyado|hindi na (?:matiis|kaya)|di na (?:matiis|kaya)|sakit na sakit|labihan|hilabihan|dili na maagwanta)\b/i;
  const MILD_RE = /\b(slightly|a\s+(?:little|bit|touch)|mild(?:ly)?|minor|somewhat|kind of|sort of|medyo|gamay(?: ra| lang)?|konti|kaunti|onti|bahagya|di(?:\s|-)?gaano|diyutay|gamay ra)\b/i;
  // Word numerals included: cloud STT (chirp) spells small numbers out, and it
  // transcribes Tagalog/Cebuano counting as words rather than digits — so
  // "pito sa sampu" has to score the same as "seven out of ten".
  const RATING_RE = /\b(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|sero|isa|dalawa|tatlo|apat|lima|anim|pito|walo|siyam|sampu|usa|duha|tulo|upat|unom|napulo)\s*(?:\/|out of|sa|sa\s+gawas\s+sa)\s*(?:10|ten|sampu|napulo)\b/i;
  const NUM_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    // Tagalog
    sero: 0, isa: 1, dalawa: 2, tatlo: 3, apat: 4, lima: 5, anim: 6, pito: 7, walo: 8, siyam: 9, sampu: 10,
    // Cebuano (lima/pito/walo/siyam are shared with Tagalog, above)
    usa: 1, duha: 2, tulo: 3, upat: 4, unom: 6, napulo: 10,
  };
  const DURATION_RE = /\b((?:for|since|over|mula|simula|sukad|noong|niadtong)\s+(?:the\s+)?(?:last\s+|past\s+)?(?:about\s+|pa\s+)?(?:a\s+|an\s+|few\s+|couple(?:\s+of)?\s+|\w+\s+)?(?:days?|weeks?|months?|years?|hours?|nights?|mornings?|yesterday|today|kahapon|kagabi|kanina|kaganina|gabii|monday|tuesday|wednesday|thursday|friday|saturday|sunday|christmas|childhood|surgery|accident|fall|injury)|\w+\s+(?:linggo|araw|buwan|taon|oras|gabi|semana|adlaw|bulan|tuig|gabii)\s+(?:na|nan?g)|(?:matagal|dugay)\s+na)\b/i;
  // kapag/tuwing/pag (tl) · inig/kon/human/samtang (ceb) · habang/pagkatapos (tl)
  const TRIGGER_RE = /\b((?:when(?:ever)?|every time|after|while|during|kapag|kapg|tuwing|kada|habang|pagkatapos|pag|kung|inig|kon|human|samtang|sa dihang)\s+(?:(?:i|he|she|they|ako|siya)\s+)?[a-z' -]{2,36})/i;
  // A symptom is treated as denied when a negation sits shortly before it.
  // hindi/wala(ng) (tl) · dili/walay (ceb)
  const NEG_TAIL_RE = /\b(?:no|not|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|never|without|denies|denied|hindi|hindi na|walang?|wala pa|walay|wa\b|dili|di\b|ayaw)\b[\w\s']{0,22}$/i;

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** Find the first REAL pain rating in `text`. Skips slash forms that are
      dates ("on 6/10", "6/10/25") and caps hyperbole ("11 out of 10") at the
      top of the scale. Returns { score, index, length } or null. */
  function findRating(text) {
    return findRatings(text)[0] || null;
  }

  /** Every 0-10 rating in `text`, in the order spoken. */
  function findRatings(text) {
    const out = [];
    const re = new RegExp(RATING_RE.source, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      if (/\//.test(m[0])) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        const after = text.slice(m.index + m[0].length);
        if (/\b(?:on|since|from|until|dated)\s*$/i.test(before)) continue;
        if (/^\s*[\/\-]\s*\d/.test(after)) continue;
      }
      let score = NUM_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (score > 10) score = 10;
      out.push({ score, index: m.index, length: m[0].length });
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   *  Summarizer
   * ---------------------------------------------------------------- */

  /* What summarize() falls back to when a region was named and nothing was
     said about it. It reads like a finding on the body map but carries no
     clinical information, so the clean-up pass needs to be able to recognize
     one and offer to drop it. */
  const BARE_MENTION_PREFIX = "Mentioned this area";
  const isBareMention = (summary) =>
    new RegExp("^" + BARE_MENTION_PREFIX, "i").test(String(summary || "").trim());

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
    if (posNouns.length && posNouns[0].word === "feeling fine") {
      // reassurance stands alone — no intensity, no piggy-backed symptoms
      main = "feeling fine";
    } else if (posNouns.length) {
      const primary = posNouns[0].word;
      const extra = posNouns.slice(1, 3).filter((n) => n.d <= 40 && n.word !== "feeling fine").map((n) => n.word);
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

    // ratings / durations / triggers must sit NEAR the mention — a rating
    // three clauses away belongs to a different body part
    const rating = findRating(windowText);
    if (rating && !denial && distFrom(rating.index, rating.length) <= 55) {
      bits.push(`rated ${rating.score}/10`);
    }

    const duration = DURATION_RE.exec(windowText);
    if (duration && distFrom(duration.index, duration[0].length) <= 55) bits.push(`ongoing ${duration[1].trim()}`);

    const trigger = TRIGGER_RE.exec(windowText);
    if (trigger && !denial && distFrom(trigger.index, trigger[0].length) <= 55) bits.push(`worse ${trigger[1].trim()}`);

    if (!bits.length) {
      const snippet = windowText.trim().replace(/\s+/g, " ").slice(0, 90);
      return `${BARE_MENTION_PREFIX} — “${snippet}${windowText.trim().length > 90 ? "…" : ""}”`;
    }
    if (bits[0] !== cap(main) || !main) bits[0] = cap(bits[0]);
    return bits.join(" · ");
  }

  /* ---------------------------------------------------------------- *
   *  Clinical measurements (ROM, MMT, pain rating, special tests)
   * ---------------------------------------------------------------- */

  /* ROM is dictated with the joint stated ONCE and then a run of motions:

       "right shoulder abduction is 90 degrees, external rotation 45,
        flexion 120"

     The original pattern required a joint immediately before every motion, so
     only the first measurement in a run was ever captured and everything after
     it was silently dropped — the therapist watched three numbers go in and one
     come out. Worse, pure shorthand ("abduction 90 degrees, ER 45") captured
     nothing at all, which is how the measurement tables came back empty on a
     real dictation.

     So there are two passes. JOINT_ROM_RE is the explicit form and still wins.
     BARE_ROM_RE catches a motion with no joint of its own and inherits the
     nearest joint (and side) stated EARLIER in the same utterance — never a
     later one, and never across an utterance boundary, because inventing a
     joint is worse than dropping the number. */
  const ROM_JOINTS = "shoulder|knee|hip|elbow|ankle|wrist|neck|cervical|lumbar|trunk|balikat|abaga|tuhod|siko|leeg|liog";
  const ROM_MOTIONS =
    "flexion|extension|abduction|adduction|internal rotation|external rotation|rotation|" +
    "dorsiflexion|plantar\\s?flexion|supination|pronation|lateral flexion|" +
    // the abbreviations therapists actually say out loud
    "int(?:ernal)?\\.?\\s?rot(?:ation)?|ext(?:ernal)?\\.?\\s?rot(?:ation)?|ir|er|abd|add|flex|ext|df|pf";
  const ROM_FILLER = "(?:\\s+(?:is|was|to|at|measured|limited|now|about|around|approximately|only|up\\s+to))*";
  const ROM_DEGREES = "\\s*(?:=|:)?\\s*(\\d{1,3})\\s*(?:degrees?|deg\\b|°)";
  /* The same number with the unit left off. A therapist says the unit once and
     then reels off the rest — "abduction 90 degrees, external rotation 45,
     flexion 120" — so requiring "degrees" every time dropped all but the first.
     Guarded by a lookahead so a muscle grade ("flexion 4 out of 5"), a
     percentage or a date can't be read as an angle, and only ever used in a
     text that already carries one explicit degrees reading (see pass 2b). */
  const ROM_BARE_NUM = "\\s*(?:=|:)?\\s*(\\d{1,3})\\b(?!\\s*(?:out\\s+of|/|%|:|degrees?\\w))";
  // joints are dictated singular or plural ("both shoulders flexion 150")
  const JOINT_TOKEN = `(?:${ROM_JOINTS})s?`;

  const JOINT_ROM_RE = new RegExp(
    `\\b(?:(${SIDE_WORDS})\\s+)?(${JOINT_TOKEN})\\s+(${ROM_MOTIONS})${ROM_FILLER}${ROM_DEGREES}`, "gi");
  const BARE_ROM_RE = new RegExp(
    `\\b(?:(${SIDE_WORDS})\\s+)?(${ROM_MOTIONS})${ROM_FILLER}${ROM_DEGREES}`, "gi");
  const BARE_ROM_NOUNIT_RE = new RegExp(
    `\\b(?:(${SIDE_WORDS})\\s+)?(${ROM_MOTIONS})${ROM_FILLER}${ROM_BARE_NUM}`, "gi");
  // where a joint (with any side stated on it) is named, so a bare motion can
  // look backwards and inherit it
  const JOINT_ANCHOR_RE = new RegExp(`\\b(?:(${SIDE_WORDS})\\s+)?(${JOINT_TOKEN})\\b`, "gi");

  /* Abbreviations normalise to the full motion name so "ER 45" and "external
     rotation 45" aggregate as the same measurement rather than two. */
  const MOTION_ALIASES = {
    ir: "internal rotation", er: "external rotation", abd: "abduction", add: "adduction",
    flex: "flexion", ext: "extension", df: "dorsiflexion", pf: "plantarflexion",
    "int rot": "internal rotation", "int rotation": "internal rotation", "internal rot": "internal rotation",
    "ext rot": "external rotation", "ext rotation": "external rotation", "external rot": "external rotation",
  };
  const normMotion = (raw) => {
    const k = String(raw).toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
    return MOTION_ALIASES[k] || k;
  };
  /* "out of 5", "/5" and the spoken "over 5" are the same grade. "over" was
     missing, so "strength 4 over 5" — a normal way to say it out loud, and what
     Cloud dictation transcribes — produced no measurement at all. */
  /* The grade itself gets spoken in whichever language the therapist counts
     in. Pain ratings already read "pito sa sampu"; strength did not, so a
     Taglish "quad strength apat sa lima" — an ordinary way to dictate 4/5 —
     produced no measurement at all and the grade was lost from the chart. */
  const MMT_NUM = "[0-5]|zero|one|two|three|four|five|sero|isa|dalawa|tatlo|apat|lima|usa|duha|tulo|upat";
  const MMT_RE = new RegExp(
    `\\b((?:[A-Za-z][\\w-]*\\s+){0,3}?)(?:strength|mmt|lakas|kusog)?\\s*(?:is|was|graded?(?:\\s+at)?|at)?\\s*`
    + `((?:${MMT_NUM})(?:\\s*(?:plus|minus)|[+-])?)\\s*(?:out\\s+of|over|sa|\\/)\\s*(?:5|five|lima)\\b`, "gi");
  /* The muscle is often named AFTER the grade, especially in Taglish word order
     — "strength 4 over 5 sa deltoid". Without this the grade was filed with no
     muscle attached, which makes it useless for tracking a specific weakness. */
  /* Both groups are optional and the side is not required to have a word after
     it — "…4 out of 5 on the right" ends there, and demanding a trailing muscle
     made the side unreadable at the end of a sentence. */
  const MMT_TRAIL_RE = new RegExp(
    `^[\\s,]*(?:on|of|for|in|sa|ang|ng)?\\s*(?:the|his|her|their)?\\s*` +
    `(?:(${SIDE_WORDS})\\b\\s*)?((?:[A-Za-z][\\w-]*)(?:\\s+[A-Za-z][\\w-]*){0,2})?`, "i");
  // an "X out of 5" only counts as MMT when the surrounding words are about
  // strength — "he has 5 out of 5 kids" is not a muscle grade
  const MMT_CONTEXT_RE = /\b(?:strength|mmt|grade[ds]?|quad|hamstring|bicep|tricep|delt|glute|grip|flexor|extensor|abductor|adductor|abduction|adduction|flexion|extension|rotation|rotator|trap|calf|gastroc|soleus|tibialis|serratus|lats?|pecs?|core|hip|knee|shoulder|elbow|wrist|ankle|neck|dorsiflex|plantarflex)\w*/i;
  /* Special tests get dictated in two word orders: "positive Neer test" and
     "Neer is positive" / "Hawkins test came back positive". Only the first was
     recognised, so the reversed form was silently dropped — and because a
     recognised test is what marks a line as the CLINICIAN speaking, a missed
     test also let the therapist's read-out be scored as patient speech and
     pinned to the body map. The reversed form needs either the literal word
     test/sign or a known test name, so ordinary prose ("the news is positive")
     doesn't register as a clinical finding. */
  const SPECIAL_RE = /\b(positive|negative)\s+((?:[A-Za-z'’-]+\s+){1,4}?)(?:test|sign)\b/gi;
  const SPECIAL_NAMES = "neer|hawkins(?:[-\\s]kennedy)?|empty[-\\s]can|jobe|speed['’]?s?|yergason['’]?s?|apprehension|relocation|o['’]?brien['’]?s?|drop[-\\s]arm|lift[-\\s]?off|spurling['’]?s?|phalen['’]?s?|tinel['’]?s?|finkelstein['’]?s?|mcmurray['’]?s?|lachman['’]?s?|(?:anterior|posterior)[-\\s]drawer|thessaly|apley['’]?s?|ober['’]?s?|faber|patrick['’]?s?|fadir|straight[-\\s]leg[-\\s]raise|slr|slump|thompson['’]?s?|talar[-\\s]tilt|(?:valgus|varus)[-\\s]stress|impingement";
  const SPECIAL_REV_RE = new RegExp(
    `\\b((?:${SPECIAL_NAMES})(?:\\s+(?:test|sign))?|(?:[A-Za-z'’-]+\\s+){1,3}?(?:test|sign))` +
    `\\s*(?:is|was|were|came\\s+back|came\\s+out|reads?)?\\s*:?\\s*(positive|negative)\\b`, "gi");

  /** Every special test in `text`, both word orders, with its span so callers
      can tell test vocabulary apart from a patient's own complaint. */
  function specialTests(text) {
    const out = [];
    let m;
    SPECIAL_RE.lastIndex = 0;
    while ((m = SPECIAL_RE.exec(text)) !== null) {
      out.push({ result: m[1].toLowerCase(), name: cap(m[2].trim()) + " test", start: m.index, end: m.index + m[0].length });
    }
    SPECIAL_REV_RE.lastIndex = 0;
    while ((m = SPECIAL_REV_RE.exec(text)) !== null) {
      const start = m.index, end = m.index + m[0].length;
      if (out.some((s) => start < s.end && end > s.start)) continue; // already caught in the other order
      const name = m[1].trim()
        .replace(/^(?:the|a|an|this|that|his|her|their)\s+/i, "")
        .replace(/\s+(?:test|sign)$/i, "");
      if (!name) continue;
      out.push({ result: m[2].toLowerCase(), name: cap(name) + " test", start, end });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function extractMeasurements(text, mentions) {
    const rom = [];
    const mmt = [];
    const special = [];
    const pain = [];

    /* Every joint named in this text, with the side attached to it, so a bare
       motion can inherit from the nearest one BEFORE it. */
    const anchors = [];
    JOINT_ANCHOR_RE.lastIndex = 0;
    let a;
    while ((a = JOINT_ANCHOR_RE.exec(text)) !== null) {
      anchors.push({ at: a.index, side: sideWord(a[1]), joint: a[2].toLowerCase().replace(/s$/, "") });
    }
    const anchorBefore = (idx) => {
      let found = null;
      for (const an of anchors) { if (an.at <= idx) found = an; else break; }
      return found;
    };

    /* "Knee flexion is 110 degrees ON THE RIGHT" / "sa kanan" / "sa tuo".
       MMT already read a trailing side; ROM only ever read a leading one, so
       every read-out dictated in the natural word order recorded an angle with
       no side on it — and a left/right difference is most of what a ROM
       measurement is for. */
    const ROM_TRAIL_RE = new RegExp(
      `^[\\s,]*(?:(?:on|of|in|for|sa|ang|ng)\\s+(?:the|his|her|their|ang)?\\s*(${SIDE_WORDS})\\b`
      + `|(bilateral(?:ly)?|both)\\b|(${SIDE_WORDS})\\s+sides?\\b)`, "i");
    const trailSide = (end) => {
      const t = ROM_TRAIL_RE.exec(text.slice(end, end + 28));
      return t ? sideWord(t[1] || t[2] || t[3]) : null;
    };

    const pushRom = (side, joint, motion, degrees) => {
      const entry = { joint, motion, degrees };
      if (side === "both") rom.push({ side: "left", ...entry }, { side: "right", ...entry });
      else rom.push({ side, ...entry });
    };

    // Pass 1 — the explicit form wins, and its span is recorded so pass 2 can't
    // re-read the same motion as a bare one.
    const claimed = [];
    let m;
    JOINT_ROM_RE.lastIndex = 0;
    while ((m = JOINT_ROM_RE.exec(text)) !== null) {
      const degrees = Number(m[4]);
      claimed.push([m.index, m.index + m[0].length]);
      if (degrees > 180) continue; // no human joint motion exceeds 180° — likely a mis-transcription
      pushRom(sideWord(m[1]) || trailSide(m.index + m[0].length),
        m[2].toLowerCase().replace(/s$/, ""), normMotion(m[3]), degrees);
    }

    // Pass 2 — a motion with no joint of its own, inheriting the joint stated
    // before it. With no earlier joint the number is dropped, not guessed.
    const bareRun = (re, numGroup) => {
      re.lastIndex = 0;
      let b;
      while ((b = re.exec(text)) !== null) {
        const start = b.index, end = start + b[0].length;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        const degrees = Number(b[numGroup]);
        if (degrees > 180) continue;
        const anchor = anchorBefore(start);
        if (!anchor) continue;
        claimed.push([start, end]);
        pushRom(sideWord(b[1]) || trailSide(end) || anchor.side, anchor.joint, normMotion(b[2]), degrees);
      }
    };

    // 2a — the unit is present ("external rotation is 45 degrees")
    bareRun(BARE_ROM_RE, 3);
    /* 2b — the unit was stated once and dropped ("…90 degrees, ER 45, flexion
       120"). Only run when this text already produced a degrees-marked reading,
       so a stray "flexion 3" in prose can't invent an angle out of nothing. */
    if (rom.length) bareRun(BARE_ROM_NOUNIT_RE, 3);

    MMT_RE.lastIndex = 0;
    while ((m = MMT_RE.exec(text)) !== null) {
      // "6 out of 10" style pain ratings must not read as MMT
      if (!MMT_CONTEXT_RE.test(m[0])) continue;
      const grade = m[2]
        .replace(/\s*plus/i, "+").replace(/\s*minus/i, "-").trim()
        .replace(/^[a-z]+/i, (w) => (NUM_WORDS[w.toLowerCase()] ?? w));

      /* Side, which was previously thrown away entirely — "deltoid strength is
         4 out of 5 on the right" recorded a grade with no side, so a left/right
         asymmetry (the whole point of measuring it) was invisible in the chart.
         Look in the matched words first, then a short tail after the grade for
         the trailing "on the right" form, then fall back to the joint anchor. */
      let context = m[1].trim();
      const start = m.index, end = start + m[0].length;
      const leadSide = new RegExp(`^(${SIDE_WORDS})\\b\\s*`, "i").exec(context);
      if (leadSide) context = context.slice(leadSide[0].length).trim();
      // strip the grading verb itself — it names no muscle
      context = context.replace(/\b(?:strength|mmt|lakas|kusog|is|was|at|graded?|ang|ng|nga|sa|og|ug)\b/gi, "").replace(/\s+/g, " ").trim();

      const trail = MMT_TRAIL_RE.exec(text.slice(end, end + 40));
      const trailWords = (trail && trail[2] ? trail[2] : "").trim();
      // Only borrow the trailing words as the muscle when nothing was said
      // before the grade AND they actually read as anatomy, so "4 out of 5 and
      // she reports pain" doesn't file "and she reports" as a muscle.
      if (!context && trailWords && MMT_CONTEXT_RE.test(trailWords)) context = trailWords;

      const side = sideWord(leadSide && leadSide[1]) || sideWord(trail && trail[1])
        || ((anchorBefore(start) || {}).side ?? null);

      const entry = { context: context || null, grade: `${grade}/5` };
      if (side === "both") mmt.push({ side: "left", ...entry }, { side: "right", ...entry });
      else mmt.push({ side, ...entry });
    }

    for (const s of specialTests(text)) special.push({ result: s.result, name: s.name });

    /* One line routinely carries two ratings — "my neck is a 3 out of 10 but
       my shoulder is an 8 out of 10", "left is a seven out of ten, right is a
       four". Reading only the first silently dropped the second complaint's
       severity, which is the number the whole note is built around. */
    for (const rating of findRatings(text)) {
    if (!NEG_TAIL_RE.test(text.slice(Math.max(0, rating.index - 30), rating.index))) {
      // attach the rating to the NEAREST non-denied mention, not just the
      // first — "no pain in the neck, but the shoulder is a 7/10" — and
      // prefer a mention in the same clause over one across a break
      const sepByClause = (a, b) => {
        CLAUSE_BREAK_RE.lastIndex = 0;
        let bm;
        while ((bm = CLAUSE_BREAK_RE.exec(text)) !== null) {
          if (bm.index >= b) break;
          if (bm.index >= a) return true;
        }
        return false;
      };
      let bestSame = null, bestSameD = Infinity, bestAny = null, bestAnyD = Infinity;
      for (const mn of mentions || []) {
        if (/^denies/i.test(mn.summary || "")) continue;
        const before = mn.end <= rating.index;
        const d = before ? rating.index - mn.end
          : mn.start >= rating.index + rating.length ? mn.start - (rating.index + rating.length) : 0;
        if (d < bestAnyD) { bestAnyD = d; bestAny = mn; }
        const sep = before ? sepByClause(mn.end, rating.index) : sepByClause(rating.index + rating.length, mn.start);
        if (!sep && d < bestSameD) { bestSameD = d; bestSame = mn; }
      }
      const best = bestSame || bestAny;
      /* The second half of a two-sided report elides the body part — "left
         knee is a seven out of ten and THE RIGHT is a four". The only mention
         in the line is the left one, so the four would be filed against the
         left knee: a number on the wrong side, which is worse than no number.
         A side word standing on its own just before the rating re-sides it. */
      let side = best ? best.side : null;
      if (best) {
        const lead = new RegExp(`\\b(${SIDE_WORDS})\\b(?:\\s+(?:one|side|na|nga))?[\\s,]*(?:is|was|ay|kay)?[\\s,]*(?:a|an|maybe|about|mga|around)?[\\s,]*$`, "i")
          .exec(text.slice(Math.max(0, rating.index - 34), rating.index));
        const spoken = lead ? sideWord(lead[1]) : null;
        if (spoken && spoken !== "both") side = spoken;
      }
      const where = best ? `${side ? side + " " : ""}${best.partName.toLowerCase()}` : null;
      if (!pain.some((p) => p.score === rating.score && p.location === where)) {
        pain.push({ score: rating.score, location: where });
      }
    }
    }

    return { rom, mmt, special, pain };
  }

  /* ---------------------------------------------------------------- *
   *  Section classifier (for evaluations / progress reports)
   * ---------------------------------------------------------------- */

  const SECTION_RULES = [
    ["precautions", /\b(precaution|avoid|do not|don't lift|no lifting|weight.?bearing|contraindicat|restrict|bawal|iwasan|ingat|likayan)\b/i],
    /* "Nag-refer", "ni-refer", "gipa-refer" — an English verb with a Filipino
       affix across a hyphen is the ordinary way to say this, and none of it
       looked like "referred" to a pattern expecting an English past tense. */
    ["reason", /\b(referr(?:ed|al)|(?:nag|ni|na|i|gi|gipa|pina|ipina)-?refer\w*|prescri(?:bed|ption)|(?:nag|ni|na|i|gi)-?reseta\w*|sent (?:by|from)|doctor (?:sent|wants)|dahilan|ipinadala|pinadala|gipadala|gipaanhi)\b/i],
    ["pmh", /\b(history of|diagnosed with|(?:na|ni|gi)-?diagnos\w*|surgery|surgeries|underwent|operation|hypertension|diabetes|arthritis|years? ago|when i was \d+|as a (?:kid|child|teenager)|noong|kaniadto|inopera|na-?opera\w*|gi-?opera\w*|opera(?:syon|tion))\b/i],
    /* "Consistent WITH X" is English word order. A therapist dictating in
       Taglish says "consistent po ito SA rotator cuff impingement", and the
       impression was being trimmed out of the visit as a bare mention. */
    ["assessment", /\b(assessment|impression|consistent with|consistent(?:\s+(?:po|ito|siya|ini|ni))*\s+sa\b|tugma\s+sa|katugma|likely|appears to (?:be|have)|prognosis|suspect|posible(?:ng)?|malamang)\b/i],
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

  // A summary window must not leak across a sentence break or a contrast
  // ("…helps a bit BUT my neck is stiff") — symptoms on the far side of the
  // break belong to a different body part.
  const CLAUSE_BREAK_RE = /[.;!?]|\b(?:but|however|although|whereas|pero|apan|kaso)\b/gi;

  function clipWindow(text, winStart, winEnd, start, end) {
    CLAUSE_BREAK_RE.lastIndex = 0;
    let s = winStart, e = winEnd, m;
    while ((m = CLAUSE_BREAK_RE.exec(text)) !== null) {
      if (m.index >= e) break;
      const bEnd = m.index + m[0].length;
      if (bEnd <= start) { if (bEnd > s) s = bEnd; }
      else if (m.index >= end) { e = m.index; break; }
    }
    return [s, e];
  }

  /* ---------------------------------------------------------------- *
   *  Regions that are named but are not the patient's complaint
   * ---------------------------------------------------------------- *
     A body part appearing in a sentence is not the same as the patient
     reporting something about it. Three kinds of hit look identical to a
     keyword scan and mean nothing clinically — and each one, left alone, put
     a pin on the mannequin and a sentence in the chart:

       someone else's body  "my daughter had knee surgery last year"
       a figure of speech   "the paperwork is a real pain in the neck"
       a future contingency "if my shoulder starts hurting again I'll call"

     These are filtered at parse time, before a mention exists at all, so the
     live pass, the body map, the cleanup pass and the note all inherit the
     same answer instead of each re-deciding it. The bar for filtering is
     deliberately high: dropping a real complaint is far worse than keeping a
     spurious one, which the therapist can still untick during cleanup. */

  /* In a Philippine clinic the person doing most of the talking is often not
     the patient — an adult child brings a parent and answers for them. Third-
     party detection cannot help there, because the companion describes their
     OWN aches in the first person ("masakit din ang likod ko"), which is
     exactly the grammar of a patient reporting a symptom. What separates them
     is that companions say so: they announce it. The marker has to be that
     explicit, because the cost of believing it wrongly is dropping the real
     patient's complaint. */
  const NOT_THE_PATIENT_RE = /\b(?:i'?m not the patient|i am not the patient|it'?s not (?:for )?me,? it'?s|hindi (?:po )?ako ang (?:pasyente|pasiente)|dili (?:ko|ako) ang pasyente|hindi po ako ang magpapa-?\w+|dili ko ang pasyente)\b/i;

  const PERSON_RE = /\b(?:daughter|son|wife|husband|mother|father|mom|dad|brother|sister|grand(?:ma|pa|mother|father|son|daughter|child)|aunt|uncle|cousin|friend|neighbou?r|co-?worker|boss|anak|asawa|nanay|tatay|inay|itay|kapatid|lola|lolo|kuya|misis|mister|bana|kapikas)\b/i;

  // "my daughter broke HER arm" / "my wife'S back" — an explicit possessive.
  const THIRD_PARTY_RE = new RegExp(
    PERSON_RE.source + "(?:(?:'s)?\\b[\\w\\s',]{0,20}\\b(?:her|his|their)\\s+|'s\\s+)$", "i");

  /* The possessive-free shape: "my daughter had KNEE surgery". The relative is
     the subject and the region hangs off the verb, so nothing marks it as
     theirs except who the clause is about. Scoped to the clause the region sits
     in, and cancelled the moment the patient claims the part themselves
     ("my daughter says MY back looks crooked"), which is the common case where
     a relative is merely the one doing the talking. */
  const SELF_CLAIM_RE = /\b(?:my|mine|akin|aking|ako|ko|akong|nako|nakong|amoa|amoang|among)\b/i;
  const CLAUSE_SPLIT_RE = /[.;,!?]|\b(?:and|but|then|so|because|pero|tapos|kasi|ug|apan)\b/gi;

  /* ---- possession, in a language that marks it the other way round ----

     English puts the possessive in front of the noun: "MY wife", "my
     daughter's knee". Tagalog and Cebuano put it after: "asawa KO", "likod
     NIYA", "akong bana". The rule written for English read "asawa ko" as the
     speaker claiming something — the enclitic `ko` sits exactly where a
     self-claim would — and so every Filipino sentence about a relative's body
     was filed as the patient's own. "Yung asawa ko po, masakit din ang likod
     niya" put a back on the patient's chart.

     Two markers do most of the work once they are read in the right order:

       ko / nako / namin / namo   mine — but attached to the PERSON, which
                                  makes the person mine, not the body part
       niya / nila / iyang /      theirs — attached to the body part, which
       ilang / kanyang            is as explicit as a third-party marker gets */

  const MINE_ENCLITIC = "(?:ko|nako|nako'?ng|namin|namo|natin|nato|naku)";
  const MINE_PROCLITIC = "(?:akong|aking|among|amoang|akoang|atong)";
  const THEIRS_BEFORE_RE = new RegExp("\\b(?:iyang|ilang|kaniyang|kanyang|kanilang|iyaha(?:ng)?|ilaha(?:ng)?|niyang)\\s+$", "i");
  const THEIRS_AFTER_RE = /^\s*(?:nga\s+)?(?:niya|nila|niini|niadto)\b/i;
  const THIRD_PERSON_RE = /\b(?:niya|nila|iyang|ilang|kaniyang|kanyang|kanilang|iyaha(?:ng)?|ilaha(?:ng)?|siya|sila|siyang|her|hers|his|their|theirs|she|he|they)\b/i;

  /* Remove "<person> ko" / "akong <person>" / "my wife's" so that what is
     left can be asked the only question that matters: does the speaker claim
     anything for THEMSELVES in this sentence? Without the strip, the
     possessive that makes the RELATIVE mine reads as a claim on the body. */
  const PERSON_POSSESSED_RE = new RegExp(
    "(?:" + MINE_PROCLITIC + "\\s+)?(?:my|our)?\\s*(?:" + PERSON_RE.source.replace(/^\\b|\\b$/g, "") + ")(?:'s)?(?:\\s+" + MINE_ENCLITIC + ")?",
    "gi");

  const stripPersonPossessives = (text) => String(text || "").replace(PERSON_POSSESSED_RE, " ");

  /** True when the sentence is plainly about somebody else's body: it names a
      person, refers to them in the third person, and the speaker never claims
      anything of their own in it. */
  function aboutSomeoneElse(text) {
    const t = String(text || "");
    if (!PERSON_RE.test(t)) return false;
    if (!THIRD_PERSON_RE.test(t)) return false;
    return !SELF_CLAIM_RE.test(stripPersonPossessives(t));
  }

  /** The fragment of `text` between the last clause break and `idx`. */
  function clauseBefore(text, idx) {
    const head = text.slice(0, idx);
    CLAUSE_SPLIT_RE.lastIndex = 0;
    let cut = 0, m;
    while ((m = CLAUSE_SPLIT_RE.exec(head)) !== null) cut = m.index + m[0].length;
    return head.slice(cut);
  }

  /** True when the region at `start` belongs to somebody other than the
      patient — either possessed outright, or sitting in a clause that is
      about a third party and that the patient never claims for themselves.

      The self-claim only cancels when it comes AFTER the person. "MY daughter
      had knee surgery" opens with a possessive belonging to the daughter, not
      to the knee; "my daughter says MY back looks crooked" is the other shape,
      where the relative is merely the one doing the talking. */
  function isThirdPartyRegion(text, start, end) {
    if (THIRD_PARTY_RE.test(text.slice(Math.max(0, start - 60), start))) return true;
    /* "IYANG abaga", "likod NIYA" — Tagalog and Cebuano say whose it is right
       next to the part. But `niya` is "his/her", and who that is depends
       entirely on who is talking: a therapist dictating about the patient
       says "namamaga ang kanang kamay NIYA" and means the person in front of
       them. It is third-party evidence only when a third party was actually
       named — "ang asawa ko … ang likod NIYA". */
    if (PERSON_RE.test(text)) {
      if (THEIRS_BEFORE_RE.test(text.slice(Math.max(0, start - 24), start))) return true;
      if (end !== undefined && THEIRS_AFTER_RE.test(text.slice(end, end + 24))) return true;
    }
    if (aboutSomeoneElse(text)) return true;

    const clause = clauseBefore(text, start);
    /* Strip the possessive that makes the PERSON mine before looking for a
       claim on the body — otherwise "anak ko" ("my child") reads as the
       speaker claiming the knee that follows it. */
    const stripped = stripPersonPossessives(clause);
    const who = new RegExp(PERSON_RE.source, "gi");
    let after = null, m;
    while ((m = who.exec(clause)) !== null) after = m.index + m[0].length;
    if (after === null) return false;
    return !SELF_CLAIM_RE.test(stripped);
  }

  /* Idioms. English and Filipino both hang figures of speech on body parts,
     and a scanner cannot tell "pain in the neck" the complaint from "pain in
     the neck" the paperwork. Matching whole phrases (rather than guessing from
     context) keeps this exact: only the listed wordings are figurative, and
     the region inside the matched span is the only thing unpinned. */
  const FIGURATIVE_RES = [
    /\b(?:is|was|are|were|being|such|what|becoming|becomes?)\s+(?:a\s+|an\s+)?(?:real\s+|total\s+|complete\s+|absolute\s+|right\s+)?pains?\s+in\s+the\s+(?:neck|butt|ass|arse|rear|backside|behind)\b/gi,
    /\b(?:is|are|was|were|be|being|such|quite|what)\s+(?:a|an)?\s*(?:real|total|complete|absolute|big|huge)?\s*headaches?\b/gi,
    /\bgut\s+(?:feel|feeling|instinct|reaction)\w*\b/gi,
    /\b(?:get|got|getting|has|have|had)\s+cold\s+feet\b/gi,
    /\boff\s+the\s+top\s+of\s+(?:my|his|her|their)\s+head\b/gi,
    /\b(?:keep|keeping|kept|got|had)\s+an?\s+eye\s+(?:on|out)\b/gi,
    /\b(?:give|gave|giving|lend|lent|need)\s+(?:me|you|him|her|them|us)?\s*a\s+hand\b/gi,
    /\ba\s+lot\s+on\s+(?:my|his|her|their)\s+plate\b/gi,
    /\bshoulder(?:ed|ing)?\s+the\s+(?:blame|cost|burden|responsibility)\b/gi,
    /\bheart\s+of\s+the\s+matter\b/gi,
    /\bback\s+of\s+(?:my|his|her|their)\s+mind\b/gi,
    /\bbreak\s+a\s+leg\b/gi,
    /\b(?:costs?|cost|costing)\s+an\s+arm\s+and\s+a\s+leg\b/gi,
    /\belbow\s+grease\b/gi,
    /\bneck\s+and\s+neck\b/gi,
    /\bface\s+the\s+music\b/gi,
    /\ba\s+shoulder\s+to\s+cry\s+on\b/gi,
    /\b(?:my|his|her|their)\s+heart\s+goes?\s+out\b/gi,
    /\bpull(?:ing|ed)?\s+(?:my|your|his|her|their)\s+leg\b/gi,
    /\bmakapal\s+ang\s+mukha\b/gi,
    /\bmabigat\s+ang\s+(?:dugo|loob)\b/gi,
    /* "Sakit sa ulo ang papeles" is an annoyance, not a headache; "masakit sa
       bulsa" is expensive, not a symptom. The literal reading attaches the
       possessive to the part — "masakit ang ulo KO" — so a trailing first
       person is what rules the idiom out. */
    /\b(?:sobrang\s+|grabe(?:ng)?\s+|ang\s+|napaka)?(?:ma)?sakit\s+sa\s+(?:ulo|bulsa|dibdib|kalag|tiyan)\b(?!\s+(?:ko|nako|nakong|namin|natin|ako|nako'?ng))/gi,
    /\bmakapal\s+ang\s+(?:mukha|apog)\b/gi,
    /\bmalakas\s+ang\s+(?:loob|dugo)\b/gi,
    /\bpasan\s+sa\s+balikat\b/gi,
  ];

  /** Character ranges in `text` that are figures of speech, not anatomy. */
  function figurativeRanges(text) {
    const out = [];
    for (const re of FIGURATIVE_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  /* "If my shoulder starts hurting again I'll call you" is a plan, not a
     symptom — nothing hurts right now. The narrow shape is a conditional
     clause followed by a statement of future INTENT; "if I bend over my back
     hurts" has the same 'if' and is a genuine aggravating factor, so the
     future marker is what separates them, not the conditional. */
  const CONDITIONAL_RE = /\b(?:if|in case|should\s+(?:it|my|the|they))\b|\bkung\s+sakali\b|\bsakaling\b/i;
  const FUTURE_INTENT_RE = /\b(?:i['’]?ll|i\s+will|we['’]?ll|we\s+will|i['’]?m\s+going\s+to|let\s+you\s+know|call\s+(?:you|me|again)|come\s+back|go\s+back|tell\s+you|see\s+you|tatawag|babalik|magpapatingin|mobalik|motawag)\b/i;

  /** True when the region at `start` is only named inside a "what if" that is
      resolved by an intention, rather than by a symptom. */
  function isFutureContingency(text, start) {
    const head = text.slice(0, start);
    if (!CONDITIONAL_RE.test(head)) return false;
    return FUTURE_INTENT_RE.test(text.slice(start));
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
    if (!text) return { text, mentions, loose: null, notMine: [], measurements: { rom: [], mmt: [], special: [], pain: [] } };

    const claimed = [];
    const notMine = [];             // regions named, but not this patient's complaint
    const figurative = figurativeRanges(text);
    const demo = demoRanges(text);
    const disclaimed = NOT_THE_PATIENT_RE.test(text);
    const seenMentions = new Set(); // collapse identical repeats within one utterance
    for (const part of BODY_PARTS) {
      part.re.lastIndex = 0;
      let m;
      while ((m = part.re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        claimed.push([start, end]);

        /* Named, but not a complaint of this patient's: somebody else's
           body, a figure of speech, or a hypothetical. `notMine` is recorded
           rather than merely skipped — an utterance whose ONLY region was
           filtered must not then fall through to the loose-signal path and
           re-attach that same wording to whatever was pinned last. */
        if (disclaimed) { notMine.push([start, "the speaker said they are not the patient"]); continue; }
        if (isThirdPartyRegion(text, start, end)) { notMine.push([start, "someone else's"]); continue; }
        if (figurative.some(([fs, fe]) => start >= fs && end <= fe)) { notMine.push([start, "a figure of speech"]); continue; }
        if (demo.some(([hs, he]) => start >= hs && start < he)) { notMine.push([start, "an example, not a complaint"]); continue; }
        if (isFutureContingency(text, start)) { notMine.push([start, "a hypothetical"]); continue; }

        let side = null;
        if (part.fixedSide) side = part.fixedSide;
        else if (part.sided) {
          side = sideWord(m[1] || m[2] || m[3] || m[4]);
          /* Some regions are named by a phrase that swallows the side word
             ("the back of my LEFT leg", "likod ng KALIWANG binti"), so neither
             the leading nor the trailing capture sees it. Read it back out of
             the matched text rather than filing a posterior complaint with no
             side on it. */
          if (!side) {
            const inner = new RegExp(`\\b(${SIDE_WORDS})\\b`, "i").exec(m[0]);
            if (inner) side = sideWord(inner[1]);
          }
        }

        let winStart = expandLeft(text, Math.max(0, start - 80));
        let winEnd = expandRight(text, Math.min(text.length, end + 80));
        [winStart, winEnd] = clipWindow(text, winStart, winEnd, start, end);
        const windowText = text.slice(winStart, winEnd);
        const summary = summarize(windowText, start - winStart, end - winStart);

        // "both knees" pins the left AND the right
        const sides = side === "both" ? ["left", "right"] : [side];
        for (const sd of sides) {
          const sig = `${part.name}|${sd || ""}|${summary}`;
          if (seenMentions.has(sig)) continue;
          seenMentions.add(sig);
          const { x, y } = coordFor(part, sd);
          mentions.push({
            partName: part.name,
            side: sd,
            bare: isBareMention(summary),
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
    }
    mentions.sort((a, b) => a.start - b.start);

    /* "plantar fasciitis in my left foot" names the foot twice — once through
       the condition, once through the word — and produced two pins, one of
       them sideless. When the same region is described the same way and one of
       the hits carries a side, that is the one the therapist meant. */
    for (let i = mentions.length - 1; i >= 0; i--) {
      const mn = mentions[i];
      if (mn.side) continue;
      if (mentions.some((o) => o !== mn && o.partName === mn.partName && o.side && o.summary === mn.summary)) {
        mentions.splice(i, 1);
      }
    }

    // A body part inside a special-test NAME ("drop arm test", "straight leg
    // raise test") is test vocabulary, not a patient complaint — unpin it.
    const testRanges = specialTests(text).map((s) => [s.start, s.end]);
    if (testRanges.length) {
      for (let i = mentions.length - 1; i >= 0; i--) {
        const mn = mentions[i];
        if (testRanges.some(([s, e]) => mn.start >= s && mn.end <= e)) mentions.splice(i, 1);
      }
    }

    let loose = null;
    /* Every region in this line belonged to someone else, to an idiom, or to a
       hypothetical. Whatever symptom words are left ("bothering her", "starts
       hurting") describe THAT, so attaching them to the last pinned region —
       which is what a loose signal does — would file one person's complaint
       under another's body part. */
    if (!mentions.length && notMine.length) {
      return { text, mentions, loose: null, notMine, measurements: extractMeasurements(text, mentions) };
    }
    if (!mentions.length) {
      const anchor = firstSignal(text);
      /* A loose signal attaches to whatever was pinned last, so an idiom that
         carries a symptom word — "masakit sa bulsa ang gamot", "that was a
         headache to sort out" — used to append the cost of the medicine to the
         patient's shoulder. Same test the mentions get, applied to the anchor. */
      const inIdiom = anchor && (figurative.some(([fs, fe]) => anchor[0] >= fs && anchor[0] < fe)
        || demo.some(([hs, he]) => anchor[0] >= hs && anchor[0] < he));
      if (anchor && !inIdiom) {
        loose = {
          summary: summarize(text, anchor[0], anchor[1]),
          quote: snippet(text, anchor[0], anchor[1]),
          // where it was found, so a caller can ask whether it sits inside a
          // figure of speech — "MASAKIT sa bulsa" is not a symptom
          start: anchor[0], end: anchor[1],
        };
      }
    }

    const measurements = extractMeasurements(text, mentions);
    return { text, mentions, loose, notMine, measurements };
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
  const CLINICIAN_RE = /\?\s*$|\b(can you|could you|do you|does (?:it|that|this)|did (?:you|it)|are you|have you|where (?:is|does|do|are)|how (?:does|is|bad|long|much|old|many)|who (?:sent|referred|told|gave)\s+you|who else|what (?:brings?|brought)\s+you|what(?:'?s| is| was) (?:going on|bothering|the problem|been happening)|when did (?:it|this|that|you|the)|which (?:one|side|arm|leg|knee|shoulder|hand|foot|hip|elbow|wrist|ankle|hita|tuhod|balikat)|why (?:do|does|did) (?:it|you|that)|may(?:roon)?\b[\w\s]{0,25}\bba\b|naa\s+(?:ka|ba)y?\b|aduna\s+kay?\b|on a scale|rate (?:your|the|it)|point to|show me|let me|let's|lets|i['’]?m going to|i am going to|i will|i['’]?ll|push (?:against|into|up|down)|resist|relax|breathe|(?:take|takes|taking) a (?:deep )?breath|turn (?:your|to|over)|lie (?:down|back|on)|stand (?:up|straight)|sit (?:up|down)|hold (?:still|this|that)|squeeze|tell me|any (?:pain|numbness|tingling|weakness)|follow my|repeat after|palpat|assess|saan|kailan|gaano|ano ang|anong|ano po|bakit|paano|masakit ba|sakit ba|may sakit ba|i-\w+(?:\s+(?:niyo|nyo|ninyo|mo|po|na))|(?:hu)?wag\s+(?:niyo|mo|kang|kayong|po)|ayaw\s+(?:mo|niyo|pag|pug)|palihug\s+\w+|ituro|subukan|huminga|humiga|umupo|maupo|tumayo|tumindig|iikot|itaas|ibaba|iunat|igalaw|kaya mo bang|pwede mo bang|tignan|tingnan|sabihin mo|itudlo|asa|kanus-?a|pila ka|unsa imong|unsa ang|unsay|ngano|unsaon|sulayi|ginhawa|paghigda|paglingkod|pagtindog|ituy-?od|ipataas|tan-?awon|sultihi ko|makahimo ka ba)\b/i;

  function guessSpeaker(raw) {
    const t = String(raw || "").trim();
    if (!t) return "clinician";
    const r = parseUtterance(t);
    const hasObjMeas = r.measurements.rom.length || r.measurements.mmt.length || r.measurements.special.length;
    if (hasObjMeas) return "clinician"; // therapist reads out ROM/MMT/tests
    if (CLINICIAN_RE.test(t)) return "clinician";
    // narrating the software is the therapist talking, whoever holds the mic
    if (META_RE.test(t)) return "clinician";
    // the therapist narrates the interventions performed ("we did scaption…")
    if (TREATMENT_NARRATION_RE.test(t)) return "clinician";
    /* An observation with nobody in it. "The right shoulder sits higher than
       the left" is the therapist looking at the patient; "MY shoulder sits
       higher" is the patient looking at themselves. The first person is the
       only thing that separates them, so the absence of one is the signal. */
    if (OBSERVATION_RE.test(t) && !FIRST_PERSON_RE.test(t)) return "clinician";
    return "patient"; // default: hone in on the patient
  }

  const OBSERVATION_RE = /\b(?:sits?|appears?|looks?|presents?|demonstrates?|exhibits?|noted|observ(?:ed|able)|palpat\w*|visibl[ey]|on inspection|compared to the (?:other|left|right)|than the (?:other|left|right)|mas\s+(?:mataas|mababa|malaki|maliit)|kumpara\s+sa|compared\s+sa|halata(?:ng)?|makita|nakikita|nakita|tan-?awon|klaro\s+nga)\b/i;
  const FIRST_PERSON_RE = /\b(?:i|i'?(?:m|ve|ll|d)|me|my|mine|myself|we|our|ako|ko|akin|aking|sakin|nako|akong)\b/i;

  // therapist narrating what was done this visit (distinct from a patient
  // simply mentioning "exercise"): needs an action verb or a clinical technique
  const TREATMENT_NARRATION_RE = /\b(perform|administered|applied|complete[ds]?|we did|did (?:some|the)|therex|scaption|manual therapy|soft tissue|mobiliz|ultrasound|e-?stim|dry needl|traction|taping|modalit)\w*/i;

  /* Stutters and verbal filler, of the kind dictation reproduces faithfully:
     "my my neck", "so it's like, um, sore". Only FUNCTION words are collapsed
     when doubled — repeating "very very" is emphasis and means something,
     repeating "my my" is a stammer and means nothing. */
  /* Dictation punctuates a stammer as if each try were a clause — "my knee,
     the, the right one" — so the repeat has to be allowed to carry a comma or
     the second "the" survives into the record. */
  const STUTTER_RE = /\b(my|the|a|an|i|it|is|was|and|to|of|in|on|that|this|you|he|she|they|we|so|ang|ng|sa|ko|na|ay)([,\s]+\1\b)+/gi;
  /* Filler only. "kanang" is NOT here: it is Cebuano hesitation AND the
     Tagalog word for the right side, and losing "kanang tuhod" costs a
     laterality. "yung" stays for the same reason — it carries grammar. */
  const VERBAL_FILLER_RE = /(^|[\s,])(?:um+|uh+|er+|ah+|like|you know|kind of|sort of|kuwan)(?=[\s,]|$)/gi;

  function tidy(raw) {
    let t = String(raw || "").trim().replace(/\s+/g, " ");
    if (!t) return "";
    t = t.replace(META_LEAD_RE, "");
    t = t.replace(STUTTER_RE, "$1");
    /* Filler sits BETWEEN the two tries of a stammer — "the um, the right
       one" — so the repeat only becomes adjacent once the filler is gone.
       One pass over the text could never see it; the second one can. */
    t = t.replace(VERBAL_FILLER_RE, "$1").replace(STUTTER_RE, "$1").replace(/\s{2,}/g, " ").replace(/\s+([,.?!])/g, "$1")
      /* "it's been, like, sore" loses the filler and keeps both commas. The
         punctuation either side of a dropped word was punctuating the word. */
      .replace(/,[\s,]*,/g, ",").replace(/,\s*([.?!])/g, "$1").replace(/^[,\s]+/, "").trim();
    t = t.replace(/^(?:so|and|okay|ok|well|then)[\s,]+/i, "");
    if (!t) return "";
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (!/[.?!]$/.test(t)) t += ".";
    return t;
  }

  const uniqueJoin = (arr) => [...new Set(arr.filter(Boolean))].join(" · ");

  // treatments the therapist narrates ("we did scaption, manual therapy…")
  const TREATMENT_RE = /\b(perform|did|complete|exercis|therex|scaption|isometric|stretch|mobiliz|manual therapy|soft tissue|ultrasound|e-?stim|tens|modalit|hot pack|cold pack|ice|heat|gait|balance|strengthen|hep|home (?:exercise )?program|educat|taping|traction|dry needl|ehersisyo|pag-?uunat|inunat|hilot|masahe|minasahe|pinainit|nilagyan ng yelo|pagsasanay)\w*/i;

  /* ---------------------------------------------------------------- *
   *  Speech that is ABOUT the visit rather than part of it
   * ---------------------------------------------------------------- *
     Live dictation pins whatever it hears, the instant it hears it. It cannot
     tell a symptom from an example of a symptom, so "you could say, oh, my
     right arm is in a lot of pain" lands on the chart as right-arm pain, and
     "so it highlights that" lands as a transcript line. Neither is something
     the patient reported. The live pass cannot fix this — it has no idea a
     sentence is hypothetical until it is finished — which is exactly the work
     the clean-up pass exists to do. */

  /* The subset the LIVE pass can act on. The comment above is true of an
     example the speaker only reveals at the end ("…my right arm is killing me,
     just as an example") — but every marker below is spoken BEFORE the region
     it introduces, so by the time the arm is heard the parser already knows it
     is an illustration and does not have to pin it and wait to be corrected.
     Deliberately narrower than HYPOTHETICAL_RE: "something like" and "para
     bang" are how people describe real symptoms ("it feels something like
     burning in my left foot"), and suppressing a pin is destructive in a way
     that trimming a transcript line is not. */
  const DEMO_LEAD_RE = /\b(?:for example|for instance|let'?s say|lets say|you (?:could|can|would|might) say|say (?:something like|for example)|just as an example|hypothetically|pretend|kunwari|halimbawa|pananglitan)\b/i;

  // "you could say…", "for example", "kunwari", "halimbawa" — an illustration,
  // not a complaint.
  const HYPOTHETICAL_RE = /\b(?:for example|for instance|let'?s say|lets say|you (?:could|can|would|might) say|if (?:i|you) said?|say (?:something like|for example)|something like|pretend|hypothetically|just as an example|kunwari|halimbawa|pananglitan|pasagdi lang nga|para bang|parang sasabihin)\b/i;

  /* An example runs to the end of its CLAUSE, not to the end of the sentence.
     "Kunwari masakit ang aking balikat PERO talaga masakit ang kanang tuhod
     ko" supposes a shoulder and then reports a knee; treating the whole line
     as hypothetical would throw away a real complaint, which is a worse error
     than the one this is here to fix. */
  /** Ranges a leading "for example"/"kunwari" governs, to the end of its
      clause — the live-safe subset of hypotheticalRanges(). */
  function demoRanges(text) {
    return markerRanges(text, DEMO_LEAD_RE);
  }

  function hypotheticalRanges(text) {
    return markerRanges(text, HYPOTHETICAL_RE);
  }

  function markerRanges(text, marker) {
    const t = String(text || "");
    const finder = new RegExp(marker.source, "gi");
    const ranges = [];
    let m;
    while ((m = finder.exec(t)) !== null) {
      CLAUSE_BREAK_RE.lastIndex = m.index + m[0].length;
      const brk = CLAUSE_BREAK_RE.exec(t);
      const end = brk ? brk.index : t.length;
      ranges.push([m.index, end]);
      finder.lastIndex = end;
    }
    return ranges;
  }

  /** The same sentence with its examples taken out — what is actually being
      reported, if anything. */
  function withoutHypotheticals(text, ranges) {
    const rs = ranges || hypotheticalRanges(text);
    if (!rs.length) return String(text || "");
    let out = "", at = 0;
    for (const [a, b] of rs) { out += String(text).slice(at, a); at = b; }
    return (out + String(text).slice(at)).replace(/\s{2,}/g, " ").replace(/^[\s,;.]+/, "").trim();
  }

  /* The therapist narrating the SOFTWARE — "so it highlights that", "it picked
     that up", "see, it went to the shoulder". About the tool, not the patient.

     The generic verbs (show, pick, log, add…) all require a demonstrative
     object, so "that put me on the floor" and "it shows in my gait" are not
     swept up with them; only "highlight", which nobody says about a body, is
     allowed to stand alone. */
  const META_CORE =
    "(?:it|this|that|the app|the system|therachart)\\s+(?:highlights?|highlighted"
    + "|(?:picks?|picked|shows?|showed|catches|caught|logs?|logged|records?|recorded|wrote|writes?|adds?|added|pins?|pinned)\\s+(?:that|it|this)(?:\\s+up)?"
    + "|(?:went|goes)\\s+to)"
    + "|on the (?:screen|body map)|body map|you can see (?:it|that|how)"
    + "|let me (?:show|demo)|testing (?:this|the app|dictation)";
  const META_RE = new RegExp("\\b(?:" + META_CORE + ")", "i");
  /* A line is often HALF commentary: "so it highlights that and then my neck
     is maybe 3 out of 10". Dropping the whole line would throw away a real
     finding, so the leading commentary clause is cut and the rest is kept. */
  const META_LEAD_RE = new RegExp(
    "^(?:so|and|then|now|okay|ok|well|see)?[\\s,]*(?:" + META_CORE + ")[^,.;]*?"
    + "(?:\\s+and\\s+then\\s+|\\s+then\\s+|\\s+and\\s+|[,;]\\s*|$)", "i");

  /* ---------------------------------------------------------------- *
   *  Corrections the patient makes later in the same conversation
   * ---------------------------------------------------------------- *
     A visit is a conversation, not a form. "My chest hurts" can become
     "sorry, I meant my arm" three sentences later — and by then the live pass
     has already pinned the chest, highlighted it, and written it into the
     note. Without a way to take a finding back, the chart keeps a symptom the
     patient explicitly withdrew, which is the kind of error that outlives the
     visit.

     The trigger is deliberately narrow, because the cost of a false positive
     is deleting something real. A bare "actually" does not count — "actually
     my knee hurts too" ADDS a finding. Nor does a plain negation: "no pain in
     the right knee" is itself a finding (a denial), not a retraction. What
     counts is an explicit repair marker. */
  const CORRECTION_RE = /\b(?:i\s+(?:actually\s+)?me(?:an|ant)\b|i\s+misspoke|my\s+mistake|scratch\s+that|take\s+that\s+back|correction\b|no,?\s+wait\b|not\s+(?:my|the)\b|hindi\s+(?:po\s+)?(?:pala|yun|iyon|yan|ito)|ay\s+mali|mali\s+(?:ako|pala|ang|yung|yun|ko)|nagkamali\s+ako|este\b|teka(?:\s+lang)?|sandali(?:\s+lang)?|ang\s+(?:ibig|gusto|nais)\s+kong\s+sabihin|dili\s+(?:diay|pala|kadto)|sayop\s+(?:ko|ako)|ang\s+buot\s+nakong\s+(?:ipasabot|isulti)|korek)/i;

  const mentionKey = (m) => `${m.partName}|${m.side || ""}`;
  const mentionLabel = (m) => `${m.side ? m.side + " " : ""}${m.partName}`.trim();

  /** True when this mention is spoken as a negation — "not my chest",
      "hindi ang balikat". Reuses the same tail pattern the summarizer uses. */
  const isNegatedMention = (text, m) =>
    NEG_TAIL_RE.test(text.slice(Math.max(0, m.start - 30), m.start));

  /* ---------------------------------------------------------------- *
   *  Does a transcript line carry anything the chart should keep?
   * ---------------------------------------------------------------- *
     Used by the clean-up pass to offer a trimmed transcript. This deletes
     clinical text, so the default is KEEP: a line goes only when it is
     plainly an acknowledgement, plainly logistics, or names a region and then
     says nothing whatsoever about it. Anything with a symptom word, a rating,
     a duration, a trigger or a measurement in it stays, however short. */
  /* Backchannel only. A bare "yes" or "no" is deliberately NOT here: answering
     "any numbness?" with "no" is a denial, and the question above it survives
     the trim, so the pair still reads. Trailing politeness particles ("po",
     "lang", "na") are part of the same non-answer. */
  const FILLER_RE = /^(?:um+|uh+|ah+|er+|hm+|mm+|mhm+|uh[-\s]?huh|mm[-\s]?hmm?|okay|ok|k|alright|all right|right|got it|i see|good|great|fine|thanks?|thank you|you'?re welcome|hello|hi|hey|good (?:morning|afternoon|evening)|bye|goodbye|see you|salamat|sige(?: lang)?|ayos|oo nga|ah oo|ayan|ayun|oks|tama|maayo|maayong (?:buntag|hapon|gabii)|kumusta|kamusta|walay problema|wala man)(?:\s+(?:po|lang|na|man|ra))*\b[\s.,!?…-]*$/i;
  /* The therapist saying what happens next. Deliberately verb-led: a bare
     "next week" is somebody leaving, not a frequency. */
  const PLAN_RE = /\b(?:continue|discontinue|progress(?:ing)?\s+to|advance\s+to|frequency|(?:one|two|three|four|five|\d+)\s*(?:x|times?)\s*(?:a|per)\s*week|\d+\s*x\s*\/?\s*week|home\s+(?:exercise\s+)?program|hep\b|re-?assess\w*|re-?evaluat\w*|plan\s+is\s+to|will\s+progress|add\s+(?:in\s+)?(?:resisted|isometric|eccentric)|ituloy|magpatuloy|padayon)\b/i;

  const LOGISTICS_RE = /\b(?:parking|traffic|jeepney|tricycle|weather|rescheduling|reschedule|next (?:week|session|visit|appointment)|see you (?:next|then)|receipts?|payments?|philhealth|hmo|insurance card|front desk|waiting (?:room|area)|comfort room|rest ?room|charger|wi-?fi|traysikel|habal-?habal|bayad|singil|resibo|trapiko|ulan|sunod(?:\s+nga)?\s+semana|susunod na linggo)\b/i;

  const SMALLTALK_RE = new RegExp([
    // greetings, thanks, compliments, farewells
    "\\b(?:good\\s+(?:morning|afternoon|evening)|how\\s+(?:are|have)\\s+you(?:\\s+been)?|nice\\s+to\\s+(?:see|meet)|thank\\s+you|thanks\\s+(?:so|very|a\\s+lot)|you'?re\\s+(?:very\\s+)?(?:kind|welcome)|take\\s+care|god\\s+bless|ingat(?:\\s+po|\\s+kayo|\\s+ka)?|(?:maraming\\s+)?salamat|walang\\s+anuman|daghang\\s+salamat)\\b",
    // the Filipino half of the same courtesies
    "\\b(?:magandang\\s+(?:umaga|hapon|gabi|araw)|maayong\\s+(?:buntag|hapon|gabii|adlaw)|ku?mu?sta(?:\\s+(?:na|po|ka|kayo|man))*|mabuti\\s+naman|okay\\s+lang\\s+po|ayos\\s+lang|hangtod\\s+sa\\s+sunod|paalam|babay)\\b",
    // family and social news
    "\\b(?:getting\\s+married|wedding|birthday|anniversary|graduation|christening|baptism|fiesta|reunion|vacation|holiday|christmas|new\\s+year|kasal|kaarawan|bakasyon|pista)\\b",
    // the room interrupting the visit
    "\\b(?:that'?s\\s+my\\s+phone|silence\\s+(?:it|my\\s+phone)|excuse\\s+me\\s+a\\s+(?:second|moment)|wait\\s+outside|step\\s+outside|one\\s+moment\\s+please|sandali\\s+lang\\s+po|labas\\s+muna)\\b",
    // television, sport, food, shopping
    "\\b(?:watch(?:ed|ing)?\\s+the\\s+(?:game|show|news|teleserye)|last\\s+night'?s\\s+game|overtime|basketball|volleyball|boxing|merienda|lunch\\s+(?:plans|later)|grocer(?:y|ies)|mall|palengke)\\b",
  ].join("|"), "i");

  /**
   * Judge one raw transcript line.
   * Returns { keep, reason } — reason is why it would be dropped, phrased for
   * a therapist reading the review screen.
   */
  function turnSubstance(raw) {
    const text = String(raw || "").trim();
    if (!text) return { keep: false, reason: "empty line" };
    if (FILLER_RE.test(text)) return { keep: false, reason: "acknowledgement only — nothing was reported" };

    /* A repair is the line that explains why something was taken off the
       chart. Trimming it away would leave the retraction unevidenced. */
    if (CORRECTION_RE.test(text)) return { keep: true, reason: "" };

    /* Judge what is left once the examples are removed. A line that is ALL
       example goes; a line that supposes one thing and reports another stays,
       because the part that stays is a real complaint. */
    const hyp = hypotheticalRanges(text);
    if (hyp.length) {
      const rest = withoutHypotheticals(text, hyp);
      /* The remainder has to carry real content, not merely survive. What is
         left of "so how is your — you could say, oh, my right arm is in a lot
         of pain" is the fragment "how is your", which reads as a clinician cue
         and is nothing at all. */
      if (rest) {
        const rr = parseUtterance(rest);
        const mm = rr.measurements;
        if (mm.rom.length || mm.mmt.length || mm.special.length || mm.pain.length
          || rr.loose || rr.mentions.some((m) => !m.bare)) return { keep: true, reason: "" };
      }
      return { keep: false, reason: "an example, not something the patient reported" };
    }

    const r = parseUtterance(text);
    const ms = r.measurements;
    if (ms.rom.length || ms.mmt.length || ms.special.length || ms.pain.length) return { keep: true, reason: "" };
    if (META_RE.test(text)) return { keep: false, reason: "about the app, not the patient" };
    if (r.mentions.some((m) => !m.bare)) return { keep: true, reason: "" };
    /* "Dr. Santos referred me for the right shoulder" and "this is consistent
       with a rotator cuff impingement" both name a region and describe no
       symptom, so the bare-mention rule below called them empty and trimmed
       the referral and the assessment out of the visit. */
    if (SECTION_RULES.some(([, re]) => re.test(text))) return { keep: true, reason: "" };
    if (r.mentions.length) {
      return { keep: false, reason: `${mentionLabel(r.mentions[0])} was named but nothing was said about it` };
    }
    /* These three are asked BEFORE the loose signal, not after it. A greeting
       or a piece of logistics reliably contains one word that reads as
       clinical on its own — "how are you TODAY" is a duration, "reschedule
       for NEXT WEEK" is a duration, "the lot fills after TEN" is a trigger —
       so consulting the loose signal first meant the rules written to catch
       small talk were never reached by any of it. */
    if (SMALLTALK_RE.test(text)) return { keep: false, reason: "small talk, not clinical content" };
    if (LOGISTICS_RE.test(text)) return { keep: false, reason: "not about the patient's condition" };
    if (r.loose) return { keep: true, reason: "" };
    // A clinician's question or cue is the context its answer needs.
    if (CLINICIAN_RE.test(text) || TREATMENT_NARRATION_RE.test(text)) return { keep: true, reason: "" };
    if (text.split(/\s+/).length <= 3) return { keep: false, reason: "no clinical content" };
    return { keep: true, reason: "" };
  }

  /* ---------------------------------------------------------------- *
   *  Does a line belong in the NOTE, as opposed to the transcript?
   * ---------------------------------------------------------------- *
     Two different questions get confused with each other:

       the TRANSCRIPT is the verbatim record of the visit. It keeps
         everything, because it is evidence and because a therapist can only
         check the note against it if it is complete. `turnSubstance` guards
         that, and it errs towards keeping.

       the NOTE is the clinical document. "Was the parking okay?", "my
         daughter is getting married next month" and "push against my hand"
         all belong in the record of what was said and in none of its
         sections — yet every one of them used to land in Subjective, because
         the live router's fallback for an unrecognised sentence was
         "Subjective" and it had no way to say "nowhere".

     This is the second question. It is stricter than `turnSubstance` on
     purpose, and it is safe to be stricter precisely because the transcript
     keeps what it turns away: nothing is lost, and the cleanup pass can still
     put a line back. Anything genuinely clinical short-circuits the whole
     test, so a symptom buried in small talk still files. */


  /* "It's worse at night" is the patient; "the lot gets full after ten" is
     not. Nothing separates them but who the sentence is about. */
  const SELF_REF_RE = /\b(?:i|i'?(?:m|ve|ll|d)|me|my|mine|myself|it'?s|its|it|ako|ko|akin|aking|sakin|nako|akong|nako|nako'?ng)\b/i;

  /* Symptom words, plus the comparatives a follow-up sentence leans on. Kept
     separate from NOUNS/ADJECTIVES, which also drive the wording of a
     summary — this list only ever answers "is this sentence clinical?". */
  const SYMPTOM_VOCAB_RE = new RegExp(
    [...NOUNS, ...ADJECTIVES].map(([, re]) => "(?:" + re.source + ")").join("|")
    + "|\\b(?:worse|worsen\\w*|better|improv\\w*|flar(?:e|ing)\\w*|easier|harder|relief|relieved|lumala|gumaling|bumuti|grabe na|mas maayo|misamot)\\b", "i");

  /**
   * Should this sentence be written into a section of the note?
   * Returns { file, reason } — `reason` explains a refusal in words a
   * therapist reading the cleanup screen can check.
   */
  function noteWorthy(raw) {
    const text = String(raw || "").trim();
    if (!text) return { file: false, reason: "empty line" };

    const r = parseUtterance(text);
    const ms = r.measurements;
    const hasMeasurement = !!(ms.rom.length || ms.mmt.length || ms.special.length || ms.pain.length);
    const hasRegion = r.mentions.some((m) => !m.bare);

    /* The only anatomy in this line belonged to someone else, to an idiom or
       to a hypothetical. Whatever else is in it ("surgery", "hurting") is
       about that, so it must not be filed under this patient's history. */
    if (!hasRegion && !hasMeasurement && !r.loose && (r.notMine || []).length) {
      return { file: false, reason: "the body part named here is " + r.notMine[0][1] + ", not the patient's" };
    }

    /* A sentence about somebody else's body need not name a region this
       parser knows — "ang akong asawa, sakit sad iyang back" names none it
       recognises, and the symptom word alone was enough to file it as the
       patient's. */
    if (!hasMeasurement && aboutSomeoneElse(text)) {
      return { file: false, reason: "this is about somebody else, not the patient" };
    }

    /* The symptom word IS the figure of speech: "MASAKIT sa bulsa" is
       expensive, "sakit sa ulo" is an annoyance. No region is named, so
       nothing above caught it — but the word doing the work sits inside a
       phrase already known to be figurative. */
    if (!hasRegion && !hasMeasurement && r.loose && typeof r.loose.start === "number"
      && figurativeRanges(text).some(([fs, fe]) => r.loose.start >= fs && r.loose.end <= fe)) {
      return { file: false, reason: "a figure of speech, not a symptom" };
    }

    /* Hard evidence — a named region that was actually described, or a
       measured value. Nothing below can talk this out of the note. */
    if (hasMeasurement || hasRegion) return { file: true, reason: "" };

    /* The vetoes come first. A therapist's cue is full of section keywords —
       "DO NOT let me move you" reads as a precaution — and a rule written to
       catch a precaution will happily catch a cue that sounds like one. */
    if (SMALLTALK_RE.test(text)) return { file: false, reason: "small talk, not clinical content" };
    /* A question or a cue is how the clinician got the answer, not the answer.
       It stays in the transcript, where it gives the reply its meaning. */
    if (CLINICIAN_RE.test(text)) return { file: false, reason: "a question or instruction, not a finding" };
    /* What happens next is documentation too. A plan sentence names no
       region and describes no symptom — "continue two times a week for four
       weeks" — so nothing above recognised it and the daily note's Plan went
       unwritten while the therapist watched themselves dictate it. Asked
       before the logistics veto, and worded so that "see you next week"
       still reads as logistics rather than as a frequency. */
    if (PLAN_RE.test(text)) return { file: true, reason: "" };
    if (LOGISTICS_RE.test(text)) return { file: false, reason: "not about the patient's condition" };

    /* A referral, a precaution or a history line often names no region and
       describes no symptom — "Dr. Santos referred me for the shoulder" reads
       as a bare mention — so this is asked before the substance veto gets to
       call it empty. */
    if (SECTION_RULES.some(([, re]) => re.test(text))) return { file: true, reason: "" };

    /* The vetoes run BEFORE the weaker signals below, because a loose symptom
       word is easy to trip by accident: "reschedule you for NEXT WEEK" reads
       as a duration, "take a DEEP breath" as a quality, "where does it HURT"
       as a symptom. Each of those filed itself into Subjective on the strength
       of one word while the sentence around it said nothing about the
       patient. */
    const sub = turnSubstance(text);
    if (!sub.keep) return { file: false, reason: sub.reason };

    /* A loose signal is one word doing all the work — a trigger ("after
       ten"), a duration ("for next week"), a comparative. On its own that is
       not enough; the sentence also has to be ABOUT somebody's body, either
       by referring to the speaker or by using symptom vocabulary. */
    if (r.loose && (SELF_REF_RE.test(text) || SYMPTOM_VOCAB_RE.test(text))) return { file: true, reason: "" };
    if (TREATMENT_NARRATION_RE.test(text)) return { file: true, reason: "" };

    /* Nothing clinical was recognised anywhere in the line. The transcript
       still has it verbatim, and the cleanup pass can put it back — but the
       note's default has to be "nowhere", not "Subjective". That default is
       what let "the lot gets full after ten" into a medical record. */
    return { file: false, reason: "nothing about the patient's condition in this line" };
  }

  /* Sentences are the unit the router files, and a patient will happily put
     the wedding and the back pain in the same one: "my daughter is getting
     married next month, but my low back is killing me". Filing that whole
     sentence puts a wedding in a medical record; refusing it loses the
     complaint.

     So the sentence is reconsidered a clause at a time, but only when doing
     so actually removes something — if every clause is clinical the sentence
     is filed whole, because a note a therapist has to read should not be
     chopped into fragments for no gain. */
  const CLAUSE_JOIN_RE = /\s*,\s*(?=(?:but|and|though|although|however|pero|kaso|tapos|ug|apan)\s)/i;

  /**
   * The part of `sentence` that belongs in the note. Returns "" when none of
   * it does, and the sentence unchanged when all of it does.
   */
  function trimToClinical(sentence) {
    const text = String(sentence || "").trim();
    if (!text) return "";
    const clauses = text.split(CLAUSE_JOIN_RE).map((c) => c.trim()).filter(Boolean);
    if (clauses.length < 2) return noteWorthy(text).file ? text : "";
    const keep = clauses.filter((c) => noteWorthy(c).file);
    if (keep.length === clauses.length) return text;
    if (!keep.length) return "";
    /* Strip a leading conjunction left dangling by the clause that went
       ("but my low back is killing me" → "my low back is killing me"). */
    return keep.map((c, i) => (i === 0 ? c.replace(/^(?:but|and|though|although|however|pero|kaso|tapos|ug|apan)\s+/i, "") : c)).join(", ");
  }

  /* ---------------------------------------------------------------- *
   *  The rest of the note
   * ---------------------------------------------------------------- *
     Live dictation files into six sections of an evaluation — reason for
     referral, precautions, past medical history, subjective, the objective
     narrative and assessment. The cleanup pass rewrote exactly one of them.

     So the therapist would dictate a referral and a precaution, watch them
     land, run the AI review to tidy the visit up, and get back a note whose
     Subjective had been rewritten and whose Precautions still held whatever
     the raw live pass had guessed — including anything this same review had
     just decided was small talk. The cleanest section of the note sat next
     to five that had never been reviewed at all.

     This drafts all of them from the same cleaned dialogue, using the same
     classifier the live pass uses, so "reviewed" means the whole note. */

  const DRAFT_SECTIONS = ["reason", "precautions", "pmh", "assessment", "objective", "subjective"];

  /**
   * Draft every note section the transcript supports.
   * `dialogue` is the cleaned, speaker-labelled turn list.
   * `opts.skipSubjective` is a set of turn indices whose content the caller
   * has already decided against (a region the patient took back).
   * Returns one paragraph per section, "" where the visit said nothing that
   * belongs there.
   */
  function sectionDrafts(dialogue, opts) {
    const skip = (opts && opts.skipSubjective) || new Set();
    const buckets = {};
    for (const k of DRAFT_SECTIONS) buckets[k] = [];

    (dialogue || []).forEach((turn, turnIndex) => {
      if (turn.keep === false) return;
      for (const raw of splitIntoSentences(turn.text)) {
        const sentence = trimToClinical(raw);
        if (!sentence) continue;

        const parsed = parseUtterance(sentence);
        const meas = parsed.measurements;
        let section = classifyUtterance(sentence, parsed, meas);

        /* Subjective is what the PATIENT reports — that is the whole
           definition of the section. The classifier has no idea who is
           talking, so a therapist observing out loud landed in the patient's
           own words; it is an objective observation instead. Every other
           section is about the patient whoever says it: a precaution is a
           precaution in either voice. */
        if (section === "subjective" && turn.speaker !== "patient") section = "objective";

        if (!Object.prototype.hasOwnProperty.call(buckets, section)) continue;
        if (section === "subjective" && skip.has(turnIndex)) continue;

        /* A sentence that is nothing but a reading — "shoulder flexion is 95
           degrees" — is already filed in the measurement table. Repeating it
           in the objective narrative is padding the reader has to check
           twice, and the two copies drift apart the moment one is edited. */
        if (section === "objective"
          && (meas.rom.length || meas.mmt.length || meas.special.length)
          && !parsed.mentions.some((m) => !m.bare)) continue;

        buckets[section].push(tidy(sentence));
      }
    });

    const out = {};
    for (const k of DRAFT_SECTIONS) out[k] = [...new Set(buckets[k])].join(" ");
    return out;
  }

  /* The same sentence split the live router uses. Kept here so the cleanup
     and the live pass cannot drift apart on where a sentence ends — titles
     included: "Dr. Santos referred me" is one sentence, not two. */
  const ABBREV_TAIL_RE = /(?:^|\s)(?:dr|dra|mr|mrs|ms|sr|jr|st|prof|atty|engr|capt|gen|rev|no|vs|approx|est|fig|dept|univ|inc|ltd|co|e\.g|i\.e|etc|a\.m|p\.m|[a-z])\.$/i;

  function splitIntoSentences(text) {
    const raw = String(text || "").match(/[^.!?;]+[.!?;]*/g) || [];
    const parts = [];
    for (const piece of raw) {
      const prev = parts[parts.length - 1];
      if (prev !== undefined && ABBREV_TAIL_RE.test(prev)) parts[parts.length - 1] = prev + piece;
      else parts.push(piece);
    }
    const out = parts.map((x) => x.trim()).filter(Boolean);
    return out.length ? out : [String(text || "")];
  }

  /** A finding's summaries, with "named this area" placeholders removed when
      anything else was actually reported about it. */
  function summariesOf(f) {
    const real = (f.summaries || []).filter((x) => !isBareMention(x));
    return real.length ? real : (f.summaries || []);
  }

  function refineTranscript(utterances) {
    const dialogue = [];
    const findingsMap = new Map();
    const patientSentences = [];
    const treatmentSentences = [];
    const corrections = new Map(); // key -> why it should come off the chart
    const illustrative = new Map(); // key -> the example sentence that produced it
    const unreported = new Map();   // key -> named, but never by the patient
    let lastKey = null;

    (utterances || []).forEach((raw) => {
      /* Everything below judges the CLEANED sentence. Reading the raw one
         would let a stripped commentary clause still decide who was speaking:
         "so it highlights that and then my neck is a 3" is the patient
         reporting a neck, once the first half is gone. */
      const text = tidy(raw);
      if (!text) return;
      const speaker = guessSpeaker(text);
      const turnIndex = dialogue.length;
      const substance = turnSubstance(text);
      dialogue.push({ speaker, text, keep: substance.keep, dropReason: substance.reason });

      if (TREATMENT_RE.test(text)) treatmentSentences.push(text);

      /* A region named by anyone OTHER than the patient reporting a symptom.
         The live pass cannot tell the difference — it pins whatever region
         word it hears, so "let's check your right arm" and "you could say, oh,
         my right arm is in a lot of pain" both put an arm on the body map.
         Remember them here; at the end, any of these the patient never
         actually complained about becomes a correction the therapist can see
         and undo. */
      const hypRanges = hypotheticalRanges(text);
      const remember = (mentions, kind, reason) => {
        for (const m of mentions) {
          const k = mentionKey(m);
          if (!unreported.has(k)) unreported.set(k, { key: k, part: m.partName, side: m.side, kind, reason, quote: text });
        }
      };
      // regions named only inside an example, clause by clause
      for (const [a, b] of hypRanges) {
        /* The marker has to come OFF the slice before it is re-parsed. This
           range is already known to be an example, and parseUtterance now
           declines to pin a region introduced by "kunwari"/"for example" —
           so leaving the marker in place asked it the question it had just
           answered, and the region went unnamed instead of unreported. */
        remember(parseUtterance(text.slice(a, b).replace(HYPOTHETICAL_RE, " ")).mentions, "hypothetical",
          "Said as an example, not reported by the patient");
      }
      if (speaker !== "patient" || META_RE.test(text)) {
        remember(parseUtterance(text).mentions,
          "not-the-patient",
          META_RE.test(text)
            ? "Said while talking about the app, not about the patient"
            : "The clinician said this — it is not the patient's report");
      }
      if (speaker !== "patient") return;
      // "Okay." and "Mm-hmm." are not Subjective content either. Each kept
      // sentence remembers which regions it spoke about, so a sentence that
      // was only ever about a retracted region can leave with it.
      const sentence = { text, keys: [], turn: turnIndex };
      if (substance.keep) patientSentences.push(sentence);

      // findings come from what is left once the examples are taken out
      const r = parseUtterance(hypRanges.length ? withoutHypotheticals(text, hypRanges) : text);
      const priorKey = lastKey; // what was on the map BEFORE this line
      const illustration = META_RE.test(text);

      /* A referral, a precaution, a history line or an impression names a
         region without complaining about it. Those sentences have their own
         sections; a mention drawn from one of them adds a pin the patient
         never asked for and, worse, gets there FIRST — so the finding leads
         with "named this area" and reads empty even after the real complaint
         arrives two lines later. */
      const asSection = classifyUtterance(text, r, r.measurements);
      const notAComplaint = ["reason", "precautions", "pmh", "assessment"].includes(asSection);
      if (notAComplaint && r.mentions.every((m) => m.bare)) return;

      if (r.mentions.length) {
        for (const m of r.mentions) {
          const key = mentionKey(m);
          let f = findingsMap.get(key);
          if (!f) {
            f = { key, part: m.partName, side: m.side, view: m.view, x: m.x, y: m.y, summaries: [], quotes: [], turns: [], bare: true, reported: false };
            findingsMap.set(key, f);
          }
          f.summaries.push(m.summary);
          f.quotes.push(m.quote);
          f.turns.push(turnIndex);
          if (!m.bare) f.bare = false;
          if (illustration) { if (!illustrative.has(key)) illustrative.set(key, text); }
          else { f.reported = true; }
          sentence.keys.push(key);
          lastKey = key;
        }
      } else if (r.loose && lastKey) {
        const f = findingsMap.get(lastKey);
        if (f) {
          f.summaries.push(r.loose.summary); f.quotes.push(r.loose.quote); f.turns.push(turnIndex); f.bare = false;
          sentence.keys.push(lastKey); // "about a seven out of ten" belongs to whatever it followed
        }
      }

      /* The patient repairing themselves. Two shapes:
           "it's not my chest, it's my arm"  → the negated region goes
           "sorry, I meant my arm"           → whatever was last pinned goes  */
      if (!CORRECTION_RE.test(text)) return;
      const negated = r.mentions.filter((m) => isNegatedMention(r.text, m));
      const negatedKeys = new Set(negated.map(mentionKey));
      const affirmed = r.mentions.filter((m) => !negatedKeys.has(mentionKey(m)));
      const replacedBy = affirmed.map(mentionLabel).join(" / ");
      const retract = (key) => {
        const f = findingsMap.get(key);
        if (!f || corrections.has(key)) return;
        corrections.set(key, {
          key, part: f.part, side: f.side, turn: turnIndex, kind: "corrected",
          supersededBy: replacedBy,
          reason: replacedBy
            ? `The patient corrected this to ${replacedBy} later in the visit`
            : "The patient took this back later in the visit",
          quote: text,
        });
      };
      if (negatedKeys.size) negatedKeys.forEach(retract);
      else if (affirmed.length && priorKey && !affirmed.some((m) => mentionKey(m) === priorKey)) retract(priorKey);
    });

    /* A region that was only ever named inside an example or a line about the
       app was never reported by anyone. It reaches here because the live pass
       pinned it mid-sentence; this is where it comes back off. */
    for (const [key, quote] of illustrative) {
      const f = findingsMap.get(key);
      if (!f || f.reported || corrections.has(key)) continue;
      corrections.set(key, {
        key, part: f.part, side: f.side, kind: "hypothetical", supersededBy: "",
        reason: "Said as an example, not reported by the patient",
        quote,
      });
    }

    /* Regions the live pass will have pinned from somebody else's words. They
       are not findings here — nobody reported them — so they only exist as
       something for the review screen to offer to remove. */
    for (const [key, u] of unreported) {
      if (findingsMap.has(key) || corrections.has(key)) continue;
      corrections.set(key, { ...u, supersededBy: "" });
    }

    const findings = [...findingsMap.values()].map((f) => ({
      key: f.key, part: f.part, side: f.side, view: f.view, x: f.x, y: f.y,
      /* A region can be named in passing before it is ever described — the
         referral says "the right shoulder", and two lines later the patient
         says what is wrong with it. Joining every summary in order left the
         placeholder in front, so the finished finding READ as a bare mention
         and the review screen offered a real complaint for deletion. Drop the
         placeholders once there is something real to say. */
      summary: uniqueJoin(summariesOf(f)), quote: f.quotes[0] || "", turns: f.turns,
      bare: f.bare, corrected: corrections.has(f.key),
    }));

    const measurements = aggregateMeasurements(dialogue.filter((d) => d.keep).map((d) => d.text));

    /* A turn that was only ever about a region the patient took back — or
       never really reported — must not survive in the Subjective either. */
    const skipSubjective = new Set(patientSentences
      .filter((x) => x.keys.length && x.keys.every((k) => corrections.has(k)))
      .map((x) => x.turn));

    const drafts = sectionDrafts(dialogue, { skipSubjective });
    return {
      dialogue, findings, measurements, source: "local",
      corrections: [...corrections.values()],
      /* Every section the visit supports, all drafted from the same cleaned
         dialogue. Each sentence lands in exactly one of them: a referral is
         the reason for referral and is not ALSO repeated in Subjective, which
         is what happened while Subjective was built from every patient
         sentence regardless of where it belonged. */
      reason: drafts.reason,
      precautions: drafts.precautions,
      pmh: drafts.pmh,
      assessment: drafts.assessment,
      objective: drafts.objective,
      subjective: drafts.subjective,
      treatment: treatmentSentences.join(" "),
    };
  }

  // run measurement extraction across every turn and de-duplicate
  function aggregateMeasurements(texts) {
    const out = { rom: [], mmt: [], special: [], pain: [] };
    const seen = new Set();
    for (const t of texts) {
      /* Extract WITH the sentence's body-part mentions. Without them a pain
         rating has nowhere to live — "my right shoulder is a seven out of
         ten" came back as an unlocated 7/10, which is both a worse record
         and a second row in the table, because the live pass had already
         filed the located one and the two no longer looked like duplicates. */
      const m = parseUtterance(t).measurements;
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
    noteWorthy,
    trimToClinical,
    sectionDrafts,
    splitIntoSentences,
    refineTranscript,
    turnSubstance,
    isBareMention,
    CORRECTION_RE,
    HYPOTHETICAL_RE,
    META_RE,
    hypotheticalRanges,
    withoutHypotheticals,
    BODY_PARTS,
  };
});
