#!/usr/bin/env node
/* TheraChart voice eval — the dictation chain, end to end, out loud.

   What this scores that nothing else does:

     test/dictation.test.js   the recorder's backstops, against a fake AudioContext
     test/eval/run.js         the note, from CLEAN typed transcripts
     THIS                     the note, from audio Google actually transcribed

   The gap between the second and the third is the whole point. A refine prompt
   that scores 100% on typed text can still produce a wrong chart in a clinic,
   because the text it gets there has been through Chirp 2 first. This runner
   speaks each script with ElevenLabs, POSTs the WAV to the real /api/stt, scores
   the transcript that comes back, and only then hands it to /api/refine — so
   both halves are measured, and a failure says which half broke.

     node test/voice/run.js --list-voices     # what your ElevenLabs account has
     node test/voice/run.js --say-only        # generate audio only — no Google, no cost
     node test/voice/run.js --no-refine       # STT + word error rate only (the cheap half)
     node test/voice/run.js                   # everything
     node test/voice/run.js --case knee/      # only ids with this prefix
     node test/voice/run.js --keep-wav out/   # write the WAVs out to listen to
     node test/voice/run.js --save-baseline   # record this run as the bar
     node test/voice/run.js --json

   THIS RUNNER SPENDS MONEY on someone else's meter — Google STT per second of
   audio, and Vertex per refine call. It prints the bill at the end and refuses
   to start without credentials rather than quietly scoring a fallback. The
   ElevenLabs half is cached on disk, so only the first run pays for the speech.
*/

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { startServer } = require("../helpers/server.js");
const { SCRIPTS, spokenText } = require("./scripts.js");
const say = require("./say.js");

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  const v = i >= 0 ? argv[i + 1] : null;
  return v && !v.startsWith("--") ? v : d;
};

const LIST_VOICES = has("--list-voices");
const SWEEP = has("--sweep");
const SWEEP_VOICES = val("--sweep", "");
const TAKES = Math.max(1, Number(val("--takes", "1")) || 1);
const SAY_ONLY = has("--say-only");
const NO_REFINE = has("--no-refine");
const JSON_OUT = has("--json");
const SAVE = has("--save-baseline");
/* Comma-separated, so one run can cover a hand-picked set — comparing two TTS
   models over the same three scripts took six invocations before this. */
