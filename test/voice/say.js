/* ElevenLabs → the exact WAV the browser would have posted.

   app.js records at the device rate and calls encodeWav(pcm, rate) to produce
   16 kHz mono 16-bit PCM before anything is POSTed to /api/stt. So that is what
   this module produces, and it produces it the short way: ElevenLabs will
   return `pcm_16000` directly, which is already the sample format the recorder
   ends at. Asking for MP3 and converting back would put a lossy codec between
   the script and the thing under test, and every word error it caused would be
   scored against Chirp 2.

   Audio is cached on disk by content hash. The scripts do not change between
   runs, so a second run of this harness costs nothing at ElevenLabs — only the
   Google side is paid for again. */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const API = "https://api.elevenlabs.io/v1";
const RATE = 16000;                       // what /api/stt is fed, everywhere
const CACHE = path.join(__dirname, "audio");

/* The key, following the pattern .secrets/README.md already sets for Gemini:
   an env var wins, otherwise a one-line file in the git-ignored .secrets dir. */
function readKey() {
  const env = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (env) return env;
  try {
    const k = fs.readFileSync(path.join(__dirname, "..", "..", ".secrets", "elevenlabs-key.txt"), "utf8").trim();
    if (k) return k;
  } catch { /* not there — the caller reports it */ }
  return null;
}

/* ---------- PCM plumbing ---------- */

/** The same 44-byte header app.js writes, so the server sees a familiar file. */
function wavHeader(dataBytes, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);        // PCM fmt chunk size
  h.writeUInt16LE(1, 20);         // format: PCM
  h.writeUInt16LE(1, 22);         // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);  // byte rate
  h.writeUInt16LE(2, 32);         // block align
  h.writeUInt16LE(16, 34);        // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

const toWav = (pcm, rate = RATE) => Buffer.concat([wavHeader(pcm.length, rate), pcm]);

/** `ms` of digital silence, for the gap between two speakers. */
const silence = (ms, rate = RATE) => Buffer.alloc(Math.round((ms / 1000) * rate) * 2);

/* Low-level noise, mixed under everything.

   Not decoration. The voice gate in app.js calibrates its bar from the room's
   own tone and explicitly refuses to trust a window whose quietest frame is
   already speech-loud; a track of pure digital silence is a room that cannot
   exist. Chirp 2 is also measurably different on clean studio audio than on a
   clinic, so a WER measured on silence-floored speech is optimistic. Default
   is a whisper of it — enough to be a room, far below the gate's FLOOR. */
function mixNoise(pcm, rms) {
  if (!rms) return pcm;
  const out = Buffer.from(pcm);
  const amp = rms * 0x7fff;
  for (let i = 0; i + 1 < out.length; i += 2) {
    // triangular dither-ish noise: two uniform draws sum to something less
    // tonal than one, which is what a room sounds like
    const n = ((Math.random() + Math.random()) - 1) * amp;
    const v = Math.max(-32768, Math.min(32767, out.readInt16LE(i) + n));
    out.writeInt16LE(Math.round(v), i);
  }
  return out;
}

/** Scale amplitude — a therapist at arm's length is not a podcast microphone. */
function gain(pcm, g) {
  if (g === 1) return pcm;
  const out = Buffer.from(pcm);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const v = Math.max(-32768, Math.min(32767, out.readInt16LE(i) * g));
    out.writeInt16LE(Math.round(v), i);
  }
  return out;
}

/** Peak level of a PCM buffer, 0-1 — printed so a silent take is obvious. */
function peak(pcm) {
  let m = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) m = Math.max(m, Math.abs(pcm.readInt16LE(i)));
  return m / 0x7fff;
}

/* ---------- the API ---------- */

