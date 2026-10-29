/* TheraChart dictation-pause checker — the microphone is OFF unless asked for.

   Dictation was paused on 2026-10-28: the app is built around typed findings,
   and speech-to-text, the recorder and every mic control are hidden unless the
   server is started with THERACHART_DICTATION=1. Hiding it in the page is not
   enough on its own — a stale tab or a hand-rolled request could still post
   audio and bill Speech-to-Text — so these checks pin the server side:

     - with no flag, /api/ping and /api/ai-status say dictation is off,
       Speech-to-Text reports unavailable, and POST /api/stt is refused
     - with THERACHART_DICTATION=1 the same server offers it again, so turning
       it back on is the one setting and not a restore
     - the client only shows dictation on an explicit `true`, so an older server
       or static hosting with no server at all stays mic-free

   Run: node test/dictationpause.test.js */

"use strict";

const fs = require("fs");
const path = require("path");
const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const r = reporter("dictation-pause checker");

  /* ---------------- default: paused ---------------- */
  const off = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  try {
    const ping = await off.call("/api/ping");
    r.check("ping reports dictation off by default", ping.data && ping.data.dictation === false, JSON.stringify(ping.data));
    r.check("…and Speech-to-Text unavailable", ping.data && ping.data.stt && ping.data.stt.available === false, JSON.stringify(ping.data && ping.data.stt));

    const status = await off.call("/api/ai-status");
    r.check("ai-status reports dictation off by default", status.data && status.data.dictation === false, JSON.stringify(status.data));

    const token = (await off.demoSignIn("u-maria")).data.token;
    const stt = await off.call("/api/stt?lang=fil-PH&model=chirp2", { method: "POST", token, body: { x: 1 } });
    r.check("POST /api/stt is refused while dictation is paused", stt.status === 404, `status ${stt.status}`);
    r.check("…with a reason a person can read", /turned off/i.test((stt.data && stt.data.error) || ""), JSON.stringify(stt.data));

    // the rest of charting is untouched by the pause
    const state = await off.call("/api/state", { token });
    r.check("charting still works with dictation paused", state.status === 200, `status ${state.status}`);
  } finally {
    off.stop();
  }

  /* ---------------- THERACHART_DICTATION=1: back on ---------------- */
  const on = await startServer({ THERACHART_DEMO_LOGINS: "1", THERACHART_DICTATION: "1" });
  try {
    const ping = await on.call("/api/ping");
    r.check("THERACHART_DICTATION=1 turns dictation back on", ping.data && ping.data.dictation === true, JSON.stringify(ping.data));
    const token = (await on.demoSignIn("u-maria")).data.token;
    const stt = await on.call("/api/stt?lang=fil-PH&model=chirp2", { method: "POST", token, body: { x: 1 } });
    // tests blank the Google credentials, so a routed request answers 400/501
    r.check("…and /api/stt routes again", stt.status !== 404, `status ${stt.status}`);
  } finally {
    on.stop();
  }

  /* ---------------- client: only an explicit true shows the mic ---------------- */
  const sync = fs.readFileSync(path.join(__dirname, "..", "sync.js"), "utf8");
  r.check("sync.js defaults dictation to off", /dictation:\s*false/.test(sync));
  r.check("sync.js turns it on only for an explicit true",
    (sync.match(/sync\.dictation = data\.dictation === true/g) || []).length >= 2,
    "both the boot ping and the reconnect ping must use a strict comparison");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  r.check("app.js reads the flag from TheraSync", /const dictationOn = \(\) => !!\(window\.TheraSync && window\.TheraSync\.dictation\)/.test(app));
  r.check("the mic is only wired when dictation is on", /if \(dictationOn\(\)\) startDictation\(/.test(app));

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
