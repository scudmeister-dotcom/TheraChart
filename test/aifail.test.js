/* TheraChart AI-failure checker — the states that only happen when the model
   does NOT answer.

   Every other test in this suite exercises the happy ordering of events: the
   AI is configured, the call succeeds, the review comes back. Production has
   an ordering we never reproduced. Vertex serves the 3.x models from dynamic
   shared quota — capacity pooled across customers rather than reserved per
   project — so it returns 429 under load even though our own project limits
   are nowhere near binding, and a review can simply fail. Nothing local ever
   produced that, which meant the refusal path shipped verified only by
   reading it.

   The same blind spot produced a bug in the delete dialog: an AI pass with no
   dictation could not arise locally, because every local test dictates first,
   so "This draft used 0 min of dictation and 1 AI pass" reached a live clinic.
   Fixtures encode the happy ordering; the states that occur when something
   fails or is skipped are exactly the ones nothing exercises.

   This file exercises them, through the real HTTP path rather than by reading
   source: a stub stands in for the model so the route, ai.js, the retry
   wrapper, the transport and the refusal contract all run for real.

   Run: node test/aifail.test.js */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { startServer, reporter } = require("./helpers/server.js");

const r = reporter("AI-failure checker");

/** A stand-in for the model. Serves whatever the current script says, and
    counts requests so a retry is a number rather than an impression. */
function stubModel() {
  let script = { status: 200, body: null };
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.writeHead(script.status, { "content-type": "application/json" });
      res.end(JSON.stringify(script.body ?? { error: { code: script.status, message: "stub" } }));
    });
  });
  return {
    listen: () => new Promise((ok) => srv.listen(0, "127.0.0.1", ok)),
    port: () => srv.address().port,
    set: (status, body) => { script = { status, body }; hits = 0; },
    hits: () => hits,
    close: () => new Promise((ok) => srv.close(ok)),
  };
}

// the envelope a real generateContent reply has, around whatever JSON we want
const reply = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

