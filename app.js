/* TheraChart — listen while the user talks, pin body-part mentions to a map,
   and store a short summarized note for each spot. Everything runs locally. */

(() => {
  "use strict";

  /* ---------------------------------------------------------------- *
   *  Body map figure (shared silhouette, drawn once per view)
   * ---------------------------------------------------------------- */

  const VIEW_W = 200;
  const VIEW_H = 460;

  function figureMarkup(view) {
    const spineLine =
      view === "back"
        ? `<line class="silhouette-line" x1="100" y1="80" x2="100" y2="190"/>`
        : "";
    return `
<svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" xmlns="http://www.w3.org/2000/svg" data-view="${view}">
  <g class="silhouette-group">
    <ellipse class="silhouette" cx="100" cy="36" rx="20" ry="24"/>
    <line class="silhouette" x1="100" y1="56" x2="100" y2="76"
          stroke="#cfdce6" stroke-width="16"/>
    <path class="silhouette" d="M64,78 L136,78 Q143,78 142,88 L137,178
             Q136,190 126,194 L74,194 Q64,190 63,178 L58,88 Q57,78 64,78 Z"/>
    <rect class="silhouette" x="70" y="190" width="60" height="38" rx="15"/>
    <line class="silhouette" x1="53" y1="92" x2="37" y2="226"
          stroke="#cfdce6" stroke-width="17" stroke-linecap="round"/>
    <line class="silhouette" x1="147" y1="92" x2="163" y2="226"
          stroke="#cfdce6" stroke-width="17" stroke-linecap="round"/>
    <circle class="silhouette" cx="35" cy="240" r="9"/>
    <circle class="silhouette" cx="165" cy="240" r="9"/>
    <line class="silhouette" x1="86" y1="222" x2="84" y2="396"
          stroke="#cfdce6" stroke-width="23" stroke-linecap="round"/>
    <line class="silhouette" x1="114" y1="222" x2="116" y2="396"
          stroke="#cfdce6" stroke-width="23" stroke-linecap="round"/>
    <ellipse class="silhouette" cx="80" cy="410" rx="14" ry="8"/>
    <ellipse class="silhouette" cx="120" cy="410" rx="14" ry="8"/>
    ${spineLine}
  </g>
  <g class="points-layer"></g>
</svg>`;
  }

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
    // Generic "back" only when clearly the body part ("my back", not "come back" / "back of")
    P("Back", "(?<=\\b(?:my|his|her|your|the)\\s)back\\b(?!\\s+of)", { view: "back", y: 150 }),

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
    P("Chest", "chest|pec(?:toral)?s?|breast\\s?bone|sternum", { dx: 14, y: 112, sided: true, centerIfNoSide: true }),
    P("Ribs", "ribs?|rib\\s?cage", { dx: 20, y: 135, sided: true, centerIfNoSide: true }),
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
    ["shooting", /\bshooting\b/i],
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
    ["a possible sprain", /\bsprain(?:ed)?\b/i],
    ["a possible strain", /\bstrain(?:ed)?\b/i],
    ["a possible tear", /\b(?:tore|torn)\b/i],
    ["a possible fracture", /\b(?:broke(?:n)?|fracture(?:d)?)\b/i],
    ["a twist injury", /\btwisted\b/i],
  ];

  const SEVERE_RE = /\b(really|very|extremely|severe(?:ly)?|terribl[ye]|excruciating|unbearable|awful|so much|super|badly|killing me)\b/i;
  const MILD_RE = /\b(slightly|a\s+(?:little|bit|touch)|mild(?:ly)?|minor|somewhat|kind of|sort of)\b/i;
  const RATING_RE = /\b(\d{1,2})\s*(?:\/|out of)\s*(?:10|ten)\b/i;
  const DURATION_RE = /\b((?:for|since|over)\s+(?:the\s+)?(?:last\s+|past\s+)?(?:about\s+)?(?:a\s+|an\s+|few\s+|couple(?:\s+of)?\s+|\w+\s+)?(?:days?|weeks?|months?|years?|hours?|nights?|mornings?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|christmas|childhood))\b/i;
  const TRIGGER_RE = /\b((?:when(?:ever)?|every time|after|while)\s+(?:i|he|she|they)\s+[a-z' ]{2,32})/i;

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

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
          return m ? { word, d: distFrom(m.index, m[0].length) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.d - b.d);

    const adjs = found(ADJECTIVES).filter((a) => a.d <= 45).map((a) => a.word);
    const nearNouns = found(NOUNS).filter((n) => n.d <= 55);

    let main = "";
    if (nearNouns.length) {
      const primary = nearNouns[0].word;
      const extra = nearNouns.slice(1, 3).filter((n) => n.d <= 40).map((n) => n.word);
      main = adjs.length ? `${adjs.slice(0, 3).join(", ")} ${primary}` : primary;
      if (extra.length) main += ` with ${extra.join(" and ")}`;
    } else if (adjs.length) {
      main = `${adjs.slice(0, 3).join(", ")} discomfort`;
    }

    if (main) {
      if (SEVERE_RE.test(windowText)) main = `significant ${main}`;
      else if (MILD_RE.test(windowText)) main = `mild ${main}`;
    }

    const bits = [];
    if (main) bits.push(cap(main));

    const rating = windowText.match(RATING_RE);
    if (rating) bits.push(`rated ${rating[1]}/10`);

    const duration = windowText.match(DURATION_RE);
    if (duration) bits.push(`ongoing ${duration[1].trim()}`);

    const trigger = windowText.match(TRIGGER_RE);
    if (trigger) bits.push(`worse ${trigger[1].trim()}`);

    if (!bits.length) {
      const snippet = windowText.trim().replace(/\s+/g, " ").slice(0, 90);
      return `Mentioned this area — “${snippet}${windowText.trim().length > 90 ? "…" : ""}”`;
    }
    return bits.join(" · ");
  }

  /* ---------------------------------------------------------------- *
   *  State + rendering
   * ---------------------------------------------------------------- */

  const points = new Map(); // key: "Part|side" -> point object
  let pointCounter = 0;

  const frontMap = document.getElementById("frontMap");
  const backMap = document.getElementById("backMap");
  frontMap.innerHTML = figureMarkup("front");
  backMap.innerHTML = figureMarkup("back");

  const layers = {
    front: frontMap.querySelector(".points-layer"),
    back: backMap.querySelector(".points-layer"),
  };

  const notesList = document.getElementById("notesList");
  const emptyMsg = document.getElementById("emptyMsg");

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

  function addMention(part, side, summary, quote) {
    const key = `${part.name}|${side || ""}`;
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    let point = points.get(key);
    if (!point) {
      pointCounter += 1;
      const { x, y } = coordFor(part, side);
      point = {
        id: pointCounter,
        key,
        part: part.name,
        side,
        view: part.view,
        x,
        y,
        notes: [],
      };
      points.set(key, point);
      drawPoint(point);
    }
    // Skip exact repeats (speech engines often re-finalize the same phrase)
    const last = point.notes[point.notes.length - 1];
    if (!last || last.summary !== summary) {
      point.notes.push({ time, summary, quote });
    }
    renderNotes();
    flashPoint(point);
  }

  function drawPoint(point) {
    const svgNS = "http://www.w3.org/2000/svg";
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "point-group");
    g.dataset.key = point.key;

    const ring = document.createElementNS(svgNS, "circle");
    ring.setAttribute("class", "point-ring");
    ring.setAttribute("cx", point.x);
    ring.setAttribute("cy", point.y);
    ring.setAttribute("r", 10);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("class", "point-dot");
    dot.setAttribute("cx", point.x);
    dot.setAttribute("cy", point.y);
    dot.setAttribute("r", 8);

    const num = document.createElementNS(svgNS, "text");
    num.setAttribute("class", "point-num");
    num.setAttribute("x", point.x);
    num.setAttribute("y", point.y);
    num.textContent = point.id;

    const title = document.createElementNS(svgNS, "title");
    title.textContent = pointLabel(point);
    dot.appendChild(title);

    g.append(ring, dot, num);
    g.addEventListener("click", () => {
      const card = notesList.querySelector(`[data-key="${CSS.escape(point.key)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.style.background = "#fff3d6";
        setTimeout(() => (card.style.background = ""), 900);
      }
    });
    layers[point.view].appendChild(g);
  }

  function pointLabel(point) {
    const sideTxt = point.side ? `${cap(point.side)} ` : "";
    return `${sideTxt}${point.part.toLowerCase()}`.trim().replace(/^./, (c) => c.toUpperCase());
  }

  function flashPoint(point) {
    const g = layers[point.view].querySelector(`[data-key="${CSS.escape(point.key)}"]`);
    if (!g) return;
    g.classList.add("flash");
    setTimeout(() => g.classList.remove("flash"), 1200);
    // refresh hover tooltip with the latest summary
    const title = g.querySelector("title");
    const latest = point.notes[point.notes.length - 1];
    if (title && latest) title.textContent = `${pointLabel(point)} — ${latest.summary}`;
  }

  function renderNotes() {
    emptyMsg.style.display = points.size ? "none" : "";
    notesList.querySelectorAll(".note-card").forEach((el) => el.remove());
    const sorted = [...points.values()].sort((a, b) => a.id - b.id);
    for (const point of sorted) {
      const card = document.createElement("div");
      card.className = "note-card";
      card.dataset.key = point.key;
      const viewTag = point.view === "back" ? "back view" : "front view";
      card.innerHTML = `
        <div class="card-head">
          <span class="part"><span class="badge">${point.id}</span>${pointLabel(point)}</span>
          <span class="view-tag">${viewTag}</span>
        </div>
        <ul>${point.notes
          .map(
            (n) =>
              `<li>${escapeHtml(n.summary)}<span class="time">${n.time}</span><br>` +
              `<span class="quote">“${escapeHtml(n.quote)}”</span></li>`
          )
          .join("")}</ul>`;
      card.addEventListener("click", () => flashPoint(point));
      notesList.appendChild(card);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------------------------------------------------------------- *
   *  Text processing: find body parts in a finished utterance
   * ---------------------------------------------------------------- */

  function processUtterance(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const claimed = []; // [start, end] ranges already matched

    for (const part of BODY_PARTS) {
      part.re.lastIndex = 0;
      let m;
      while ((m = part.re.exec(trimmed)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        claimed.push([start, end]);

        let side = null;
        if (part.fixedSide) side = part.fixedSide;
        else if (part.sided && m[1]) side = m[1].toLowerCase();
        else if (part.sided && part.centerIfNoSide) side = null;
        else if (part.sided) side = null; // paired part, side unspecified

        const winStart = Math.max(0, start - 80);
        const winEnd = Math.min(trimmed.length, end + 80);
        const windowText = trimmed.slice(winStart, winEnd);
        const summary = summarize(windowText, start - winStart, end - winStart);

        addMention(part, side, summary, snippet(trimmed, start, end));
      }
    }
  }

  function snippet(text, start, end) {
    const s = Math.max(0, start - 45);
    const e = Math.min(text.length, end + 45);
    return (
      (s > 0 ? "…" : "") +
      text.slice(s, e).trim() +
      (e < text.length ? "…" : "")
    );
  }

  /* ---------------------------------------------------------------- *
   *  Speech recognition
   * ---------------------------------------------------------------- */

  const micBtn = document.getElementById("micBtn");
  const micLabel = document.getElementById("micLabel");
  const statusEl = document.getElementById("status");
  const transcriptEl = document.getElementById("transcript");

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;

  if (SR) {
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          const finalText = res[0].transcript.trim();
          transcriptEl.textContent = finalText;
          processUtterance(finalText);
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) transcriptEl.textContent = interim + " …";
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        listening = false;
        setMicUI();
        statusEl.textContent = "Mic blocked — allow microphone access and retry.";
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        statusEl.textContent = `Mic error: ${event.error}`;
      }
    };

    // Chrome stops recognition periodically; restart while we're meant to listen.
    recognition.onend = () => {
      if (listening) {
        try { recognition.start(); } catch (_) { /* already starting */ }
      } else {
        setMicUI();
      }
    };
  } else {
    statusEl.textContent = "Speech not supported here — use the text box below.";
    micBtn.disabled = true;
    micBtn.style.opacity = 0.5;
  }

  function setMicUI() {
    micBtn.classList.toggle("listening", listening);
    micLabel.textContent = listening ? "Stop listening" : "Start listening";
    statusEl.textContent = listening ? "Listening…" : "Mic off";
  }

  micBtn.addEventListener("click", () => {
    if (!recognition) return;
    if (listening) {
      listening = false;
      recognition.stop();
    } else {
      listening = true;
      try { recognition.start(); } catch (_) { /* already started */ }
    }
    setMicUI();
  });

  /* ---------------------------------------------------------------- *
   *  Manual input + demo + export + clear
   * ---------------------------------------------------------------- */

  const manualInput = document.getElementById("manualInput");
  manualInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && manualInput.value.trim()) {
      transcriptEl.textContent = manualInput.value.trim();
      processUtterance(manualInput.value);
      manualInput.value = "";
    }
  });

  const DEMO_LINES = [
    "My left shoulder has been really sore for two weeks, especially when I reach overhead.",
    "I also get a sharp shooting pain in my lower back when I bend over, maybe a 7 out of 10.",
    "My right knee clicks and feels stiff in the morning.",
    "And I've had a dull headache since yesterday with some tightness in my neck.",
  ];

  document.getElementById("demoBtn").addEventListener("click", () => {
    let delay = 0;
    for (const line of DEMO_LINES) {
      setTimeout(() => {
        transcriptEl.textContent = line;
        processUtterance(line);
      }, delay);
      delay += 1400;
    }
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    if (!points.size) return;
    const lines = [
      `TheraChart session notes — ${new Date().toLocaleString()}`,
      "",
    ];
    for (const point of [...points.values()].sort((a, b) => a.id - b.id)) {
      lines.push(`${point.id}. ${pointLabel(point)} (${point.view} view)`);
      for (const n of point.notes) {
        lines.push(`   - [${n.time}] ${n.summary}`);
        lines.push(`     said: "${n.quote}"`);
      }
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `therachart-notes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!points.size) return;
    if (!confirm("Remove all points and notes for this session?")) return;
    points.clear();
    pointCounter = 0;
    layers.front.innerHTML = "";
    layers.back.innerHTML = "";
    renderNotes();
  });
})();