const ONLY = val("--case", "");
const ONLY_LIST = ONLY ? ONLY.split(",").map((x) => x.trim()).filter(Boolean) : [];
const matches = (id) => !ONLY_LIST.length || ONLY_LIST.some((pre) => id.startsWith(pre));
const KEEP_WAV = val("--keep-wav", "");
const MODEL_ID = val("--tts-model", process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2");
const GAP_MS = Number(val("--gap", "500"));
const ROOM = Number(val("--room", "0.004"));   // room tone; see mixNoise in say.js
const LEVEL = Number(val("--level", "1"));

/* Google's list price for Speech-to-Text v2, the same figure /api/usage prices
   a clinic's seconds at (server.js) and the cost model runs on
   (pricing-model.js:41). Duplicated here rather than imported because
   pricing-model.js is a standalone report, not a module. */
const STT_PER_MIN = 0.016;

/* ---------- word error rate ---------- */

/* Number words to digits, so "one hundred twenty degrees" and "120 degrees"
   are not scored as three errors. This is the only liberty the scorer takes
   with the transcript, and it takes it on BOTH sides: Chirp 2 is free to
   return either form and neither is wrong, so counting the difference would
   measure formatting rather than hearing. Everything else — a dropped word, a
   wrong word, a wrong number — is scored as said. */
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
  /* Tagalog and Cebuano numerals, because a patient asked "kung isa hanggang
     sampu?" answers in them. Without these the scorer charged an error every
     time Chirp 2 correctly heard "sampu" and wrote "10" — marking the model
     wrong for being right, and only ever on the PH-language scripts, which are
     the ones this harness exists to measure.
     The two languages share lima/pito/walo/siyam; the rest differ. */
  isa: 1, dalawa: 2, tatlo: 3, apat: 4, lima: 5, anim: 6, pito: 7, walo: 8, siyam: 9, sampu: 10,
  usa: 1, duha: 2, tulo: 3, upat: 4, unom: 6, napulo: 10 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function wordsToDigits(tokens) {
  const out = [];
  let acc = null, pending = 0;
  const flush = () => {
    if (acc === null && !pending) return;
    out.push(String((acc || 0) + pending));
    acc = null; pending = 0;
  };
  for (const t of tokens) {
    if (t in UNITS) { pending += UNITS[t]; acc = acc === null ? 0 : acc; continue; }
    if (t in TENS) { pending += TENS[t]; acc = acc === null ? 0 : acc; continue; }
    if (t === "hundred") { pending = (pending || 1) * 100; acc = (acc || 0); continue; }
    if (t === "thousand") { acc = ((acc || 0) + (pending || 1)) * 1000; pending = 0; continue; }
    if (t === "and" && acc !== null) continue;   // "one hundred and twenty"
    flush();
    out.push(t);
  }
  flush();
  return out;
}

function words(s) {
  const flat = String(s || "")
    .toLowerCase()
    .replace(/(\d)\s*\/\s*(\d)/g, "$1 out of $2")   // "7/10" is spoken "seven out of ten"
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return wordsToDigits(flat);
}

/** Levenshtein over words: substitutions + insertions + deletions, over the
    reference length. The standard definition, so the number is comparable to
    the 8.8% / 27.7% figures already quoted in README.md and server.js. */
function wer(refText, hypText) {
  const ref = words(refText), hyp = words(hypText);
  if (!ref.length) return { wer: hyp.length ? 1 : 0, ref: 0, edits: hyp.length };
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = ref[i - 1] === hyp[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return { wer: prev[hyp.length] / ref.length, ref: ref.length, edits: prev[hyp.length] };
}

/* ---------- credentials ---------- */

function gcloudToken() {
  const bin = process.env.GCLOUD_PATH
    || (fs.existsSync(`${process.env.HOME}/google-cloud-sdk/bin/gcloud`) ? `${process.env.HOME}/google-cloud-sdk/bin/gcloud` : "gcloud");
  try { return { bin, token: execFileSync(bin, ["auth", "print-access-token"], { encoding: "utf8" }).trim() }; }
  catch { return null; }
}

/* One retry on a transport failure.

   A POST to our own localhost server occasionally rejects with a bare
   "fetch failed" — no status, no body — and it has now killed three otherwise
   good runs partway through, each forfeiting the Google spend already incurred.
   It is a transport hiccup rather than a result, so the honest handling is to
   try once more; a second failure is reported as itself. */
async function postWav(url, token, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "audio/wav" }, body });
    } catch (e) {
      if (attempt) throw e;
      console.log(`    (transport hiccup, retrying once: ${e.message})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const bar = (x) => { const n = x >= 1 ? 20 : Math.max(0, Math.floor(x * 20)); return "█".repeat(n) + "░".repeat(20 - n); };

/* ---------- the voice sweep ----------

   One voice pair produces one number, and a single number cannot tell you
   whether a script failed because the SYSTEM is weak there or because that
   particular synthetic speaker mangled a word. A clinic is many speakers; the
   baseline is one.

   So this speaks every script in several voices — one voice playing both parts,
   which keeps the attribution clean — and prints the spread. A row that is bad
   in every voice is the product's problem. A row that is bad in one voice is
   that voice's problem, and on a Cebuano script that usually means the speech
   model rather than the transcriber.

   Transcription only, deliberately. Grading fifteen notes once per voice would
   multiply the Vertex bill to answer a question about hearing. */
async function sweep(scripts, key) {
  const all = await say.listVoices(key);
  const byId = new Map(all.map((v) => [v.id, v]));

  let ids = SWEEP_VOICES && SWEEP_VOICES !== "true"
    ? SWEEP_VOICES.split(",").map((x) => x.trim()).filter(Boolean)
    : all.filter((v) => /filipino/i.test(v.labels.accent || "")).map((v) => v.id);
  ids = ids.filter((id) => byId.has(id));
  if (ids.length < 2) {
    console.error("The sweep needs at least two voices. Pass them explicitly: --sweep id1,id2,id3");
    process.exit(2);
  }

  const gc = gcloudToken();
  if (!gc) { console.error("Not signed in to gcloud — run: gcloud auth login"); process.exit(2); }
  const project = process.env.GCP_PROJECT || "therachart-prod";

  const settings = { stability: 0.5, similarity_boost: 0.75 };
  console.log(`\n  Sweeping ${scripts.length} script(s) across ${ids.length} voice(s): ${ids.map((i) => byId.get(i).name.split(" - ")[0]).join(", ")}\n`);

  // speak everything first — a TTS failure should cost nothing at Google
  const takes = new Map();
  for (const id of ids) {
    for (const sc of scripts) {
      process.stdout.write(`  ${byId.get(id).name.split(" - ")[0]} · ${sc.id}… `);
      for (let k = 0; k < TAKES; k++) {
        const t = await say.speakScript(sc, { key, voices: { clinician: id, patient: id },
          modelId: MODEL_ID, settings, gapMs: GAP_MS, roomRms: ROOM, level: LEVEL, take: k });
        takes.set(`${id}|${sc.id}|${k}`, t);
        if (k === 0) process.stdout.write(`${t.seconds.toFixed(0)}s${t.cached ? " (cached)" : ""}`);
      }
      console.log(TAKES > 1 ? ` ×${TAKES} takes` : "");
    }
  }

  const s = await startServer({
    GCP_PROJECT: project, GCP_USE_GCLOUD: "1", GCLOUD_PATH: gc.bin,
    GEMINI_VERTEX: "", THERACHART_DEMO_LOGINS: "1",
  });
  let billed = 0;
  const cell = new Map();   // "voice|script" -> { wer, missing[] }
  try {
    const login = await s.demoSignIn("u-maria");
    const token = login.data && login.data.token;
    if (!token) throw new Error(`demo sign-in failed: ${JSON.stringify(login.data)}`);

    for (const id of ids) {
      for (const sc of scripts) {
        const samples = [];
        for (let k = 0; k < TAKES; k++) {
          const t = takes.get(`${id}|${sc.id}|${k}`);
          const parts = await Promise.all(t.wavs.map(async (wav) => {
            const r = await postWav(`${s.base}/api/stt?lang=${encodeURIComponent(sc.lang)}&model=chirp2&docId=`, token, wav);
            const d = await r.json().catch(() => ({}));
            if (typeof d.billedSeconds === "number") billed += d.billedSeconds;
            return r.ok ? (d.text || "") : null;
          }));
          if (parts.every((x) => x === null)) continue;
          const heard = parts.filter((x) => x !== null).join(" ").replace(/\s+/g, " ").trim();
          const missing = (sc.heard.must || []).filter((m) => !new RegExp(`\\b${m}`, "i").test(heard));
          samples.push({ wer: wer(spokenText(sc), heard).wer, missing, heard });
        }
        if (!samples.length) { cell.set(`${id}|${sc.id}`, null); continue; }
        // the cell reports the MEDIAN take, so one lucky or unlucky generation
        // cannot speak for the voice
        const sorted = [...samples].map((x) => x.wer).sort((a, b) => a - b);
        cell.set(`${id}|${sc.id}`, {
          wer: sorted[Math.floor(sorted.length / 2)],
          missing: samples[0].missing, samples, heard: samples[0].heard,
        });
      }
    }
  } finally { s.stop(); }

  /* ---------- the table ---------- */
  const nameOf = (id) => byId.get(id).name.split(" - ")[0].slice(0, 9);
  const W = 10;
  console.log(`\nTheraChart voice sweep — ${MODEL_ID} → Chirp 2 (${project}) · transcription only\n`);
  console.log("  " + "script".padEnd(32) + ids.map((i) => nameOf(i).padStart(W)).join("") + "spread".padStart(W));
  console.log("  " + "─".repeat(32 + W * (ids.length + 1)));

  const rows = [];
  for (const sc of scripts) {
    const vals = ids.map((i) => { const c = cell.get(`${i}|${sc.id}`); return c ? c.wer : null; });
    const ok = vals.filter((v) => v !== null);
    const spread = ok.length ? Math.max(...ok) - Math.min(...ok) : 0;
    rows.push({ sc, vals, spread, mean: ok.reduce((n, v) => n + v, 0) / (ok.length || 1) });
    console.log("  " + sc.id.padEnd(32)
      + vals.map((v) => (v === null ? "—" : pct(v)).padStart(W)).join("")
      + pct(spread).padStart(W));
  }
  console.log("  " + "─".repeat(32 + W * (ids.length + 1)));
  const means = ids.map((i) => {
    const vs = scripts.map((sc) => cell.get(`${i}|${sc.id}`)).filter(Boolean).map((c) => c.wer);
    return vs.reduce((n, v) => n + v, 0) / (vs.length || 1);
  });
  console.log("  " + "MEAN".padEnd(32) + means.map((m) => pct(m).padStart(W)).join(""));

  /* What the spread is actually for. */
  const SPREAD_HI = 0.10;
  const voiceSensitive = rows.filter((r) => r.spread >= SPREAD_HI).sort((a, b) => b.spread - a.spread);
  const systematic = rows.filter((r) => r.spread < SPREAD_HI && r.mean >= 0.15).sort((a, b) => b.mean - a.mean);

  if (systematic.length) {
    /* "Not one speaker's fault" is all a low spread proves. It does NOT single
       out the app: a limit of the speech model itself shows up here too, evenly
       across every voice it renders. knee/cebuano-heavy sits in this list at
       ~22% because eleven_multilingual_v2 does not speak Cebuano, which is a
       fact about the harness, not about the chart. */
    console.log(`\n  BAD IN EVERY VOICE — not one speaker's fault. Could be the app, the`);
    console.log(`  transcriber, or the speech model's grasp of the language:`);
    for (const r of systematic) console.log(`    ${pct(r.mean).padStart(6)} mean, ${pct(r.spread)} spread  ${r.sc.id}`);
  }
  if (voiceSensitive.length) {
    console.log(`\n  VOICE-SENSITIVE — one speaker is doing much worse than another here.`);
    console.log(`  On a Tagalog or Cebuano script that points at the SPEECH model, not the transcriber:`);
    for (const r of voiceSensitive) {
      const best = ids[r.vals.indexOf(Math.min(...r.vals.filter((v) => v !== null)))];
      const worst = ids[r.vals.indexOf(Math.max(...r.vals.filter((v) => v !== null)))];
      console.log(`    ${pct(r.spread).padStart(6)} spread  ${r.sc.id.padEnd(30)} best ${nameOf(best)}, worst ${nameOf(worst)}`);
    }
  }

  // words that never survived, and in which voices — a word lost by ALL of them
  // is a vocabulary problem; lost by one is a pronunciation problem
  const lost = [];
  for (const sc of scripts) {
    for (const m of sc.heard.must || []) {
      let heardIn = 0, total = 0;
      for (const i of ids) {
        const c = cell.get(`${i}|${sc.id}`);
        if (!c) continue;
        for (const smp of c.samples) { total += 1; if (!smp.missing.includes(m)) heardIn += 1; }
      }
      if (total && heardIn < total) lost.push({ id: sc.id, word: m, heardIn, total });
    }
  }
  if (lost.length) {
    console.log(`\n  WORDS THAT DID NOT ALWAYS ARRIVE (across every voice × take):`);
    for (const l of lost) {
      const rate = l.heardIn / l.total;
      /* Never vs sometimes is the whole distinction. A word that never arrives
         is a vocabulary failure worth fixing at the source. A word that arrives
         half the time is a COIN FLIP, and any assertion resting on it is
         reporting the toss rather than the product. */
      const verdict = l.heardIn === 0 ? "NEVER — vocabulary, fix at the source"
        : rate < 0.9 ? "A COIN FLIP — no assertion should rest on this"
          : "usually";
      console.log(`    "${l.word}" in ${l.id} — heard in ${l.heardIn}/${l.total} (${pct(rate)})  ${verdict}`);
    }
  }
  if (TAKES > 1) {
    console.log(`\n  Each cell is the MEDIAN of ${TAKES} independent recordings, so a single`);
    console.log(`  lucky or unlucky generation cannot speak for a voice.`);
  }

  console.log([``, `  BILL FOR THIS SWEEP`,
    `    Speech-to-Text  ${billed}s billed  ·  $${((billed / 60) * STT_PER_MIN).toFixed(3)}`,
    `    Vertex          nothing — a sweep grades hearing, not notes`, ``].join("\n"));
}

