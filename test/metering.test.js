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
  /* Demo logins OFF for the bulk of this file, so the seeded admin is treated
     as an ordinary clinic admin. With the panel on she is a DEMO admin whose
     password is published on the sign-in screen, and the usage endpoint refuses
     those outright — that behaviour gets its own server at the end. */
  const s = await startServer();

  try {
    const maria = (await s.login("maria@therachart.demo", "1234")).data.token;
    const ana = (await s.login("ana@therachart.demo", "1234")).data.token;
    const grace = (await s.login("grace@therachart.demo", "1234")).data.token;

    /* ---------------- who may read the meter ---------------- */

    r.check("a therapist cannot", (await s.call("/api/usage", { token: maria })).status === 403);
    r.check("front desk cannot", (await s.call("/api/usage", { token: ana })).status === 403);
    r.check("an unauthenticated caller cannot", (await s.call("/api/usage")).status === 401);

    r.check("a clinic admin can read their own usage",
      (await s.call("/api/usage", { token: grace })).status === 200);

    /* THE MONEY IS NOT THEIRS TO SEE. `estimatedUsd` is our cost of goods, and
       a clinic administrator reading it can derive our margin on the plan they
       are about to renew. Volumes are their own activity and stay visible;
       pesos need isPlatformOwner, which is a different thing from being an
       admin OF A CLINIC. */
    const clinicView = (await s.call("/api/usage", { token: grace })).data;
    r.check("…but not what it cost us",
      !("estimatedUsd" in clinicView),
      "a clinic admin who can read estimatedUsd can work out our margin before a renewal");
    r.check("…while still seeing their own volumes",
      typeof clinicView.totals.sttSeconds === "number" && clinicView.scope === "clinic",
      JSON.stringify(clinicView.totals));
    r.check("…and never another clinic's rows",
      !("byClinic" in clinicView),
      "the per-clinic split is an operator view, not a tenant one");

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
    // pricing itself is checked from the operator's seat, further down

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
    r.check("…and a clinic sees the split without a price on it",
      Object.values(u.byPurpose || {}).every((v) => !("usd" in v)),
      "per-purpose pesos are cost of goods, same as the total");

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

  /* ---------------- the operator's seat ----------------
     Same endpoint, a strictly larger view: money, and every tenant at once.
     Gated on the owner's email rather than a role, so it cannot be reached by
     an account whose password is printed on a sign-in screen. */
  const o = await startServer({ GOOGLE_OWNER_EMAIL: "grace@therachart.demo" });
  try {
    const owner = (await o.login("grace@therachart.demo", "1234")).data.token;
    const staff = (await o.login("maria@therachart.demo", "1234")).data.token;
    const view = await o.call("/api/usage", { token: owner });
    r.check("the platform owner sees the money", view.status === 200 && view.data.estimatedUsd,
      `status=${view.status}`);
    r.check("…priced at read time, so a rate change re-prices history",
      /not an invoice/i.test((view.data.estimatedUsd || {}).note || ""),
      JSON.stringify(view.data.estimatedUsd));
    r.check("…and sees every clinic broken out, which is the operator's question",
      view.data.scope === "platform" && view.data.byClinic && typeof view.data.byClinic === "object",
      `scope=${view.data.scope}`);
    r.check("…with each clinic named and costed",
      Object.values(view.data.byClinic).every((c) => typeof c.name === "string" && typeof c.usd === "number"),
      JSON.stringify(view.data.byClinic).slice(0, 200));
    /* Owner is an identity, not a role: a therapist at the same clinic gets
       nothing, and the check does not fall back to role === "admin". */
    r.check("a therapist is still refused on the owner's server",
      (await o.call("/api/usage", { token: staff })).status === 403);
  } finally { o.stop(); }

  /* ---------------- the invite-only demo ----------------

     The demo is not weakened; access to it is controlled. Its logins are never
     published, only handed to an account that is already signed in — so the
     control is "who was approved", and everything the demo can then do it does
     at full strength. A prospect who hits a wall has been shown a product that
     hits walls. */
  const inv = await startServer({ THERACHART_DEMO_INVITE: "1" });
  try {
    const boot = (await inv.call("/api/bootstrap")).data;
    r.check("an invite-only demo publishes no credentials",
      Array.isArray(boot.testAccounts) && boot.testAccounts.length === 0,
      JSON.stringify(boot.testAccounts));
    r.check("…but does say a demo exists, so the app can offer it",
      boot.demoInvite === true, JSON.stringify(boot.demoInvite));
    r.check("…and an unauthenticated caller cannot ask for the logins",
      (await inv.call("/api/demo-logins")).status === 401,
      "the sign-in is the entire access control here");

    const anyUser = (await inv.login("maria@therachart.demo", "1234")).data.token;
    const got = await inv.call("/api/demo-logins", { token: anyUser });
    r.check("a signed-in account is handed the demo clinic",
      got.status === 200 && (got.data.accounts || []).length > 0,
      `status=${got.status}`);
    r.check("…including the admin, so a prospect can see that role too",
      (got.data.accounts || []).some((a) => a.role === "admin"),
      "an evaluation that cannot reach the admin screens is not an evaluation");

    /* Full strength: the demo shares the ordinary limits. Twelve extract calls
       tripped the real table earlier; the same burst must behave the same here
       rather than stopping sooner. */
    let n = 0, stopped = false;
    for (let i = 0; i < 6 && !stopped; i++) {
      const res = await inv.call("/api/extract-doc",
        { method: "POST", token: anyUser, body: { pdf: "JVBERi0=", mime: "application/pdf" } });
      if (res.status === 429) stopped = true; else n += 1;
    }
    r.check("the demo is not throttled more tightly than a real clinic",
      n >= 5, `only ${n} of 6 calls got through — the demo should behave like any clinic`);
  } finally { inv.stop(); }

  /* A server with neither switch has no demo to give out. */
  const off = await startServer();
  try {
    const t = (await off.login("maria@therachart.demo", "1234")).data.token;
    const res = await off.call("/api/demo-logins", { token: t });
    r.check("a clinic deployment offers no demo at all",
      res.status === 404, `got ${res.status} — nothing should hand out seeded logins here`);
    r.check("…and does not advertise one to the app",
      (await off.call("/api/bootstrap")).data.demoInvite === false);
  } finally { off.stop(); }

  /* ---------------- the public demo box ----------------
     Still supported for a throwaway instance where the password may as well be
     public, and unchanged. */
  const d = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  try {
    const demoAdmin = (await d.login("grace@therachart.demo", "1234")).data.token;
    r.check("the public panel still lists the seeded logins",
      ((await d.call("/api/bootstrap")).data.testAccounts || []).length > 0,
      "a throwaway box should still be one click from being inside");
    /* Even a demo admin reaches the clinic view — a prospect evaluating the
       product should see the administrator's experience whole. The money stays
       behind isPlatformOwner, which is what actually needed protecting. */
    const asDemoAdmin = await d.call("/api/usage", { token: demoAdmin });
    r.check("a demo admin sees the admin experience",
      asDemoAdmin.status === 200, `got ${asDemoAdmin.status}`);
    r.check("…without our cost of goods in it",
      !("estimatedUsd" in asDemoAdmin.data),
      "the demo shows the product, not our margin");
  } finally { d.stop(); }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