async function listVoices(key) {
  const r = await fetch(`${API}/voices`, { headers: { "xi-api-key": key } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ElevenLabs /voices failed: ${d.detail ? JSON.stringify(d.detail) : `HTTP ${r.status}`}`);
  return (d.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    labels: v.labels || {},
    description: v.description || "",
  }));
}

/** One line of speech as raw 16 kHz PCM, cached on disk by content hash. */
async function speak({ key, text, voiceId, modelId, settings, take = 0 }) {
  /* `take` is part of the cache key so N independent recordings of the SAME
     line can be held side by side. Without it the harness could only ever hold
     one sample per script, which quietly turned every borderline assertion into
     whatever that one generation happened to produce — see --takes. */
  const sig = crypto.createHash("sha1")
    .update(JSON.stringify({ text, voiceId, modelId, settings, RATE, take }))
    .digest("hex").slice(0, 16);
  const file = path.join(CACHE, `${sig}.pcm`);
  if (fs.existsSync(file)) return { pcm: fs.readFileSync(file), cached: true };

  const r = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_${RATE}`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: settings }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const d = await r.json(); detail = d.detail ? JSON.stringify(d.detail) : detail; } catch { /* not JSON */ }
    /* pcm_16000 is a paid-tier output format. If that is what was refused, say
       so plainly rather than leaving a caller to read a 401 as a bad key. */
    if (r.status === 401 && /output_format|tier|subscription/i.test(detail)) {
      throw new Error(`ElevenLabs refused pcm_16000 for this account: ${detail}\n` +
        `  PCM output needs a paid plan. Everything else here works unchanged if you upgrade,\n` +
        `  or convert MP3 yourself with ffmpeg -i in.mp3 -ar 16000 -ac 1 -c:a pcm_s16le out.wav`);
    }
    throw new Error(`ElevenLabs TTS failed: ${detail}`);
  }
  const pcm = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, pcm);
  return { pcm, cached: false };
}

/* ---------- a whole script, as one recording ---------- */

/* How long one posted chunk may be.

   Google's synchronous recognize refuses audio past 60 seconds, which is why
   recorderEngine in app.js carries a hardCap of 58s and starts looking for a
   pause at ~55s. A harness that ignored that could only ever test snippets: a
   real visit is minutes long, and the path that stitches its chunks back into
   one transcript — the path that leaves a marked hole when a chunk fails — was
   the part no test had ever reached.

   Cut at a TURN GAP, never mid-word, for the same reason app.js does: each
   chunk is transcribed as an independent request, so a word split across a
   boundary is mangled in both halves and the model recovers neither. */
const CHUNK_MAX_SECONDS = 50;

/** Speak every turn and return the recording as one or more WAV chunks, the
    way a real recording arrives: two voices, a beat of room between them, no
    edits, and a cut at a pause whenever it has run long enough.

    Turn gaps matter. The refine pass has to find the speaker boundaries itself
    from a single stitched transcript, so a gap that is realistic is part of the
    test rather than presentation. */
async function speakScript(script, opts) {
  const { key, voices, modelId, settings, gapMs = 500, leadMs = 400, roomRms = 0.004, level = 1, take = 0 } = opts;
  const maxBytes = CHUNK_MAX_SECONDS * RATE * 2;

  const chunks = [];
  let cur = [silence(leadMs)], curBytes = 0;
  let cachedAll = true, totalBytes = 0;

  const close = () => {
    if (!curBytes) return;
    chunks.push(Buffer.concat(cur));
    cur = []; curBytes = 0;
  };

  for (const turn of script.turns) {
    const voiceId = voices[turn.who] || voices.clinician;
    const { pcm, cached } = await speak({ key, text: turn.text, voiceId, modelId, settings, take });
    cachedAll = cachedAll && cached;
    // close BEFORE adding, so the cut lands in the gap that precedes this turn
    if (curBytes && curBytes + pcm.length > maxBytes) close();
    cur.push(pcm, silence(gapMs));
    curBytes += pcm.length + silence(gapMs).length;
    totalBytes += pcm.length + silence(gapMs).length;
  }
  close();

  const wavs = chunks.map((c) => toWav(mixNoise(gain(c, level), roomRms)));
  return {
    wavs,
    seconds: totalBytes / 2 / RATE,
    peak: Math.max(...chunks.map((c) => peak(c))),
    cached: cachedAll,
  };
}

module.exports = { readKey, listVoices, speak, speakScript, toWav, silence, peak, RATE, CACHE };