/* ---------- run ---------- */

(async () => {
  const key = say.readKey();
  if (!key) {
    console.error([
      "No ElevenLabs key.",
      "",
      "  Put it in .secrets/elevenlabs-key.txt (one line, nothing else) — that folder is",
      "  git-ignored, the same place the Gemini key already lives — or set ELEVENLABS_API_KEY.",
    ].join("\n"));
    process.exit(2);
  }

  if (LIST_VOICES) {
    const voices = await say.listVoices(key);
    console.log(`\n${voices.length} voice(s) on this account:\n`);
    for (const v of voices) {
      const tags = [v.labels.accent, v.labels.gender, v.labels.age, v.labels.use_case].filter(Boolean).join(", ");
      console.log(`  ${v.id}  ${v.name.padEnd(22)} ${tags}`);
    }
    console.log([
      "",
      "  Pick two and pass them as the clinician and the patient:",
      "    node test/voice/run.js --voice-clinician <id> --voice-patient <id>",
      "",
      "  Filipino-accented English is the case that matters here — the language-code",
      "  measurement in README.md says the PH codes only earn their place on it.",
      "",
    ].join("\n"));
    return;
  }

  if (SWEEP) {
    const swept = SCRIPTS.filter((sc) => matches(sc.id));
    if (!swept.length) { console.error(`no scripts match --case ${ONLY}`); process.exit(2); }
    return sweep(swept, key);
  }

  const voices = {
    clinician: val("--voice-clinician", process.env.ELEVENLABS_VOICE_CLINICIAN || ""),
    patient: val("--voice-patient", process.env.ELEVENLABS_VOICE_PATIENT || ""),
  };
  if (!voices.clinician || !voices.patient) {
    const all = await say.listVoices(key);
    if (all.length < 2) { console.error("Need at least two voices on the ElevenLabs account."); process.exit(2); }
    /* Filipino-accented voices first. The old default — whatever the account
       listed first — handed a harness about Philippine speech two American
       voices, which is the one accent the language codes it tests are NOT for.

       Within those, PREFERRED is the order the sweep measured (mean word error
       across all fifteen scripts: Pedro 4.7%, Mang Jose 5.3%, Juan Tamad 5.1%,
       Juvy 6.6%). That is not tuning the test to pass. A script is meant to
       measure TheraChart, and knee/cebuano-heavy could not: Juvy's Cebuano
       swings it by nearly twenty points on its own, so the number it produced
       was about ElevenLabs. Picking a voice that pronounces the language
       properly fixes the instrument. Robustness across speakers is what
       --sweep is for, and it still runs every voice. */
    const PREFERRED = ["iyZZ2rpPw5XY3ZQltAWV", "X69aMGx8u7YHtScNLx9R"]; // Pedro, Mang Jose
    const byId = new Map(all.map((v) => [v.id, v]));
    const ph = [...PREFERRED.filter((id) => byId.has(id)),
      ...all.filter((v) => /filipino/i.test(v.labels.accent || "") && !PREFERRED.includes(v.id)).map((v) => v.id),
      ...all.map((v) => v.id)];
    const pick = [...new Set(ph)];
    voices.clinician = voices.clinician || pick[0];
    voices.patient = voices.patient || pick[1];
    const nm = (id) => (byId.get(id) || {}).name || id;
    console.log(`No voices given — using ${nm(voices.clinician)} as the clinician and ${nm(voices.patient)} as the patient.`);
    console.log(`--list-voices to choose deliberately, --sweep to run them all.\n`);
  }

  const scripts = SCRIPTS.filter((s) => matches(s.id));
  if (!scripts.length) { console.error(`no scripts match --case ${ONLY}`); process.exit(2); }


  /* ---- speak everything first, so a TTS failure costs nothing at Google ---- */
  const settings = { stability: 0.5, similarity_boost: 0.75 };
  const takes = [];
  for (const s of scripts) {
    process.stdout.write(`  speaking ${s.id}… `);
    /* A script may name its own voices. Only one does, and it earned it: on
       knee/cebuano-heavy the patient voice was deciding the result. Measured
       over 12 takes, Pedro speaking both parts keeps the laterality word 12/12
       at 1.7% real word error; Pedro with Mang Jose as the patient — who says
       the "tuo nga tuhod" line — keeps it 7/12 at 6.0%. Same script, same
       transcriber, same model. A script that swings on which synthetic voice
       reads it is measuring ElevenLabs, and this one is supposed to be
       measuring the chart. */
    const take = await say.speakScript(s, { key, voices: { ...voices, ...(s.voices || {}) },
      modelId: MODEL_ID, settings, gapMs: GAP_MS, roomRms: ROOM, level: LEVEL });
    takes.push({ script: s, ...take });
    console.log(`${take.seconds.toFixed(1)}s${take.wavs.length > 1 ? ` in ${take.wavs.length} chunks` : ""}${take.cached ? " (cached)" : ""} peak ${take.peak.toFixed(2)}`);
    if (take.peak < 0.05) console.log(`    ⚠ that take is almost silent — check the voice id and --level`);
  }

  if (KEEP_WAV) {
    fs.mkdirSync(KEEP_WAV, { recursive: true });
    for (const t of takes) t.wavs.forEach((w, i) => fs.writeFileSync(
      path.join(KEEP_WAV, `${t.script.id.replace(/\//g, "-")}${t.wavs.length > 1 ? `-${i + 1}` : ""}.wav`), w));
    console.log(`\n  WAVs written to ${KEEP_WAV}`);
  }

  const audioSeconds = takes.reduce((n, t) => n + t.seconds, 0);
  if (SAY_ONLY) {
    console.log(`\n  ${takes.length} take(s), ${audioSeconds.toFixed(0)}s of audio. Nothing was sent to Google.`);
    console.log(`  A full run would bill about $${((audioSeconds / 60) * STT_PER_MIN).toFixed(3)} of Speech-to-Text.\n`);
    return;
  }

  /* ---- the real server, with real credentials ---- */
  const gc = gcloudToken();
  if (!gc) {
    console.error("Not signed in to gcloud — Speech-to-Text cannot run, and a run without it would score nothing.\n  Run: gcloud auth login");
    process.exit(2);
  }
  const project = process.env.GCP_PROJECT || "therachart-prod";
  console.log(`\n  Booting a throwaway server against ${project} (STT ${NO_REFINE ? "only" : "+ Vertex refine"})…`);

  const s = await startServer({
    GCP_PROJECT: project,
    GCP_USE_GCLOUD: "1",
    GCLOUD_PATH: gc.bin,
    GEMINI_VERTEX: NO_REFINE ? "" : "1",
    THERACHART_DEMO_LOGINS: "1",     // the seeded accounts hold no password; the picker is the door
  });

  let out = null;
  try {
    const login = await s.demoSignIn("u-maria");   // a therapist: canDocument, which /api/refine requires
    const token = login.data && login.data.token;
    if (!token) throw new Error(`demo sign-in failed: ${JSON.stringify(login.data)}`);

    const results = [];
    let billedSeconds = 0, refineCalls = 0;

    for (const t of takes) {
      const sc = t.script;
      process.stdout.write(`  ${sc.id}… `);

      /* Exactly the requests processRecording makes in app.js: one raw WAV
         body per chunk, the chosen language code, chirp2, bearer token — sent
         together and reassembled in order.

         The stitching is copied deliberately, marker and all. A chunk that
         fails leaves a HOLE, and joining the survivors with a space splices
         the sentence before a lost fifty seconds onto the one after it, so
         "…denies numbness" and "…in the right shoulder" read in the record as
         one continuous statement nobody made. That is a property of the
         product worth testing, not an implementation detail worth skipping. */
      const AUDIO_GAP_MARK = "[audio not transcribed — this part of the recording failed]";
      const parts = await Promise.all(t.wavs.map(async (wav) => {
        const r = await postWav(`${s.base}/api/stt?lang=${encodeURIComponent(sc.lang)}&model=chirp2&docId=`, token, wav);
        const d = await r.json().catch(() => ({}));
        // billed outside the ok branch: a chunk that failed AT Google is still billed
        if (typeof d.billedSeconds === "number") billedSeconds += d.billedSeconds;
        return r.ok ? { text: d.text || "", model: d.model } : { error: d.error || `HTTP ${r.status}` };
      }));

      const lost = parts.filter((p) => p.error);
      if (lost.length === parts.length) {
        console.log(`STT FAILED — ${lost[0].error}`);
        results.push({ id: sc.id, why: sc.why, sttError: lost[0].error, chunks: t.wavs.length,
          earned: 0, possible: sc.expect.reduce((n, a) => n + a.weight, 0), failed: [], heardFailed: [] });
        continue;
      }
      const heard = parts
        .map((p) => (p.error ? AUDIO_GAP_MARK : p.text))
        .filter((x, i) => x !== AUDIO_GAP_MARK || i === 0 || !parts[i - 1].error)
        .join(" ").replace(/\s+/g, " ").trim();
      const w = wer(spokenText(sc), heard);
      const heardFailed = [];
      if (sc.heard.wer != null && w.wer > sc.heard.wer) heardFailed.push(`word error ${pct(w.wer)} over the ${pct(sc.heard.wer)} ceiling`);
      for (const m of sc.heard.must || []) {
        if (!new RegExp(`\\b${m}`, "i").test(heard)) heardFailed.push(`"${m}" never made it into the transcript`);
      }

      let result = null, refineError = null;
      if (!NO_REFINE) {
        /* One line, the way processRecording stitches a recording: the refine
           pass has to find the speaker boundaries itself. */
        const rr = await fetch(`${s.base}/api/refine`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ transcript: [heard] }),
        });
        const rd = await rr.json().catch(() => ({}));
        refineCalls += 1;
        if (rr.ok) result = rd; else refineError = rd.error || `HTTP ${rr.status}`;
      }

      /* A refine that fell back to the heuristic is not the thing under test —
         same guard test/eval/run.js keeps, for the same reason. */
      const fellBack = !!result && (/local/.test(result.source || "") || result.aiFailed === true);

      const graded = sc.expect.map((a) => {
        if (NO_REFINE || !result) return { name: a.name, weight: a.weight, skipped: true };
        let ok = false, thrown = null, detail = "";
        try { ok = !!a.test(result); if (!ok && a.detail) detail = a.detail(result); }
        catch (e) { thrown = e.message; }
        return { name: a.name, weight: a.weight, ok, thrown, detail };
      });
      const scored = graded.filter((g) => !g.skipped);
      const earned = scored.reduce((n, g) => n + (g.ok ? g.weight : 0), 0);
      const possible = scored.reduce((n, g) => n + g.weight, 0);

      console.log(`WER ${pct(w.wer)}${NO_REFINE ? "" : ` · note ${possible ? pct(earned / possible) : "n/a"}`}${fellBack ? "  ⚠ FELL BACK" : ""}`);

      results.push({
        id: sc.id, why: sc.why, lang: sc.lang, chunks: t.wavs.length, advisory: !!sc.advisory,
        wer: w.wer, refWords: w.ref, edits: w.edits,
        spoken: spokenText(sc), heard,
        heardFailed, refineError, fellBack,
        model: (parts.find((x) => x.model) || {}).model,
        graded, earned, possible,
        failed: graded.filter((g) => !g.skipped && !g.ok).map((g) => ({ name: g.name, detail: g.detail })),
        /* The whole refine answer, for --json only. It is what you actually
           want when a failure turns out to be more interesting than the
           assertion that caught it, and it is stripped before the baseline is
           written so a baseline diff stays readable. */
        note: result,
      });
    }

    /* ---------- report ---------- */
    const earned = results.reduce((n, r) => n + r.earned, 0);
    const possible = results.reduce((n, r) => n + r.possible, 0);
    const overall = possible ? earned / possible : 0;
    const meanWer = results.filter((r) => r.wer != null).reduce((n, r, _, a) => n + r.wer / a.length, 0);
    const usd = (billedSeconds / 60) * STT_PER_MIN;

    out = {
      tts: { model: MODEL_ID, voices }, project,
      audioSeconds, billedSeconds, sttUsd: Number(usd.toFixed(4)), refineCalls,
      meanWer, earned, possible, overall, cases: results,
    };

    if (JSON_OUT) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`\nTheraChart voice eval — ${MODEL_ID} → Chirp 2 (${project})${NO_REFINE ? " · transcription only" : ""}\n`);
      for (const r of results) {
        if (r.sttError) { console.log(`  ${"░".repeat(20)}         ${r.id}\n  ${" ".repeat(20)}         ! STT failed: ${r.sttError}`); continue; }
        const p = r.possible ? r.earned / r.possible : 0;
        console.log(`  ${NO_REFINE ? "░".repeat(20) : bar(p)} ${(NO_REFINE ? "" : pct(p)).padStart(6)}  ${r.id}  ·  WER ${pct(r.wer)} (${r.edits}/${r.refWords} words)${r.chunks > 1 ? ` · ${r.chunks} chunks` : ""}${r.fellBack ? "  ⚠ FELL BACK TO LOCAL" : ""}`);
        console.log(`  ${" ".repeat(20)}         ${r.why}${r.advisory ? "  [ADVISORY — reported, does not fail the run]" : ""}`);
        for (const h of r.heardFailed) console.log(`  ${" ".repeat(20)}         ✗ heard: ${h}`);
        for (const f of r.failed) console.log(`  ${" ".repeat(20)}         ✗ note: ${f.name}${f.detail ? `\n  ${" ".repeat(20)}             ${f.detail}` : ""}`);
        if (r.refineError) console.log(`  ${" ".repeat(20)}         ! refine: ${r.refineError}`);
      }
      console.log(`\n  TRANSCRIPTION  mean word error ${pct(meanWer)} across ${results.length} script(s)`);
      if (!NO_REFINE) console.log(`  NOTE           ${bar(overall)} ${pct(overall)}  (${earned}/${possible} weighted points)`);

      const bPath = path.join(__dirname, "baseline.json");
      const baseline = fs.existsSync(bPath) ? JSON.parse(fs.readFileSync(bPath, "utf8")) : null;
      /* Only compare totals when the SAME scripts ran. A --case run averages a
         different set, and reporting that against the full baseline produced a
         confident "word error WORSE by 3.0%" that meant nothing at all. The
         per-script diff below is still valid either way, so it keeps running. */
      const sameSet = baseline && results.length === (baseline.cases || []).length
        && results.every((r) => (baseline.cases || []).some((c) => c.id === r.id));
      if (baseline && !sameSet) {
        console.log(`\n  vs baseline: totals not compared — this run scored ${results.length} of the baseline's ${(baseline.cases || []).length} script(s)`);
      }
      if (baseline && sameSet) {
        const dw = meanWer - baseline.meanWer;
        console.log(`\n  vs baseline: word error ${dw > 0.001 ? `WORSE by ${pct(dw)}` : dw < -0.001 ? `better by ${pct(-dw)}` : "unchanged"} (was ${pct(baseline.meanWer)})`);
        if (!NO_REFINE && baseline.overall != null) {
          const dn = overall - baseline.overall;
          console.log(`               note score ${dn > 0.001 ? `improved by ${pct(dn)}` : dn < -0.001 ? `REGRESSED by ${pct(-dn)}` : "unchanged"} (was ${pct(baseline.overall)})`);
        }
      }
      if (baseline) {
        const bById = new Map((baseline.cases || []).map((c) => [c.id, c]));
        for (const r of results) {
          const b = bById.get(r.id);
          if (!b) { console.log(`    + new script ${r.id}`); continue; }
          const was = new Set((b.failed || []).map((f) => f.name));
          for (const f of r.failed) if (!was.has(f.name)) console.log(`    ✗ newly failing — ${r.id}: ${f.name}`);
          for (const n of was) if (!r.failed.some((f) => f.name === n)) console.log(`    ✓ newly passing — ${r.id}: ${n}`);
        }
      } else if (!SAVE) {
        console.log(`\n  no baseline yet — record one with:  node test/voice/run.js --save-baseline`);
      }

      console.log([
        ``,
        `  BILL FOR THIS RUN`,
        `    Speech-to-Text  ${billedSeconds}s billed  ·  $${usd.toFixed(3)}`,
        !NO_REFINE ? `    Vertex refine   ${refineCalls} call(s)  ·  metered on ${project}, see /api/usage` : ``,
        `    ElevenLabs      ${takes.every((t) => t.cached) ? "nothing — every take was cached" : "charged for the new takes only; they are cached now"}`,
        ``,
      ].filter(Boolean).join("\n"));
    }

    if (SAVE) {
      const slim = { ...out, cases: out.cases.map(({ note, spoken, ...c }) => c) };
      fs.writeFileSync(path.join(__dirname, "baseline.json"), JSON.stringify(slim, null, 2));
      console.log(`  baseline saved to test/voice/baseline.json\n`);
    }
  } catch (e) {
    /* "fetch failed" on a localhost call means the server went away, and the
       reason is in ITS log, not in ours. The helper has been capturing that
       all along — printing it is the difference between a diagnosis and a
       shrug. */
    const log = s.log();
    if (log.trim()) console.error(`\n  --- server log ---\n${log.split("\n").slice(-25).map((l) => "  " + l).join("\n")}\n  --- end ---`);
    throw e;
  } finally {
    s.stop();
  }

  /* Non-zero when a script did worse than its own ceiling, so this can gate a
     prompt change the same way the text eval does. */
  /* Advisory scripts are excluded from the exit code on purpose. A gate is only
     worth having if a red run means something changed; a script whose own
     instrument is nine times noisier than the rest would make it mean "the
     synthesiser had an off day". It is still printed, and still in the
     baseline diff. */
  const broke = (out && out.cases || [])
    .filter((r) => !r.advisory)
    .some((r) => r.sttError || r.heardFailed.length || r.failed.length);
  if (broke && !SAVE) process.exit(1);
})().catch((e) => { console.error(`\n${e.stack || e.message}`); process.exit(2); });