(async () => {
  const stub = stubModel();
  await stub.listen();

  /* A key plus a base URL is all it takes to run the whole chain against the
     stub. GEMINI_VERTEX stays blank on purpose: GEMINI_OPTS tests
     vertexConfigured() FIRST, so setting it would send the request to real
     Vertex and silently bypass everything here. */
  const s = await startServer({
    THERACHART_DEMO_LOGINS: "1",   // the seeded clinic, so there is a therapist to be
    GEMINI_API_KEY: "stub-key-not-a-real-one",
    GEMINI_BASE_URL: `http://127.0.0.1:${stub.port()}/v1beta`,
  });
  // demo actors are entered the way the picker does it: no password is involved
  const openDemo = (srv, userId) => srv.call("/api/demo-signin", { method: "POST", body: { userId } });
  const maria = await openDemo(s, "u-maria");   // a licensed therapist
  const auth = maria.data && maria.data.token;
  r.check("signed in as a documenting therapist", !!auth, JSON.stringify(maria).slice(0, 140));

  const refine = (transcript) => s.call("/api/refine", { method: "POST", token: auth, body: { transcript } });
  const LINES = ["my left knee has been sore for two weeks", "about a six out of ten"];

  /* ---- the model answers ---- */
  stub.set(200, reply({
    dialogue: [{ speaker: "patient", text: "my left knee has been sore for two weeks", keep: true }],
    findings: [{ bodyPart: "knee", side: "left", summary: "Sore for two weeks", sourceQuote: "my left knee has been sore" }],
  }));
  const ok = await refine(LINES);
  r.check("a successful review comes back as the model's work",
    ok.status === 200 && ok.data.source === "gemini" && ok.data.aiFailed === false,
    JSON.stringify({ s: ok.status, src: ok.data && ok.data.source, f: ok.data && ok.data.aiFailed }));
  r.check("…and carries the finding", (ok.data.findings || []).some((f) => f.part === "Knee" && f.side === "left"),
    JSON.stringify(ok.data.findings));
  r.check("…in one request", stub.hits() === 1, `${stub.hits()} requests`);

  /* ---- the pool is busy: 429 is retried, then refused ---- */
  stub.set(429, { error: { code: 429, message: "Resource exhausted" } });
  const busy = await refine(LINES);
  r.check("a 429 is retried three times before giving up", stub.hits() === 3, `${stub.hits()} requests`);
  r.check("…and the answer is a stated failure, not a review",
    busy.status === 200 && busy.data.aiFailed === true,
    JSON.stringify({ s: busy.status, f: busy.data && busy.data.aiFailed }));
  r.check("…with NO review content of any kind",
    (busy.data.dialogue || []).length === 0 && (busy.data.findings || []).length === 0
    && !busy.data.subjective && !busy.data.objective,
    JSON.stringify({ d: (busy.data.dialogue || []).length, f: (busy.data.findings || []).length }));
  r.check("…and it is a failure, not an unconfigured server",
    busy.data.unavailable === false, JSON.stringify({ u: busy.data.unavailable }));
  r.check("…and says why, in words the dialog can show",
    typeof busy.data.error === "string" && busy.data.error.length > 0, JSON.stringify(busy.data.error));

  /* The offline heuristic would have answered this transcript easily — a left
     knee, sore, 6/10. That it does NOT is the entire point: a note the model
     never read must not arrive looking like one it did. */
  r.check("the offline heuristic does not fill the gap",
    !JSON.stringify(busy.data).toLowerCase().includes("sore for"), JSON.stringify(busy.data).slice(0, 160));

  /* ---- a malformed request is not worth repeating ---- */
  stub.set(400, { error: { code: 400, message: "Invalid model name" } });
  const bad = await refine(LINES);
  r.check("a 400 is not retried — the request itself was wrong", stub.hits() === 1, `${stub.hits()} requests`);
  r.check("…and still refuses rather than substituting", bad.data.aiFailed === true, JSON.stringify(bad.data.aiFailed));

  /* ---- a server outage mid-call ---- */
  stub.set(503, { error: { code: 503, message: "Service unavailable" } });
  const out = await refine(LINES);
  r.check("a 5xx is retried too", stub.hits() === 3, `${stub.hits()} requests`);
  r.check("…and refuses", out.data.aiFailed === true, JSON.stringify(out.data.aiFailed));

  await s.stop();
  await stub.close();

  /* ---- no AI configured at all: a different answer, deliberately ---- */
  const bare = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  const bareMaria = await bare.call("/api/demo-signin", { method: "POST", body: { userId: "u-maria" } });
  const bareAuth = bareMaria.data && bareMaria.data.token;
  const none = await bare.call("/api/refine", { method: "POST", token: bareAuth, body: { transcript: LINES } });
  r.check("with no AI configured the route says unavailable, not failed",
    none.status === 503 && none.data.unavailable === true,
    JSON.stringify({ s: none.status, d: none.data }));
  r.check("…and an unauthenticated caller is turned away before that",
    (await bare.call("/api/refine", { method: "POST", body: { transcript: LINES } })).status === 401,
    "auth must be decided before availability, or an anonymous probe learns whether the model is up");
  await bare.stop();

  /* ---- the delete dialog's spend line, the other prod-only state ---- */
  {
    const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
    const start = SRC.indexOf("  function spendParts(");
    const src = SRC.slice(start, SRC.indexOf("\n  }\n", start) + 5);
    const spendParts = new Function("minutesOf", src + "\n  return spendParts;")((m) => `${Math.round(m)} min`);

    const line = (spent) => spendParts(spent, false).join(" and ");
    /* The shipped bug: an AI pass with no dictation. Impossible to reach
       locally, because every local test dictates first. */
    r.check("an AI pass with no dictation never names a zero",
      line({ seconds: 0, minutes: 0, aiCalls: 1 }) === "1 AI pass", line({ seconds: 0, minutes: 0, aiCalls: 1 }));
    r.check("…and dictation with no AI pass says only the dictation",
      line({ seconds: 300, minutes: 5, aiCalls: 0 }) === "5 min of dictation", line({ seconds: 300, minutes: 5, aiCalls: 0 }));
    r.check("both together are named as two things",
      spendParts({ seconds: 300, minutes: 5, aiCalls: 2 }, false).length === 2,
      line({ seconds: 300, minutes: 5, aiCalls: 2 }));
    /* Seconds decide, not rounded minutes — a twenty-second burst is real
       spend and must not round itself back into the zero. */
    r.check("a sub-minute burst says 'under a minute' rather than rounding to zero",
      line({ seconds: 20, minutes: 0, aiCalls: 0 }) === "under a minute of dictation",
      line({ seconds: 20, minutes: 0, aiCalls: 0 }));
    r.check("nothing spent produces nothing to name",
      spendParts({ seconds: 0, minutes: 0, aiCalls: 0 }, false).length === 0);
    r.check("the plural agrees with the count",
      /2 AI passes/.test(line({ seconds: 0, minutes: 0, aiCalls: 2 })), line({ seconds: 0, minutes: 0, aiCalls: 2 }));
  }

  r.done();
})();
