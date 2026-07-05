/* TheraChart app — listens while the user talks, pins body-part mentions to
   a map via the shared parser (parser.js), keeps the full transcript, and
   links every summarized note back to the exact words it came from. */

(() => {
  "use strict";

  const parser = window.TheraParser;

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
          stroke-width="16"/>
    <path class="silhouette" d="M64,78 L136,78 Q143,78 142,88 L137,178
             Q136,190 126,194 L74,194 Q64,190 63,178 L58,88 Q57,78 64,78 Z"/>
    <rect class="silhouette" x="70" y="190" width="60" height="38" rx="15"/>
    <line class="silhouette" x1="53" y1="92" x2="37" y2="226"
          stroke-width="17" stroke-linecap="round"/>
    <line class="silhouette" x1="147" y1="92" x2="163" y2="226"
          stroke-width="17" stroke-linecap="round"/>
    <circle class="silhouette" cx="35" cy="240" r="9"/>
    <circle class="silhouette" cx="165" cy="240" r="9"/>
    <line class="silhouette" x1="86" y1="222" x2="84" y2="396"
          stroke-width="23" stroke-linecap="round"/>
    <line class="silhouette" x1="114" y1="222" x2="116" y2="396"
          stroke-width="23" stroke-linecap="round"/>
    <ellipse class="silhouette" cx="80" cy="410" rx="14" ry="8"/>
    <ellipse class="silhouette" cx="120" cy="410" rx="14" ry="8"/>
    ${spineLine}
  </g>
  <g class="points-layer"></g>
</svg>`;
  }

  /* ---------------------------------------------------------------- *
   *  State
   * ---------------------------------------------------------------- */

  const utterances = []; // {id, time, text}
  const points = new Map(); // key "Part|side" -> point
  const unassigned = []; // symptoms with no clear body part: review bucket
  let pointCounter = 0;
  let lastPointKey = null; // most recently mentioned point (for follow-ups)
  let lastPointUtt = -1;
  let activeHlKey = null; // which point/card is currently highlighted

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
  const transcriptLog = document.getElementById("transcriptLog");
  const transcriptEmpty = document.getElementById("transcriptEmpty");

  const nowTime = () =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ---------------------------------------------------------------- *
   *  Transcript
   * ---------------------------------------------------------------- */

  function addUtterance(text, time) {
    const id = utterances.length;
    utterances.push({ id, time, text });
    transcriptEmpty.style.display = "none";
    const el = document.createElement("div");
    el.className = "utt";
    el.dataset.utt = id;
    el.innerHTML =
      `<span class="utt-time">${time}</span>` +
      `<span class="utt-text">${escapeHtml(text)}</span>`;
    transcriptLog.appendChild(el);
    transcriptLog.scrollTop = transcriptLog.scrollHeight;
    return id;
  }

  /** Render an utterance's text with optional highlight ranges.
      marks: array of [start, end, strong]. Overlaps are fine — the
      strongest level wins per character. */
  function uttHtml(text, marks) {
    if (!marks || !marks.length) return escapeHtml(text);
    const level = new Uint8Array(text.length);
    for (const [s, e, strong] of marks) {
      const lv = strong ? 2 : 1;
      for (let i = Math.max(0, s); i < Math.min(text.length, e); i++) {
        if (level[i] < lv) level[i] = lv;
      }
    }
    let html = "";
    let i = 0;
    while (i < text.length) {
      const lv = level[i];
      let j = i;
      while (j < text.length && level[j] === lv) j++;
      const chunk = escapeHtml(text.slice(i, j));
      if (lv === 2) html += `<mark class="hl strong">${chunk}</mark>`;
      else if (lv === 1) html += `<mark class="hl">${chunk}</mark>`;
      else html += chunk;
      i = j;
    }
    return html;
  }

  function clearHighlights() {
    activeHlKey = null;
    for (const utt of utterances) {
      const el = transcriptLog.querySelector(`[data-utt="${utt.id}"] .utt-text`);
      if (el) el.innerHTML = escapeHtml(utt.text);
    }
    notesList
      .querySelectorAll(".note-card.selected")
      .forEach((c) => c.classList.remove("selected"));
  }

  /** Highlight every passage of the transcript that fed a point's notes,
      then scroll to the first one. */
  function highlightNotes(key, notes) {
    clearHighlights();
    activeHlKey = key;
    const byUtt = new Map();
    for (const n of notes) {
      if (n.uttId == null) continue;
      if (!byUtt.has(n.uttId)) byUtt.set(n.uttId, []);
      byUtt.get(n.uttId).push(...n.marks);
    }
    let first = null;
    for (const [uttId, marks] of byUtt) {
      const utt = utterances[uttId];
      const el = transcriptLog.querySelector(`[data-utt="${uttId}"] .utt-text`);
      if (!utt || !el) continue;
      el.innerHTML = uttHtml(utt.text, marks);
      if (first === null || uttId < first) first = uttId;
    }
    if (first !== null) {
      const target = transcriptLog.querySelector(`[data-utt="${first}"]`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const card = notesList.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (card) card.classList.add("selected");
  }

  function selectPoint(point, { scrollCard = false } = {}) {
    if (activeHlKey === point.key) {
      clearHighlights();
      return;
    }
    highlightNotes(point.key, point.notes);
    flashPoint(point);
    if (scrollCard) {
      const card = notesList.querySelector(`[data-key="${CSS.escape(point.key)}"]`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  /* ---------------------------------------------------------------- *
   *  Points
   * ---------------------------------------------------------------- */

  function keyOf(mention) {
    return `${mention.partName}|${mention.side || ""}`;
  }

  function addMention(mention, uttId, time) {
    const key = keyOf(mention);
    let point = points.get(key);
    if (!point) {
      pointCounter += 1;
      point = {
        id: pointCounter,
        key,
        part: mention.partName,
        side: mention.side,
        view: mention.view,
        x: mention.x,
        y: mention.y,
        notes: [],
      };
      // Nudge apart points that would sit on top of each other
      const others = [...points.values()];
      while (
        others.some(
          (p) =>
            p.view === point.view &&
            Math.abs(p.x - point.x) < 9 &&
            Math.abs(p.y - point.y) < 10
        )
      ) {
        point.y += 12;
      }
      points.set(key, point);
      drawPoint(point);
    }
    pushNote(point, {
      time,
      summary: mention.summary,
      quote: mention.quote,
      uttId,
      marks: [
        [mention.winStart, mention.winEnd, false],
        [mention.start, mention.end, true],
      ],
    });
    return point;
  }

  function pushNote(point, note) {
    const last = point.notes[point.notes.length - 1];
    // Speech engines sometimes re-finalize the same phrase — skip repeats
    if (last && last.summary === note.summary && last.uttId === note.uttId) return;
    point.notes.push(note);
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
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      selectPoint(point, { scrollCard: true });
    });
    layers[point.view].appendChild(g);
  }

  function pointLabel(point) {
    const sideTxt = point.side ? `${cap(point.side)} ` : "";
    return cap(`${sideTxt}${point.part.toLowerCase()}`.trim());
  }

  function flashPoint(point) {
    const g = layers[point.view].querySelector(`[data-key="${CSS.escape(point.key)}"]`);
    if (!g) return;
    g.classList.add("flash");
    setTimeout(() => g.classList.remove("flash"), 1200);
    const title = g.querySelector("title");
    const latest = point.notes[point.notes.length - 1];
    if (title && latest) title.textContent = `${pointLabel(point)} — ${latest.summary}`;
  }

  /* ---------------------------------------------------------------- *
   *  Notes panel
   * ---------------------------------------------------------------- */

  function renderNotes() {
    emptyMsg.style.display = points.size || unassigned.length ? "none" : "";
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
              `<li>${escapeHtml(n.summary)}` +
              (n.followUp ? `<span class="follow-tag">follow-up</span>` : "") +
              `<span class="time">${n.time}</span><br>` +
              `<span class="quote">“${escapeHtml(n.quote)}”</span></li>`
          )
          .join("")}</ul>`;
      card.addEventListener("click", () => selectPoint(point));
      notesList.appendChild(card);
    }

    for (const item of unassigned) {
      const card = document.createElement("div");
      card.className = "note-card unassigned";
      card.dataset.key = item.key;
      card.innerHTML = `
        <div class="card-head">
          <span class="part">Needs review</span>
          <span class="view-tag">no body area named</span>
        </div>
        <ul><li>${escapeHtml(item.summary)}<span class="time">${item.time}</span><br>
          <span class="quote">“${escapeHtml(item.quote)}”</span></li></ul>`;
      card.addEventListener("click", () => {
        if (activeHlKey === item.key) clearHighlights();
        else {
          highlightNotes(item.key, [
            { uttId: item.uttId, marks: [[0, utterances[item.uttId].text.length, false]] },
          ]);
        }
      });
      notesList.appendChild(card);
    }
  }

  /* ---------------------------------------------------------------- *
   *  Utterance processing (parser + follow-up/review checker)
   * ---------------------------------------------------------------- */

  function processUtterance(raw) {
    const parsed = parser.parseUtterance(raw);
    if (!parsed.text) return;
    const time = nowTime();
    const uttId = addUtterance(parsed.text, time);

    if (parsed.mentions.length) {
      for (const mention of parsed.mentions) addMention(mention, uttId, time);
      const lastMention = parsed.mentions[parsed.mentions.length - 1];
      lastPointKey = keyOf(lastMention);
      lastPointUtt = uttId;
    } else if (parsed.loose) {
      // Symptoms without a named body part: attach to the point we were just
      // talking about ("it's a 6 out of 10"), or flag for review — never drop.
      const anchor = points.get(lastPointKey);
      if (anchor && uttId - lastPointUtt <= 2) {
        pushNote(anchor, {
          time,
          summary: parsed.loose.summary,
          quote: parsed.loose.quote,
          uttId,
          marks: [[0, parsed.text.length, false]],
          followUp: true,
        });
        lastPointUtt = uttId; // keep the conversational thread alive
      } else {
        unassigned.push({
          key: `unassigned|${unassigned.length}`,
          time,
          summary: parsed.loose.summary,
          quote: parsed.loose.quote,
          uttId,
        });
        renderNotes();
      }
    }
  }

  /* ---------------------------------------------------------------- *
   *  Speech recognition
   * ---------------------------------------------------------------- */

  const micBtn = document.getElementById("micBtn");
  const micLabel = document.getElementById("micLabel");
  const statusEl = document.getElementById("status");
  const interimEl = document.getElementById("interim");

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
          processUtterance(res[0].transcript);
        } else {
          interim += res[0].transcript;
        }
      }
      interimEl.textContent = interim ? interim + " …" : "…";
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
      processUtterance(manualInput.value);
      manualInput.value = "";
    }
  });

  const DEMO_LINES = [
    "My left shoulder has been really sore for two weeks, especially when I reach overhead.",
    "I also get a sharp shooting pain in my lower back when I bend over.",
    "It shoots down into my right leg after sitting for a while.",
    "It's probably a six out of ten at night.",
    "My right knee used to bother me, but I don't have any pain in it anymore.",
    "And I've had a dull headache since yesterday with some tightness in my neck.",
  ];

  document.getElementById("demoBtn").addEventListener("click", () => {
    let delay = 0;
    for (const line of DEMO_LINES) {
      setTimeout(() => processUtterance(line), delay);
      delay += 1300;
    }
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    if (!points.size && !unassigned.length && !utterances.length) return;
    const lines = [
      `TheraChart session notes — ${new Date().toLocaleString()}`,
      "",
      "FINDINGS",
    ];
    for (const point of [...points.values()].sort((a, b) => a.id - b.id)) {
      lines.push(`${point.id}. ${pointLabel(point)} (${point.view} view)`);
      for (const n of point.notes) {
        lines.push(`   - [${n.time}] ${n.summary}${n.followUp ? " (follow-up)" : ""}`);
        lines.push(`     said: "${n.quote}"`);
      }
      lines.push("");
    }
    if (unassigned.length) {
      lines.push("NEEDS REVIEW (no body area named)");
      for (const item of unassigned) {
        lines.push(`   - [${item.time}] ${item.summary}`);
        lines.push(`     said: "${item.quote}"`);
      }
      lines.push("");
    }
    lines.push("FULL TRANSCRIPT");
    for (const utt of utterances) {
      lines.push(`[${utt.time}] ${utt.text}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `therachart-notes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!points.size && !utterances.length && !unassigned.length) return;
    if (!confirm("Remove all points, notes, and the transcript for this session?")) return;
    points.clear();
    unassigned.length = 0;
    utterances.length = 0;
    pointCounter = 0;
    lastPointKey = null;
    lastPointUtt = -1;
    activeHlKey = null;
    layers.front.innerHTML = "";
    layers.back.innerHTML = "";
    transcriptLog.innerHTML = "";
    transcriptLog.appendChild(transcriptEmpty);
    transcriptEmpty.style.display = "";
    renderNotes();
  });

  // Clicking empty space in the transcript clears the current highlight
  transcriptLog.addEventListener("click", (e) => {
    if (e.target === transcriptLog) clearHighlights();
  });
})();
