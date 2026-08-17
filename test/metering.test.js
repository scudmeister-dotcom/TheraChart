/* TheraChart usage-metering checker.

   Nothing in this codebase used to record what an AI call cost, so every cost
   figure was derived from list prices and nothing was ever reconciled against a
   bill. That made a runaway tenant invisible and a usage-based price unsellable.

   These checks pin the properties that make a meter trustworthy: it counts the
   right thing, it separates thinking from answer tokens (thinking is the
   dominant cost and the lever we tune), it is per clinic, and one clinic can
   never read another's volumes.

   Run: node test/metering.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

/* A 1-second 16kHz/16-bit/mono WAV = 44-byte header + 32000 bytes of samples. */
function wav(seconds) {
  const bytes = Math.round(32000 * seconds);
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF", 0); buf.write("WAVE", 8); buf.write("fmt ", 12); buf.write("data", 36);
  buf.writeUInt32LE(bytes, 40);
  return buf;
}

(async () => {
  const r = reporter("metering checker");
  const s = await startServer({ THERACHART_DEMO_LOGINS: "1" });

  try {
    const maria = (await s.login("maria@therachart.demo", "1234")).data.token;
    const ana = (await s.login("ana@therachart.demo", "1234")).data.token;
    const grace = (await s.login("grace@therachart.demo", "1234")).data.token;

    /* ---------------- who may read the meter ---------------- */

    r.check("an admin can read usage", (await s.call("/api/usage", { token: grace })).status === 200);
    r.check("a therapist cannot", (await s.call("/api/usage", { token: maria })).status === 403);
    r.check("front desk cannot", (await s.call("/api/usage", { token: ana })).status === 403);
    r.check("an unauthenticated caller cannot", (await s.call("/api/usage")).status === 401);

    /* ---------------- STT seconds are counted, not estimated ----------------
       Tests run without Google credentials, so transcription itself fails with
       501 — which is exactly the case that matters: the audio was still sent,
       so it must still be metered. A meter that only counts successes
       understates the bill. */

    const before = (await s.call("/api/usage", { token: grace })).data.totals.sttSeconds;

    // the helper posts JSON; STT takes raw audio, so go one level down
    const http = require("http");
    const rawPost = (buf) => new Promise((resolve) => {
      const u = new URL(s.base + "/api/stt?lang=en-US&model=chirp2");
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: "POST", headers: { authorization: `Bearer ${maria}`, "content-type": "application/octet-stream", "content-length": buf.length } },
        (res) => {
          let body = "";
          res.on("data", (d) => { body += d; });
          res.on("end", () => { let data = {}; try { data = JSON.parse(body); } catch (_) { } resolve({ status: res.statusCode, data }); });
        });
      req.on("error", () => resolve({ status: 0, data: {} }));
      req.end(buf);
    });

    await rawPost(wav(3));
    await rawPost(wav(2));
    // 0.4s must bill as a whole second — Google rounds every request UP
    const short = await rawPost(wav(0.4));

    /* The chart records what a visit's dictation cost from the figure the
       SERVER returns, not from the client's own count of voiced milliseconds —
       only one of those is the number on the invoice. A 501 is the exception:
       it means Cloud STT was never configured, so the audio never reached
       Google and nothing was billed. Tests run without credentials, so that is
       the path exercised here. */
    r.check("a 501 does not report billed seconds",
      short.status === 501 && !("billedSeconds" in short.data),
      `status=${short.status} body=${JSON.stringify(short.data)} — audio that never reached Google must not land on a visit`);

    const after = (await s.call("/api/usage", { token: grace })).data;
    const delta = after.totals.sttSeconds - before;
    r.check("STT seconds are metered from the audio actually sent",
      delta === 6, `expected 3+2+1=6 billed seconds, got ${delta}`);
    r.check("…including a sub-second clip, rounded up like Google does",
      delta >= 6, `a 0.4s clip must count as 1s, not 0`);
    r.check("…and audio is metered even when transcription fails",
      after.totals.sttCalls >= 3, `calls=${after.totals.sttCalls}`);

    /* ---------------- the shape a bill can be explained from ---------------- */

    const u = (await s.call("/api/usage", { token: grace })).data;
    r.check("usage reports a day-by-day breakdown", u.byDay && typeof u.byDay === "object");
    r.check("…and separates thinking tokens from answer tokens",
      "geminiThinking" in u.totals && "geminiOut" in u.totals,
      "thinking is the dominant cost and the lever we tune — folding it into output hides that");
    r.check("…and prices it at read time rather than storing a stale figure",
      u.estimatedUsd && typeof u.estimatedUsd.total === "number" && /not an invoice/i.test(u.estimatedUsd.note || ""),
      JSON.stringify(u.estimatedUsd));
    r.check("…with STT priced from the metered seconds",
      Math.abs(u.estimatedUsd.stt - (u.totals.sttSeconds / 60) * 0.016) < 1e-6,
      `${u.estimatedUsd.stt} vs ${(u.totals.sttSeconds / 60) * 0.016}`);

    const windowed = await s.call("/api/usage?days=1", { token: grace });
    r.check("the window is selectable", windowed.status === 200 && windowed.data.days === 1);
    const clamped = await s.call("/api/usage?days=99999", { token: grace });
    r.check("…and clamped so one request can't scan forever", clamped.data.days <= 365, `${clamped.data.days}`);

    /* ---------------- tenancy ----------------
       u-fresh lives in its own clinic. Its admin must see a meter of its own,
       not the demo clinic's. */
    const fresh = await s.login("fresh@therachart.demo", "1234");
    if (fresh.status === 200) {
      const other = await s.call("/api/usage", { token: fresh.data.token });
      r.check("another clinic's admin sees only their own usage",
        other.status === 200 && other.data.totals.sttSeconds === 0,
        `saw ${other.data.totals.sttSeconds}s from a clinic that sent no audio`);
    } else {
      r.note(`could not sign in as the second clinic's admin (status ${fresh.status})`);
    }
  } finally { s.stop(); }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
