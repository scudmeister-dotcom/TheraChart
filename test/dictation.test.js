/* TheraChart live-dictation checker — the microphone's backstops.

   Live dictation is the only feature that spends money continuously while a
   clinician is not looking at it. Google bills Chirp 2 by the second of audio
   SUBMITTED, so the voice gate, the idle stop and the per-visit ceiling are
   not polish — they are the difference between a peso a minute of speech and a
   peso a minute of aircon. None of it had a single test.

   What it cost to have none: the idle backstop announced a stop, flipped the
   button back to "Listen" and then left the audio graph connected and
   `listening` true. The microphone stayed hot. Speech after an "auto-stop" was
   still gated, still POSTed and still billed, and the next tap built a SECOND
   graph on top of the live one — both feeding the same buffer. Separately, a
   gate calibrated while the therapist was already talking set its bar above
   their own voice, so their speech read as silence and the mic hung up on them
   mid-visit.

   These checks pin the properties that keep both from coming back:
     - a backstop that fires actually RELEASES the microphone
     - and fires once, not on every frame afterwards
     - restarting never leaves two graphs running
     - audible speech always resets the idle timer, whatever the gate thinks
     - calibrating through speech never raises the bar above speech

   The engine is a browser closure, so it is lifted out of app.js and run here
   against a fake AudioContext. That is deliberate: testing the real source text
   is the only way this file can fail when app.js regresses.

   Run: node test/dictation.test.js */

"use strict";

const fs = require("fs");
const path = require("path");
const { reporter } = require("./helpers/server.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

/* The overlap helpers are plain string functions inside the page IIFE, so they
   are lifted and run rather than pattern-matched. splitSentences comes with
   them because overlapSentences calls it, and ABBREV_RE is injected because it
   lives further up the file than anything else here needs. */
function liftOverlap() {
  const slice = (from, to) => {
    const a = SRC.indexOf(from);
    if (a < 0) throw new Error(`app.js no longer contains: ${from}`);
    const b = SRC.indexOf(to, a);
    if (b < 0) throw new Error(`could not find the end of: ${from}`);
    return SRC.slice(a, b + to.length);
  };
  const fn = (decl) => slice(decl, "\n  }\n");
  const body = [
    slice("  const OVERLAP_STOP", 'about").split(" "));'),
    fn("  function contentWords"),
    /^  const SEEN_AT = .*$/m.exec(SRC)[0],
    fn("  function splitSentences"),
    fn("  function overlapSentences"),
  ].join("\n");
  return new Function("ABBREV_RE", `${body}\n; return { overlapSentences, contentWords };`)(
    /\b(dr|mr|mrs|ms|vs|approx|etc|no)\.$/i);
}

/* Slice one function out of app.js by its declaration. Everything inside the
   page's IIFE is indented two spaces, so a line that is exactly "  }" is the
   function's own closing brace and nothing else. */
function lift(decl) {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`app.js no longer contains: ${decl}`);
  const end = SRC.indexOf("\n  }\n", start);
  if (end < 0) throw new Error(`could not find the end of: ${decl}`);
  return SRC.slice(start, end + 5);
}

const SANDBOX = new Function(
  "STT_LANG", "STT_LANG_DEFAULT", "STT_MODEL", "window", "navigator", "fetch",
  [lift("  function micConstraints() {"),
   lift("  function voiceGate() {"),
   lift("  function encodeWav("),
   lift("  function cloudEngine(")].join("\n")
  + "\n  return { micConstraints, voiceGate, encodeWav, cloudEngine };"
);

/* ---- a microphone that isn't there ---- */
function fakeAudio() {
  const state = { streams: [], contexts: [], nodes: [], posted: 0, seconds: 0 };
  const tracks = () => {
    const t = { stopped: false, stop() { this.stopped = true; } };
    return [t];
  };
  class Ctx {
    constructor() {
      this.sampleRate = 16000;
      this.state = "running";
      this.destination = {};
      state.contexts.push(this);
    }
    createMediaStreamSource() { return { connect() { } }; }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connect() { }, disconnect() { this.disconnected = true; } };
      state.nodes.push(node);
      return node;
    }
    close() { this.state = "closed"; }
  }
  const win = { AudioContext: Ctx, TheraSync: { token: "t" } };
  const nav = {
    mediaDevices: {
      async getUserMedia() {
        const s = { tracks: tracks(), getTracks() { return this.tracks; } };
        state.streams.push(s);
        return s;
      },
    },
  };
  const fetchStub = async () => {
    state.posted++;
    return { ok: true, status: 200, json: async () => ({ text: "hello", billedSeconds: 1 }) };
  };
  return { state, win, nav, fetchStub, Ctx };
}

const FRAME = 4096;                       // samples
const FRAME_MS = (FRAME / 16000) * 1000;  // 256ms at the fake context's rate

/** One frame of constant-amplitude audio: rms comes out equal to `amp`. */
function frame(amp) {
  const d = new Float32Array(FRAME);
  d.fill(amp);
  return { inputBuffer: { getChannelData: () => d } };
}

