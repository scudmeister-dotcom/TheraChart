/* TheraChart AI-payload checker — how much a caller may put in front of the
   model.

   /api/refine and /api/blend-note have always clamped their inputs at the
   boundary. /api/insights and /api/patient-assistant did not: both handed the
   parsed request body straight to the prompt builder, and readBody accepts
   15 MB. That is not a data leak — the chart comes from the caller, so nobody
   reads another clinic's records this way — but 15 MB of prose is roughly a
   million tokens, which FITS inside the model's context window. It is not
   rejected as too long; it is accepted, and billed.

   That is the ordering nothing exercised: every other test sends a chart the
   client built, and the client never builds a big one. So the ceiling was
   whatever the model would accept rather than whatever we meant to pay for.

   Run: node test/aipayload.test.js */

"use strict";

const http = require("http");
const { startServer, reporter } = require("./helpers/server.js");

const r = reporter("AI-payload checker");

/** Stands in for the model, and remembers how much it was asked to read. */
function stubModel() {
  let hits = 0;
  let lastBytes = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      lastBytes = Buffer.byteLength(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        connections: [], redFlags: [], recommendations: [], answer: "ok", citations: [],
      }) }] } }] }));
    });
  });
  return {
    listen: () => new Promise((ok) => srv.listen(0, "127.0.0.1", ok)),
    port: () => srv.address().port,
    reset: () => { hits = 0; lastBytes = 0; },
    hits: () => hits,
    lastBytes: () => lastBytes,
    close: () => new Promise((ok) => srv.close(ok)),
  };
}

/** A chart of `n` visits, each carrying `chars` of prose in every text field. */
const bigChart = (n, chars) => ({
  patient: { age: 44, sex: "F" },
  referral: "x".repeat(chars),
  pmh: "x".repeat(chars),
  docs: Array.from({ length: n }, (_, i) => ({
    date: "2026-01-01", type: "daily",
    subjective: "x".repeat(chars), objective: "x".repeat(chars),
    assessment: "x".repeat(chars), plan: "x".repeat(chars),
    findings: Array.from({ length: 40 }, () => ({ part: "knee", side: "left", summary: "x".repeat(chars) })),
  })),
});

(async () => {
  const stub = stubModel();
  await stub.listen();

  const s = await startServer({
    THERACHART_DEMO_LOGINS: "1",
    GEMINI_API_KEY: "stub-key-not-a-real-one",
    GEMINI_BASE_URL: `http://127.0.0.1:${stub.port()}/v1beta`,
  });
  const maria = await s.call("/api/demo-signin", { method: "POST", body: { userId: "u-maria" } });
  const auth = maria.data && maria.data.token;
  r.check("signed in as a documenting therapist", !!auth, JSON.stringify(maria).slice(0, 140));

  const ask = (path, body) => s.call(path, { method: "POST", token: auth, body });

  /* ---- an ordinary chart still works ---- */
  stub.reset();
  const small = await ask("/api/patient-assistant", {
    chart: bigChart(12, 200), question: "How is the knee trending?",
  });
  r.check("an ordinary 12-visit chart is answered",
    small.status === 200, JSON.stringify({ s: small.status, e: small.data && small.data.error }).slice(0, 160));
  r.check("…and did reach the model", stub.hits() === 1, `${stub.hits()} requests`);
  const honestBytes = stub.lastBytes();

  /* ---- the payload that was never bounded ---- */
  stub.reset();
  /* ~2 MB: comfortably under readBody's 15 MB ceiling, so it is parsed and
     reaches the handler. That gap — parsed, but far more than a chart — is
     exactly the window this clamp closes. Anything over 15 MB was already
     stopped by readBody, which destroys the socket rather than answering. */
  const huge = await ask("/api/patient-assistant", {
    chart: bigChart(90, 500), question: "Summarise everything",
  });
  r.check("an oversized chart is refused", huge.status === 413,
    JSON.stringify({ s: huge.status }).slice(0, 120));
  r.check("…before the model is ever called", stub.hits() === 0, `${stub.hits()} requests`);
  r.check("…with something an administrator can act on",
    typeof huge.data.error === "string" && /retrying in a loop/.test(huge.data.error),
    JSON.stringify(huge.data.error).slice(0, 160));

  /* Same hole, same shape, on the endpoint with the higher daily limit. */
  stub.reset();
  const hugeIns = await ask("/api/insights", {
    current: { subjective: "x".repeat(20000), findings: [], measurements: {} },
    history: bigChart(90, 500).docs,
  });
  r.check("insights refuses an oversized context too", hugeIns.status === 413,
    JSON.stringify({ s: hugeIns.status }).slice(0, 120));
  r.check("…also before the model is called", stub.hits() === 0, `${stub.hits()} requests`);

  /* ---- the clamp, not just the refusal ----
     A payload that passes the total budget can still be pathological in shape:
     many visits, each of ordinary size. The per-node caps are what stop that
     reaching the model, so assert on what the model was actually sent. */
  stub.reset();
  const wide = await ask("/api/patient-assistant", {
    chart: bigChart(300, 60), question: "anything",
  });
  r.check("a chart with 300 visits is either refused or clamped",
    wide.status === 413 || stub.hits() === 1,
    JSON.stringify({ s: wide.status, hits: stub.hits() }));
  if (wide.status === 200) {
    r.check("…and what reached the model is bounded, not proportional to what was sent",
      stub.lastBytes() < honestBytes * 12,
      `${stub.lastBytes()} bytes sent to the model vs ${honestBytes} for an honest chart`);
  }

  /* ---- the clamp must not corrupt an honest chart ----
     Bounding is only safe if a normal payload passes through unchanged; a
     clamp that silently drops a visit would lose clinical content. */
  stub.reset();
  const normal = await ask("/api/patient-assistant", {
    chart: { patient: { age: 40, sex: "M" }, referral: "right shoulder pain", pmh: "none",
             docs: [{ date: "2026-08-01", type: "eval", subjective: "sore for two weeks",
                      assessment: "rotator cuff tendinopathy", findings: [] }] },
    question: "what is going on",
  });
  r.check("an honest chart is answered normally", normal.status === 200,
    JSON.stringify({ s: normal.status }));

  await s.stop();
  await stub.close();
  r.done();
})();
