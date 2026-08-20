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
  [lift("  function voiceGate() {"),
   lift("  function encodeWav("),
   lift("  function cloudEngine(")].join("\n")
  + "\n  return { voiceGate, encodeWav, cloudEngine };"
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
    const src = lift("  async function processRecording(");
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

  r.done();
})();