const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  const r = reporter("dictation checker");

  /* ---------------- the voice gate ---------------- */
  {
    const { voiceGate } = SANDBOX({}, "fil-PH", "chirp_2", {}, {}, async () => { });

    const quiet = voiceGate();
    for (let i = 0; i < 4; i++) quiet.test(0.004, 160); // a quiet room, 640ms
    r.check("a quiet room gets the floor, not a hair-trigger",
      quiet.threshold() >= 0.012 && quiet.threshold() <= 0.05, `threshold ${quiet.threshold()}`);

    /* THE FIELD BUG. The therapist starts talking the instant they tap Listen,
       so every frame of the calibration window is their voice. Taking that as
       room tone puts the bar above their speech — and then their words are
       neither transcribed nor billed, and the idle stop hangs up on them while
       they are still dictating. */
    const talkedOver = voiceGate();
    for (let i = 0; i < 6; i++) talkedOver.test(0.045, 160); // ~1s of speech
    r.check("calibrating through speech never raises the bar above speech",
      talkedOver.threshold() <= 0.02, `threshold ${talkedOver.threshold()}`);
    r.check("…so ordinary speech still registers as speech",
      talkedOver.test(0.03, FRAME_MS) === true);

    /* The bar has to move BOTH ways. The old estimator only ever sampled
       frames it had already called silence, so it could ratchet down and never
       back up — which made the 500ms calibration window the single moment the
       gate could ever learn that a room was loud. Talk through that window in
       a clinic with a fan and the bar stayed at the floor for the whole visit:
       room tone billed as speech, and — because nothing was ever "not voiced"
       — the idle backstop could never fire either. */
    const fanRoom = voiceGate();
    for (let i = 0; i < 6; i++) fanRoom.test(0.06, 90);  // talked through calibration
    const fromCalibration = fanRoom.threshold();
    for (let i = 0; i < 120; i++) fanRoom.test(0.02, 85); // ~10s of the fan, nobody talking
    r.check("the bar rises to meet a room it was never calibrated for",
      fanRoom.threshold() > fromCalibration, `stuck at ${fanRoom.threshold()}`);
    r.check("…and the fan then reads as the room, not as speech",
      fanRoom.test(0.02, 85) === false, `threshold ${fanRoom.threshold()}`);
    r.check("…while the therapist's voice still clears it",
      fanRoom.test(0.05, 85) === true, `threshold ${fanRoom.threshold()}`);

    /* The cap is the promise that the gate never sits on top of speech. */
    const shouty = voiceGate();
    for (let i = 0; i < 200; i++) shouty.test(0.09, 85);
    r.check("no room, however loud, pushes the bar above ordinary speech",
      shouty.threshold() <= 0.03, `threshold ${shouty.threshold()}`);
  }

  /* ---------------- the idle backstop ---------------- */
  {
    const a = fakeAudio();
    const { cloudEngine } = SANDBOX({ "fil-PH": "fil-PH" }, "fil-PH", "chirp_2", a.win, a.nav, a.fetchStub);
    const stops = [];
    const eng = cloudEngine({
      docId: "d1", lang: () => "fil-PH",
      onText: () => { }, onInterim: () => { }, onStatus: () => { },
      onAutoStop: (msg) => stops.push(msg),
      onBilled: () => { }, billedSoFar: 0, ceilingSeconds: 0,
    });
    await eng.start();
    const node = a.state.nodes[0];

    for (let i = 0; i < 8; i++) node.onaudioprocess(frame(0.08)); // someone talking
    for (let i = 0; i < 4; i++) node.onaudioprocess(frame(0.002)); // …then a natural pause
    await settle();
    r.check("speech is sent to the server", a.state.posted > 0, `posted ${a.state.posted}`);

    const postedBefore = a.state.posted;
    for (let i = 0; i < 800; i++) if (node.onaudioprocess) node.onaudioprocess(frame(0.002));
    await settle();

    r.check("a mic left on in silence eventually stops itself", stops.length >= 1);
    /* It must fire ONCE. The condition stayed true forever, so before the fix
       this re-fired on every 256ms frame for as long as the room was quiet. */
    r.check("…exactly once, not on every frame afterwards", stops.length === 1, `${stops.length} stops`);
    r.check("…and says why, in words the therapist can act on",
      /no speech/i.test(stops[0] || "") && /listen/i.test(stops[0] || ""), stops[0]);

    /* The part that was actually costing money: "stopped" has to mean the OS
       microphone is handed back, not merely that a label changed. */
    r.check("the microphone is released", a.state.streams.every((s) => s.tracks.every((t) => t.stopped)));
    r.check("the audio context is closed", a.state.contexts.every((c) => c.state === "closed"));
    r.check("the processor is disconnected", node.disconnected === true);

    if (node.onaudioprocess) {
      for (let i = 0; i < 8; i++) node.onaudioprocess(frame(0.08));
      await settle();
    }
    r.check("nothing is billed after an auto-stop", a.state.posted === postedBefore,
      `${a.state.posted - postedBefore} extra segments`);
  }

  /* ---------------- talking must never trip the idle stop ---------------- */
  {
    const a = fakeAudio();
    const { cloudEngine } = SANDBOX({ "fil-PH": "fil-PH" }, "fil-PH", "chirp_2", a.win, a.nav, a.fetchStub);
    const stops = [];
    const eng = cloudEngine({
      docId: "d2", lang: () => "fil-PH",
      onText: () => { }, onInterim: () => { }, onStatus: () => { },
      onAutoStop: (m) => stops.push(m), onBilled: () => { }, billedSoFar: 0, ceilingSeconds: 0,
    });
    await eng.start();
    const node = a.state.nodes[0];
    /* A loud room: the gate climbs, as it is supposed to. What must NOT happen
       is the raised bar deciding that audible speech is silence and hanging up
       — for a full ten minutes of continuous dictation. */
    for (let i = 0; i < 6; i++) node.onaudioprocess(frame(0.045));
    for (let i = 0; i < 2400; i++) if (node.onaudioprocess) node.onaudioprocess(frame(0.032));
    await settle();
    r.check("ten minutes of continuous speech never trips the idle stop",
      stops.length === 0, `stopped: ${stops[0] || ""}`);
    eng.stop();
  }

  /* ---------------- a gate that fails open must still hang up ---------------- */
  {
    const a = fakeAudio();
    const { cloudEngine } = SANDBOX({ "fil-PH": "fil-PH" }, "fil-PH", "chirp_2", a.win, a.nav, a.fetchStub);
    const stops = [];
    const eng = cloudEngine({
      docId: "d5", lang: () => "fil-PH",
      onText: () => { }, onInterim: () => { }, onStatus: () => { },
      onAutoStop: (m) => stops.push(m), onBilled: () => { }, billedSoFar: 0, ceilingSeconds: 0,
    });
    await eng.start();
    const node = a.state.nodes[0];
    /* An empty room with a fan running, loud enough to clear the fixed floor,
       and a therapist who talked over calibration so the bar never rose. This
       is the runaway the idle stop exists for, and it was the one case where
       the idle stop could not fire: every frame counted as speech, so the
       timer never advanced and the mic billed until somebody noticed. */
    for (let i = 0; i < 6; i++) node.onaudioprocess(frame(0.07)); // talked-over calibration
    for (let i = 0; i < 1000; i++) if (node.onaudioprocess) node.onaudioprocess(frame(0.02));
    await settle();
    r.check("a mic left running in a noisy empty room still stops itself",
      stops.length === 1, `${stops.length} stops`);
    r.check("…and hands the microphone back",
      a.state.streams.every((s) => s.tracks.every((t) => t.stopped)));
  }

  /* ---------------- restarting ---------------- */
  {
    const a = fakeAudio();
    const { cloudEngine } = SANDBOX({ "fil-PH": "fil-PH" }, "fil-PH", "chirp_2", a.win, a.nav, a.fetchStub);
    const eng = cloudEngine({
      docId: "d3", lang: () => "fil-PH",
      onText: () => { }, onInterim: () => { }, onStatus: () => { },
      onAutoStop: () => { }, onBilled: () => { }, billedSoFar: 0, ceilingSeconds: 0,
    });
    await eng.start();
    const first = a.state.nodes[0];
    await eng.start(); // the therapist taps Listen again after an auto-stop
    r.check("a second start doesn't leave the first graph running", first.disconnected === true);
    r.check("…and hands the first microphone back",
      a.state.streams[0].tracks.every((t) => t.stopped));
    r.check("…leaving exactly one live processor",
      a.state.nodes.filter((n) => !n.disconnected).length === 1);
    eng.stop();
  }

  /* ---------------- the per-visit ceiling ---------------- */
  {
    const a = fakeAudio();
    const { cloudEngine } = SANDBOX({ "fil-PH": "fil-PH" }, "fil-PH", "chirp_2", a.win, a.nav, a.fetchStub);
    const stops = [];
    const eng = cloudEngine({
      docId: "d4", lang: () => "fil-PH",
      onText: () => { }, onInterim: () => { }, onStatus: () => { },
      onAutoStop: (m) => stops.push(m), onBilled: () => { },
      /* Already 119s billed on this visit against a 2-minute ceiling: a second
         run must not walk around what the first one spent. */
      billedSoFar: 119, ceilingSeconds: 120,
    });
    await eng.start();
    const node = a.state.nodes[0];
    for (let i = 0; i < 8; i++) node.onaudioprocess(frame(0.08));
    for (let i = 0; i < 4; i++) node.onaudioprocess(frame(0.002)); // the pause that files the segment
    await settle(); await settle();
    r.check("the per-visit ceiling counts what earlier runs already spent", stops.length === 1,
      `${stops.length} stops`);
    r.check("…and releases the microphone too",
      a.state.streams.every((s) => s.tracks.every((t) => t.stopped)));
  }

  /* ---- the on-screen meter ----
     Per-visit dictation spend is the one number a therapist needs mid-visit,
     and a ticking mm:ss is the one presentation that makes them rush. These
     pin both halves: it counts, and it counts in whole minutes only. */
  {
    const METER = new Function("document",
      [lift("  function showDictMeter("), lift("  function hideDictMeter(")].join("\n")
      + "\n  let meterMinute = -1;"
      + "\n  return { showDictMeter, hideDictMeter, minute: () => meterMinute };");

    const el = { hidden: true, innerHTML: "" };
    const doc = { getElementById: (id) => (id === "dictMeter" ? el : null) };
    // the lifted functions close over their own `meterMinute`, so re-lift per case
    const m = METER(doc);

    m.showDictMeter(0, 1800);
    r.check("meter appears when capturing starts", el.hidden === false);
    r.check("under a minute reads as words, not 0:00",
      /under a minute/i.test(el.innerHTML) && !/\d+:\d\d/.test(el.innerHTML), el.innerHTML);

    m.showDictMeter(59, 1800);
    r.check("no redraw inside the same minute", /under a minute/i.test(el.innerHTML), el.innerHTML);

    m.showDictMeter(61, 1800);
    r.check("the first minute is reported", /\b1 min\b/.test(el.innerHTML), el.innerHTML);
    r.check("…against the visit's allowance", /30/.test(el.innerHTML), el.innerHTML);
    r.check("…and never as a clock", !/\d+:\d\d/.test(el.innerHTML), el.innerHTML);

    m.showDictMeter(119, 1800);
    r.check("still one minute at 1:59", /\b1 min\b/.test(el.innerHTML), el.innerHTML);
    m.showDictMeter(120, 1800);
    r.check("two minutes at 2:00", /\b2 min\b/.test(el.innerHTML), el.innerHTML);

    m.hideDictMeter();
    r.check("the meter leaves with the microphone", el.hidden === true && el.innerHTML === "");
  }

  /* The meter must never be rendered onto a draft note the way the billed
     total used to be — that is the timer we deliberately took out. */
  {
    const line = lift("  function dictationLine(");
    r.check("billed time on a note is gated on the note being signed",
      /doc\.status !== "signed"/.test(line), line.slice(0, 200));
    const bar = SRC.slice(SRC.indexOf('<div class="dict-bar">'), SRC.indexOf('<div class="dict-bar">') + 1200);
    r.check("the dict bar carries a meter element", /id="dictMeter"/.test(bar));
    r.check("the recorder no longer paints a running clock",
      !/Recording — \$\{mmss/.test(SRC));
  }

  /* ---- a chunk that fails must leave a visible hole ---- *
     Record-then-process splits the dictation into ~50-second chunks and sends
     them in parallel. When one failed, the survivors were joined with a space:
     the sentence before a lost fifty seconds was spliced onto the sentence
     after it, and the record carried a continuous statement nobody made. The
     therapist was told to "review carefully" — and in the same breath the
     recording was cleared, so there was nothing left to review it against. */
  {
    /* processRecording delegates one chunk to transcribeChunk, so the sandbox
       needs both. Lifting them together keeps the test running the real
       request-building code rather than a stand-in for it. */
    const src = lift("  async function transcribeChunk(") + "\n" + lift("  async function processRecording(");
    const mark = /const AUDIO_GAP_MARK = "([^"]+)";/.exec(SRC);
    r.check("app.js still declares a gap marker", !!mark);
    const GAP = mark ? mark[1] : "";

    // a fetch that fails whichever chunk indices it is told to
    const fetchWith = (failing) => {
      let n = -1;
      return async (url, init) => {
        n += 1;
        const i = Number(new URL(url, "http://x").searchParams.get("docId").split(":")[1]);
        if (failing.includes(i)) {
          return { ok: false, status: 503, json: async () => ({ error: "upstream unavailable", billedSeconds: 3 }) };
        }
        return { ok: true, status: 200, json: async () => ({ text: `chunk${i}.`, billedSeconds: 3 }) };
      };
    };
    /* docId carries the chunk index so the stub can fail a chosen one; the
       real call sends the same docId on every chunk. */
    const runWith = async (count, failing) => {
      const chunks = Array.from({ length: count }, (_, i) => ({ pcm: new Float32Array(8), rate: 16000, i }));
      const sandbox = new Function("STT_LANG", "STT_LANG_DEFAULT", "STT_MODEL", "window", "fetch", "encodeWav",
        `const AUDIO_GAP_MARK = ${JSON.stringify(GAP)};\n` + src + "\n  return processRecording;");
      let i = -1;
      const perChunkFetch = fetchWith(failing);
      const f = async (url, init) => { i += 1; return perChunkFetch(url.replace("docId=d", `docId=d:${i}`), init); };
      const fn = sandbox({ fil: "fil-PH" }, "fil-PH", "chirp2", {}, f, () => new ArrayBuffer(8));
      return fn("d", "fil", chunks, () => {});
    };

    const clean = await runWith(3, []);
    r.check("every chunk transcribing gives a clean transcript",
      clean.text === "chunk0. chunk1. chunk2." && clean.errors.length === 0, JSON.stringify(clean.text));

    /* The live pass hands its results in as `prior`. A chunk it already
       answered must not reach fetch a second time — same audio, second bill. */
    {
      const chunks = Array.from({ length: 3 }, (_, i) => ({ pcm: new Float32Array(8), rate: 16000, i }));
      const sandbox = new Function("STT_LANG", "STT_LANG_DEFAULT", "STT_MODEL", "window", "fetch", "encodeWav",
        `const AUDIO_GAP_MARK = ${JSON.stringify(GAP)};\n` + src + "\n  return processRecording;");
      let calls = 0;
      const f = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ text: "late.", billedSeconds: 3 }) }; };
      const fn = sandbox({ fil: "fil-PH" }, "fil-PH", "chirp2", {}, f, () => new ArrayBuffer(8));
      const out = await fn("d", "fil", chunks, () => {},
        [{ text: "live0.", billedSeconds: 4 }, { text: "live1.", billedSeconds: 4 }]);
      r.check("chunks the live pass already transcribed are not sent again",
        calls === 1, `${calls} request(s) for 3 chunks, 2 of them already done`);
      r.check("…and their text and billed seconds still reach the result",
        out.text === "live0. live1. late." && out.billedSeconds === 11,
        JSON.stringify({ text: out.text, billed: out.billedSeconds }));
      r.check("…and `parts` reports per chunk, so the caller can skip what it wrote",
        JSON.stringify(out.parts) === JSON.stringify(["live0.", "live1.", "late."]),
        JSON.stringify(out.parts));
    }

    const holed = await runWith(3, [1]);
    r.check("a failed middle chunk leaves a marker where it was",
      holed.text === `chunk0. ${GAP} chunk2.`, JSON.stringify(holed.text));
    r.check("…and the failure is still reported", holed.errors.length === 1, JSON.stringify(holed.errors));
    r.check("…so the two surviving sentences are never spliced together",
      !/chunk0\. chunk2\./.test(holed.text), JSON.stringify(holed.text));

    const run2 = await runWith(4, [1, 2]);
    r.check("consecutive failures are one hole, not one marker each",
      run2.text === `chunk0. ${GAP} chunk3.`, JSON.stringify(run2.text));

    const allBad = await runWith(2, [0, 1]);
    r.check("a transcript of nothing but markers is no transcript at all",
      allBad.text === "", JSON.stringify(allBad.text));
    r.check("…and a failed chunk is still billed for", allBad.billedSeconds === 6, String(allBad.billedSeconds));

    // the audio has to survive a PARTIAL failure — that is the case where the
    // therapist most needs to hear what the chunk actually said
    r.check("a partial failure keeps the recording for a retry",
      /if \(!out\.errors\.length\) \{\s*captured = null;\s*await savedAudio\.clear/.test(SRC),
      "the Process handler no longer gates clearing the audio on a clean run");
    r.check("…and the message says the recording is still there",
      /chunk\(s\) failed\.[^`]*recording is still here/.test(SRC));
  }

  /* ---------------- the microphone we ask for ----------------

     Automatic gain control is the browser default, and in a busy clinic it is
     the setting that puts the next plinth's conversation into this patient's
     note: it raises the mic whenever the room goes quiet, which is exactly
     when the only thing left to amplify is somebody else. It also rescales the
     signal voiceGate() is measuring, underneath the gate, on its own
     schedule. */
  {
    const { micConstraints } = SANDBOX({}, "fil-PH", "chirp_2", {}, {}, async () => { });
    const c = micConstraints();
    r.check("automatic gain control is off",
      c.autoGainControl === false,
      "AGC amplifies the room in every pause, and moves the level the voice gate measures");
    r.check("echo cancellation and noise suppression stay on",
      c.echoCancellation === true && c.noiseSuppression === true,
      "both are narrow-band; neither rescales speech the way AGC does");
    r.check("the mic is asked for one channel", c.channelCount === 1);

    /* The engines must actually USE it. This is not a style check: the
       constraints once lived inline in each engine, and the lifted sandbox
       swallowed a reference error in the getUserMedia try/catch and reported
       it as "Mic blocked" — a whole suite passing against an engine that
       never started. */
    r.check("both engines open the mic through it",
      (SRC.match(/getUserMedia\(\{ audio: micConstraints\(\) \}\)/g) || []).length === 2,
      "an engine with its own inline constraints is one that silently keeps AGC");
    r.check("a microphone that won't open is logged, not just reported",
      /console\.error\("\[dictation\] microphone unavailable:"/.test(SRC)
        && /console\.error\("\[recorder\] microphone unavailable:"/.test(SRC),
      "the catch is broad enough to swallow a coding error — it must not be the last anyone hears of one");
  }

  /* ---------------- aiming the microphone at a section ----------------

     The field test's biggest ask: dictate INTO Subjective rather than into
     one long recording that the app then sorts. What makes it work is that a
     stated target beats anything the classifier can infer — so these check
     the target is honoured, and that there is still only ever one mic. */
  {
    r.check("every note type declares which sections can be dictated into",
      /const DICTATABLE = \{/.test(SRC)
        && /eval: \[/.test(SRC) && /daily: \[/.test(SRC)
        && /progress: \[/.test(SRC) && /discharge: \[/.test(SRC),
      "a type missing from the map silently loses its section microphones");

    r.check("an aimed utterance skips the classifier entirely",
      /const field = aimed \? aimedField\(doc\.type, clinical, aimed\) : fieldForSentence\(/.test(SRC),
      "feeding the target to the classifier as a hint is exactly what this replaces");

    r.check("only a section this note type actually has can be aimed at",
      /const aimed = target && isDictatable\(doc\.type, target\) \? target : null;/.test(SRC),
      "a stale target from another note type would file text into a field that isn't on the page");

    r.check("a value that reached a table is not also written into the prose",
      /function aimedField\([\s\S]*?extractOutcomes\(sentence\)\.length\) return null;[\s\S]*?meas\.rom\.length \+ meas\.mmt\.length \+ meas\.special\.length\) return null;/.test(SRC),
      "the same finding in the table and in the narrative is the same finding twice, free to disagree");

    r.check("pressing a second section re-aims one mic instead of opening another",
      /\} else if \(listening\) \{\s*\/\/ already open: just re-aim it\s*aimedAt = target;/.test(SRC),
      "two live audio graphs on one device is the doubled-audio bug release() exists to prevent");

    r.check("pressing the lit button again stops the mic",
      /if \(listening && aimedAt === target\) \{\s*\/\/ same button again: stop\s*listening = false;\s*engine\.stop\(\);/.test(SRC));

    r.check("a failed start leaves nothing aimed",
      /if \(ok === false\) \{ listening = false; aimedAt = null; \}/.test(SRC),
      "an aim left set on a closed mic sends the next utterance somewhere nobody chose");

    r.check("stopping dictation from outside clears the aim too",
      /stop\(\) \{ if \(engine\) engine\.stop\(\); listening = false; aimedAt = null; \}/.test(SRC));

    /* Where the mic is pointed has to ride ON the engine's status line: the
       cloud engine rewrites that line every time a segment goes out, so
       anything written beside it survives about a second. */
    r.check("where the mic is filing rides on the engine's own status line",
      /onStatus: \(msg, isListening\) => \{ statusEl\.textContent = withAim\(msg\);/.test(SRC),
      "written separately it is overwritten by the next segment, and a therapist dictates into the wrong section");

    r.check("the whole-visit button reads as off while a section is aimed",
      /micBtn\.classList\.toggle\("listening", listening && !aimedAt\);/.test(SRC),
      "two mic buttons both lit is two microphones as far as the therapist can tell");
  }

  /* ---------------- corrections are visible ---------------- */
  {
    r.check("recogniser output is repaired before it becomes the transcript",
      /const fixed = PR\.correctDictation\(raw\);/.test(SRC)
        && /const repaired = PR\.correctDictation\(out\.text\);/.test(SRC),
      "live dictation and record-then-process must arrive at the same transcript");
    r.check("typed dictation is NOT put through the corrector",
      !/correctDictation\(text\)/.test(SRC),
      "a therapist who typed MPT typed what they meant");
    r.check("a correction says which word it changed",
      /function noteDictationFixes\(/.test(SRC) && /id="dictFixes"/.test(SRC),
      "a correction nobody can see is one nobody can disagree with");
  }

  /* ---------------- recording is the default, live is a choice ----------------

     The order on screen is the argument, so it is worth a test: the live pass
     files each sentence as it hears it and cannot take one back, while
     recording and reading the visit once has no such failure mode. If a later
     edit quietly promotes live dictation back to the top, the product goes
     back to making the mistake the whole record-first flow removed. */
  {
    const recAt = SRC.indexOf('<div class="rec-primary">');
    const liveAt = SRC.indexOf('<details class="live-dict">');
    r.check("the recorder is offered before live dictation",
      recAt > 0 && liveAt > 0 && recAt < liveAt,
      `rec-primary at ${recAt}, live-dict at ${liveAt}`);

    r.check("live dictation is collapsed until the therapist opens it",
      liveAt > 0 && !/<details class="live-dict" open/.test(SRC),
      "an open disclosure is not opt-in");

    r.check("…and says why it is the second choice",
      /files each sentence as you say it, so anything the patient corrects later/.test(SRC),
      "a demoted feature with no reason given reads as an arbitrary rearrangement");

    /* The recorder reads langSel.value when it processes. Burying it inside
       the live-dictation disclosure would hide the one setting that decides
       whether a Bisaya visit transcribes correctly — and NOTES.md already
       records that a tablet left on the wrong pairing degrades every
       utterance with nothing on screen to say so. */
    const primary = SRC.slice(recAt, liveAt);
    r.check("the language pairing stays with the recorder, not inside the disclosure",
      /id="langSel"/.test(primary),
      "processRecording() reads langSel.value — it cannot be hidden behind a closed <details>");

    r.check("a corrected mis-transcription is visible whether or not live is open",
      /id="dictFixes"/.test(primary),
      "record-then-process reports its fixes through the same chip");

    /* The read-only branch is a separate copy of this markup, and
       startDictation() is never called for it — but the page still renders
       these ids, so a missing one is a silent null on a signed note. */
    const readOnly = SRC.slice(SRC.indexOf('<span class="dict-status" id="dictStatus">Locked</span>') - 900,
                               SRC.indexOf('<span class="dict-status" id="dictStatus">Locked</span>') + 400);
    for (const id of ["micBtn", "langSel", "dictStatus", "dictMeter", "dictFixes"]) {
      r.check(`a signed note still renders #${id}`, readOnly.includes(`id="${id}"`),
        "the locked branch is a second copy of this markup and drifts silently");
    }
  }

  /* ---------------- the recording stage ---------------- */
  {
    /* `btn.addEventListener("click"` occurs earlier in app.js than the stage
       does, so it cannot be the closing bound — indexOf would run backwards
       and hand every check below an empty string that quietly passes nothing. */
    const stageStart = SRC.indexOf("const stage = document.getElementById(\"recStage\")");
    const stage = SRC.slice(stageStart,
      SRC.indexOf("if (dockBack) dockBack.addEventListener(\"click\", enterStage);", stageStart));
    r.check("the stage block was actually found in app.js", stage.length > 400 && stage.length < 6000,
      `sliced ${stage.length} chars — the checks below are meaningless if this is empty or unbounded`);

    r.check("the recorder controls are MOVED to the stage, never copied",
      /slot\.appendChild\(bar\)/.test(stage)
        && !/recStageSlot"\)\.innerHTML\s*=/.test(SRC) && !/recDockSlot"\)\.innerHTML\s*=/.test(SRC),
      "a second record button with its own listeners is two microphones as far as the therapist can tell");

    r.check("the stage re-parents to <body> before it is shown",
      /document\.body\.appendChild\(stage\)/.test(stage),
      "an ancestor inside the page forms a stacking context, and the fixed sidebar paints over a 'full screen' recorder that stays inside it");

    /* The property that matters clinically, restated.

       This used to be "there is no way off the stage while the mic is open",
       enforced by hiding the Back button. That made a therapist who wanted to
       type during the visit choose between typing and recording, so leaving
       the stage is now allowed — and the guarantee had to move rather than go.

       What must remain true is that a RUNNING RECORDER IS NEVER INVISIBLE.
       Leaving the stage with the mic open docks it: the same #recBar, the same
       Stop button, pinned to the viewport. The failure being prevented is a
       hot microphone nobody can see, and one control in view is what prevents
       it — not the absence of a door. */
    r.check("leaving the stage while the mic is open docks it rather than hiding it",
      /stageBack\.addEventListener\("click", \(\) => \(recording \? dockStage\(\) : exitStage\(\)\)\)/.test(stage),
      "walking away from a running recorder with no control on screen is the one thing this flow must not allow");

    r.check("the dock holds the real recorder, not a second copy of it",
      /moveControls\("recDockSlot", "recDockMeters"\)/.test(stage)
        && /dock\.hidden = false/.test(stage),
      "two record buttons that disagree about whether the mic is open is the failure the stage exists to prevent");

    /* Sliced per function rather than matched within a character window: the
       comments inside these bodies are long and a distance-based regex breaks
       the next time one of them grows a paragraph. */
    const fnBody = (name, end) => stage.slice(stage.indexOf(`const ${name} = `),
      stage.indexOf(end, stage.indexOf(`const ${name} = `)));
    const enterBody = fnBody("enterStage", "const dockStage");
    const dockBody = fnBody("dockStage", "// the mic is off");
    r.check("the dock and the stage are never both up",
      /stage\.hidden = true/.test(dockBody) && /dock\.hidden = true/.test(enterBody),
      "two visible recorders is the same confusion as two record buttons");

    r.check("docking releases the scroll lock the stage takes",
      /dockStage[\s\S]{0,400}classList\.remove\("recording-stage"\)/.test(stage),
      "body.recording-stage sets overflow:hidden — leave it on and the therapist cannot scroll to the section they docked in order to type into");

    r.check("…and it is only entered once the microphone is genuinely open",
      /const ok = await rec\.start\(\);[\s\S]{0,600}enterStage\(\);/.test(SRC),
      "entering before start() means a full-screen recorder over a mic that was refused");

    r.check("leaving the stage puts every element back where it was",
      /parent\.insertBefore\(el, next\)/.test(stage) && !/exitStage = \(\) => \{[\s\S]{0,300}appendChild/.test(stage),
      "appending to the old parent silently reorders the dictation toolbar");

    /* The dock's own consequence. While the stage covered the screen a
       therapist could not reach the sidebar, so navigating away mid-recording
       was unreachable rather than handled. It is reachable now. */
    r.check("navigating away stops the recorder instead of leaving it running",
      /if \(activeRecording\) \{ activeRecording\.stop\(\); activeRecording = null; \}/.test(SRC)
        && /activeRecording = \{\s*\n\s*isRecording: \(\) => recording,\s*\n\s*stop\(\)/.test(SRC),
      "the dock lets a therapist leave the document with the mic open, which the stage never did");

    r.check("…and stops a SECTION recording too, which activeRecording does not hold",
      /if \(sectionRec\) \{ try \{ sectionRec\.engine\.stop\(\); \} catch \(_\) \{ \} sectionRec = null; \}/.test(SRC),
      "it has its own engine, and letting its stop path run would raise a processing screen over a document the router already replaced");

    r.check("stopping on the way out keeps the audio",
      /activeRecording = \{[\s\S]{0,400}rec && rec\.stop\(\)/.test(SRC),
      "chunks are flushed to IndexedDB as they are captured, so the visit is offered back rather than lost");

    /* The property is unchanged; what enforces it moved. Processing now has a
       screen of its own, so the recorder overlay comes down before that screen
       goes up, and that screen comes down before the review opens. Neither
       overlay may ever be under the review. */
    r.check("the recorder overlay is down before the processing screen goes up",
      /exitStage\(\);\s*\n\s*procStage\.show\(\);/.test(SRC),
      "two full-screen overlays share one scroll lock — whichever released it last would win");

    r.check("the review opens over the note, not over the processing screen",
      /procStage\.hide\(\);\s*\n\s*openReviewModal/.test(SRC),
      "reading a review over a full-screen overlay hides the document it is filling in");

    /* A screen that cannot end on a failure is a screen that looks hung. The
       recording is still on the device at this point, which is the one thing
       the therapist needs told. */
    r.check("a failed transcription ends the processing screen instead of spinning",
      /procStage\.fail\("transcribe", why\);/.test(SRC)
        && /still on this device — press Process again to retry/.test(SRC),
      "a spinner over a step that is never coming back reads as a hang, not as the error it is");

    r.check("every exit from the whole-visit read takes the screen down",
      !/procStage\.set\("read", "active"[\s\S]{0,2000}closeModal\(\);\s*\n\s*return refineFailed/.test(SRC)
        && (SRC.match(/procStage\.hide\(\);/g) || []).length >= 4,
      "a failed or unavailable AI must not leave a processing overlay over the note");

    r.check("discarding a recording leaves the stage",
      /meta\.textContent = "Recording discarded\.";\s*\n\s*exitStage\(\);/.test(SRC));
  }

  /* ---------------- recording into one section ----------------

     A section mic RECORDS; it does not file as you speak. Same arc as the
     visit recorder — record, stop, transcribe, let the AI write it, approve —
     so a therapist meets one workflow rather than two, and the property that
     makes record-first worth having holds at section scale too: nothing
     reaches the note that the clinician did not put there. */
  {
    r.check("a section mic records rather than opening the live engine",
      /sectionBtns\(\)\.forEach\(\(b\) => b\.addEventListener\("click", async \(\) => \{[\s\S]{0,700}startSectionRecording\(doc, user, field\)/.test(SRC),
      "filing as you speak is the failure record-first exists to remove; a section is not exempt from it");

    r.check("section audio is keyed apart from the visit's",
      /const key = `\$\{doc\.id\}#\$\{field\}`/.test(SRC),
      "savedAudio matches on docId exactly, so a shared key would offer a section burst back as the whole visit");

    /* One microphone on the device. Three ways two could be opened at once,
       and each is refused rather than left to produce two audio graphs. */
    r.check("a section mic will not open over a running visit recording",
      /activeRecording\.isRecording\(\)\) \{[\s\S]{0,200}The whole visit is being recorded/.test(SRC),
      "two recorders on one device is the doubled-audio bug the engine's release() exists to prevent");

    r.check("…nor over live dictation, which is closed first",
      /if \(listening\) \{ await aimMic\(null\); \}/.test(SRC));

    r.check("…nor over another section that is already recording",
      /if \(sectionRecordingActive\(\)\) return;/.test(SRC)
        && /b\.disabled = !!sectionRec && !on;/.test(SRC),
      "a second button that still looks pressable is a therapist dictating into a section that is not listening");

    /* engine.stop() does NOT call onStop — that callback is for the engine's
       own limit and ceiling stops. Wiring the button straight to the engine
       shut the microphone with nothing left to carry the chunks onward, and
       the panel sat on "Stopping…" forever. */
    r.check("the Stop button goes through stopSectionRecording, not the engine",
      /if \(sectionRec && sectionRec\.field === field\) \{\s*\n\s*stopSectionRecording\(sectionRec\.doc, sectionRec\.user, field\);/.test(SRC),
      "engine.stop() only shuts the microphone; it does not fire onStop, so nothing would process the burst");

    r.check("the Stop control is on screen for as long as the mic is open",
      /data-recstop="\$\{esc\(field\)\}"/.test(SRC)
        && /Recording into <b>\$\{esc\(label\)\}<\/b> — nothing is written until you stop/.test(SRC),
      "a hot microphone with no visible control is the one thing this flow must never allow");

    r.check("it shows the same processing screen the visit recorder does",
      /stopSectionRecording[\s\S]{0,900}procStage\.show\(label\);[\s\S]{0,400}procStage\.set\("transcribe", "active"/.test(SRC),
      "a therapist should not have to learn two answers to 'is it working, and how much longer'");

    /* …retitled for the section, and reset when the visit recorder next uses
       it. A screen left saying "Writing Subjective" over a whole-visit read is
       a worse lie than the generic wording it replaced. */
    r.check("the screen is retitled per run and resets to the visit wording",
      /put\("#procScope", scope \? "Processing this section" : "Processing this visit"\);/.test(SRC)
        && /put\('\[data-title="read"\]', scope \? `Writing \$\{scope\}` : null\);/.test(SRC)
        && /data-title="read" data-default="Reading the whole visit"/.test(SRC),
      "a section run must not leave its wording standing on the next visit's screen");

    /* Billing, then the two ways this can fail. Both keep what was said. */
    r.check("speech is billed as soon as it comes back, before anything can throw",
      /out = await processRecording\(key[\s\S]{0,400}recordDictationSeconds\(doc\.id, out\.billedSeconds, user\);/.test(SRC),
      "the same rule the visit recorder follows — a crash further down must not lose what was already billed");

    r.check("the transcript is kept whichever way the AI goes",
      /captureUtterances\(live, user, repaired\.text, currentDocState\);[\s\S]{0,400}procStage\.set\("read", "active"/.test(SRC),
      "a therapist whose section draft fails should still be able to read their own words");

    r.check("a failed write says so instead of silently dropping the visit",
      /procStage\.fail\("read", `Couldn't write \$\{label\} from that recording\. What you said is in the transcript\.`\)/.test(SRC));

    /* The property the whole flow exists for. */
    r.check("the note is not touched until the therapist presses something",
      /Nothing changes in \$\{esc\(label\)\} until you press one of these\./.test(SRC)
        && /data-checkuse="replace"/.test(SRC),
      "a section that rewrote itself when the recording stopped is the live-dictation mistake one layer up");

    r.check("a section that already has text offers replace, append or keep",
      /data-checkuse="append"/.test(SRC) && /Keep mine<\/button>/.test(SRC),
      "the therapist may have typed into it while the recording ran");

    r.check("…and marks what is new against what is already there",
      /const parts = current \? overlapSentences\(current, drafted\) : \[\];/.test(SRC),
      "same question as the whole-visit review, so it is answered the same way by the same function");

    r.check("accepting a draft leaves the section machine-written",
      /markAiFilled\(doc, field, true\);/.test(SRC),
      "marking it by hand would stop the whole-visit review from ever pre-ticking it");

    r.check("a recording with nothing clinical in it says so and keeps the transcript",
      /Nothing in that recording belonged in \$\{esc\(label\)\}\. What you said is in the transcript\./.test(SRC),
      "a therapist who believes their words vanished will simply say them again");
  }

  /* ---------------- provisional pins ----------------

     The map shows what the parser hears while the visit records, so a
     therapist at a screen that never moves can tell a working microphone from
     a dead one. Measured against the eval transcripts the parser and the AI
     agree on the map for 78% of visits; on the rest the parser both over-pins
     (six regions where the AI keeps two) and under-pins (none where the AI
     finds both knees). So these marks must read as a question. */
  {
    r.check("live pins are flagged provisional, never as findings",
      /if \(pt\) pt\.provisional = true;/.test(SRC),
      "an unconfirmed mark that looks like a finding is worse than no mark");

    r.check("…and are drawn as a different KIND of thing, not just fainter",
      /pt\.provisional \? " provisional" : ""/.test(SRC),
      "a solid marker at reduced opacity still reads as a finding, slightly greyed");

    r.check("every provisional pin says so in the list beside the map",
      /not checked yet<\/span>/.test(SRC) && /map-prov-note/.test(SRC),
      "the chips mark WHICH pins are unconfirmed; the note above says what unconfirmed means");

    /* The line that keeps this honest. Pins are a signal; the note is not
       touched until the visit has been read whole and the therapist ticked. */
    r.check("the live pass writes pins and the transcript, never the note",
      !/addProvisionalPins[\s\S]{0,1800}appendField\(/.test(SRC)
        && !/addProvisionalPins[\s\S]{0,1800}mergeMeasurements\(/.test(SRC),
      "section text and measurements are what the therapist signs — those wait for the whole-visit read");

    r.check("the whole-visit pass replaces every pin, so provisional ones cannot survive it",
      /doc\.data\.mapPoints = kept\.map\(\(r\) => \{/.test(SRC),
      "applyRefinement rebuilds the map from the kept findings, which is what confirms or drops these");

    /* No confirmer, no provisional pins. */
    r.check("the live pass is skipped where no AI will confirm it",
      /if \(\(\(window\.TheraSync \|\| \{\}\)\.refine \|\| "unavailable"\) !== "gemini"\) return;/.test(SRC),
      "dashed pins on a server with no AI promise a confirmation that never comes, and the end-of-visit routing would file every line twice");

    /* Cost. This is the same audio either way — it must be sent once. */
    r.check("a chunk transcribed live is never sent to Google a second time",
      /const already = prior && prior\[i\];\s*\n\s*const r = already \|\| await transcribeChunk\(docId, lang, c\);/.test(SRC),
      "paying twice for one chunk would double the largest line in the cost model");

    r.check("…and its text is not written into the transcript twice either",
      /const fresh = \(out\.parts \|\| \[\]\)\.slice\(capturedThroughChunk\)\.join\(" "\)\.trim\(\);/.test(SRC),
      "capturing the whole text at process time would put the visit in underneath the copy the live pass wrote");

    r.check("handing a chunk over never blocks the recorder",
      /if \(onChunk\) \{ try \{ onChunk\(made, index\); \} catch \(_\) \{ \} \}/.test(SRC),
      "a chunk closes at a pause in the conversation, which is exactly when the next words are arriving");

    r.check("the live pass writes into the CURRENT document, not the captured copy",
      /const live = S\.getDoc\(doc\.id\);\s*\n\s*if \(!live \|\| live\.status === "signed"\) return;/.test(SRC),
      "a sync pull can replace the state during a forty-minute visit");

    r.check("the live pass resets between recordings",
      /liveParts = \[\];\s*\n\s*capturedThroughChunk = 0;/.test(SRC),
      "\"Record more\" makes a fresh chunk list, and a stale index would skip real text or duplicate it");
  }

  /* ---------------- what the AI adds over what the therapist typed ----------

     Typing during the recording is what makes this reachable, so it is checked
     here rather than with the review: a therapist who typed arrives holding two
     accounts of one visit, and the screen has to say which parts differ. */
  {
    const f = liftOverlap();
    const mine = "Right shoulder pain for two weeks. Flexion 120 degrees.";
    const parts = f.overlapSentences(mine,
      "Right shoulder pain for two weeks. Flexion 130 degrees. Denies numbness in the hand.");

    r.check("a sentence the therapist already wrote reads as already written",
      parts[0].seen === true, JSON.stringify(parts[0]));

    /* The case the whole screen exists for. Same words, different number — if
       this reads as a duplicate the therapist skips the one line where the
       recording and their own note disagree. */
    r.check("a changed NUMBER makes an otherwise-identical sentence read as new",
      parts[1].seen === false, JSON.stringify(parts[1]));

    r.check("genuinely new content reads as new",
      parts[2].seen === false, JSON.stringify(parts[2]));

    r.check("with nothing typed, nothing is claimed as already written",
      f.overlapSentences("", "Shoulder flexion 130 degrees.").every((s) => !s.seen),
      "an empty section would otherwise draw a paragraph of grey saying the therapist wrote it");

    r.check("a pain score survives tokenisation whole",
      f.contentWords("pain is 7/10 today").includes("7/10"),
      "split 7/10 apart and a pain score half-matches a seven-week history");

    r.check("the strip is only drawn when there is something on both sides",
      /if \(!r\.proposed \|\| !r\.current\) return "";/.test(SRC),
      "against an empty section every sentence is new, which is a paragraph of green saying nothing");

    r.check("resolving a section edits the box, never the note",
      /const setSectionText = \(i, text, note\) => \{[\s\S]{0,300}sectionRows\[i\]\.proposed = text;/.test(SRC)
        && !/data-sec-mine[\s\S]{0,400}S\.updateDocData/.test(SRC),
      "the row's tick is what applies a section — these three buttons only change what would be applied");

    r.check("\"Use the AI's\" restores the AI's own words, not the last edit",
      /aiOriginal: proposed,/.test(SRC) && /sectionRows\[i\]\.aiOriginal, "using the AI's wording"/.test(SRC),
      "`proposed` is the working copy and every keystroke moves it");
  }

  r.done();
})();
