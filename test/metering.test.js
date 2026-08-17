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

    /* ---------------- which feature spent it ----------------

       A total that only goes up tells you a bill grew. It cannot tell you
       whether documentation got busier or one screen started retrying in a
       loop, and those want different responses — so spend is attributed to the
       feature that incurred it, in pesos rather than call counts. A cheap
       feature called constantly and an expensive one called twice look
       identical if you only count calls. */
    r.check("usage attributes spend to the feature that caused it",
      u.byPurpose && typeof u.byPurpose === "object",
      "a bill you cannot attribute is a bill you cannot act on");
    r.check("…with STT's own purpose bucket kept out of the Gemini split",
      !("stt" in (u.byPurpose || {})),
      "byPurpose covers Gemini calls; STT has its own seconds meter");
    /* Verified live against Vertex rather than here, because these tests run
       with the AI credentials blanked so no check makes a billable call:
       three different features attributed cleanly, and every peso of NEW spend
       landed in a purpose bucket (measured as a delta — rows written before
       this split existed have no bucket, and a total that includes them will
       not reconcile against the parts). What is checkable without credentials
       is the shape. */
    if (Object.keys(u.byPurpose || {}).length) {
      const anyP = Object.values(u.byPurpose)[0];
      r.check("…priced per purpose, not just counted",
        typeof anyP.usd === "number" && typeof anyP.calls === "number",
        JSON.stringify(anyP));
      const sumUsd = Object.values(u.byPurpose).reduce((a, v) => a + v.usd, 0);
      r.check("…and no purpose claims more than the Gemini total",
        sumUsd <= u.estimatedUsd.gemini + 0.001,
        `purposes sum to ${sumUsd} vs total ${u.estimatedUsd.gemini}`);
    }
    // (no else: an empty split is the expected state here, and r.note fails the run)

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

    /* ---------------- rate limits ----------------

       Every AI route checked a role and none checked a rate, so a retry loop
       could call Gemini as fast as the network allowed. These are runaway
       detectors rather than quotas — set several times above the busiest
       plausible clinic, because a therapist blocked mid-visit is a worse
       outcome than the money.

       `extract` has the tightest limit (5/min — whole PDFs, the priciest single
       call), so it is the cheapest one to prove the mechanism against. */
    const extract = () => s.call("/api/extract-doc", { method: "POST", token: maria, body: { pdf: "JVBERi0=", mime: "application/pdf" } });
    let sawLimit = null, allowed = 0;
    for (let i = 0; i < 12 && !sawLimit; i++) {
      const res = await extract();
      if (res.status === 429) sawLimit = res; else allowed += 1;
    }
    r.check("a burst of AI calls is eventually refused", !!sawLimit,
      `12 extract calls all went through — nothing is bounding a retry loop`);
    if (sawLimit) {
      r.check("…only after a generous number get through",
        allowed >= 5, `only ${allowed} allowed before the limit — too tight for real work`);
      r.check("…with a 429 and a retry-after the client can act on",
        sawLimit.status === 429 && typeof sawLimit.data.retryAfter === "number" && sawLimit.data.retryAfter > 0,
        JSON.stringify(sawLimit.data));
      r.check("…and a message that tells a clinician their work is safe",
        /nothing has been lost/i.test(sawLimit.data.error || ""),
        `a limit hit mid-visit must not read like data loss: "${sawLimit.data.error}"`);
    }

    /* The limit is per clinic, not global — one tenant hitting a ceiling must
       never stop another from documenting. */
    if (fresh.status === 200) {
      const otherClinic = await s.call("/api/extract-doc",
        { method: "POST", token: fresh.data.token, body: { pdf: "JVBERi0=", mime: "application/pdf" } });
      r.check("one clinic's limit does not block another's",
        otherClinic.status !== 429,
        `a second clinic got ${otherClinic.status} while the first was rate-limited`);
    }

    /* Limits must not leak across features: exhausting PDF import cannot stop
       a therapist finishing the note in front of them. */
    const refineAfter = await s.call("/api/refine", { method: "POST", token: maria, body: { transcript: ["Patient reports less pain today."] } });
    r.check("exhausting one feature does not block a different one",
      refineAfter.status !== 429,
      `refine returned ${refineAfter.status} because extract-doc was exhausted`);
  } finally { s.stop(); }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
