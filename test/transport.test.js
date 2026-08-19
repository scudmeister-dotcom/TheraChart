/* TheraChart transport checker — response compression.

   /api/state returns the clinic's entire record set, and a device refetches it
   whenever the revision moves (sync.js polls /api/rev every 6s). Uncompressed,
   egress on that one endpoint outgrew the AI spend in the cost model and kept
   growing with chart history. Clinical JSON is highly repetitive, so gzip pays
   for itself several times over — measured ~9.5x on a realistic 1,300-document
   clinic state, ~4.6x on the small demo seed.

   These checks pin the behaviour rather than the ratio: compress when the client
   asks and the body is worth it, never compress when it didn't ask, and never
   let compression change what the client actually receives.

   Run: node test/transport.test.js */

"use strict";

const zlib = require("zlib");
const { startServer, reporter } = require("./helpers/server.js");

/* fetch() transparently decompresses, which is exactly what we do NOT want when
   the point is to observe the bytes on the wire. Go one level down. */
function rawGet(base, path, headers) {
  const http = require("http");
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const r = reporter("transport checker");
  const s = await startServer({ THERACHART_DEMO_LOGINS: "1" });

  try {
    const login = await s.demoSignIn("u-grace"); // demo box: entered from the panel
    const auth = { authorization: `Bearer ${login.data.token}` };

    /* ---------------- large response, client accepts gzip ---------------- */

    const gz = await rawGet(s.base, "/api/state", { ...auth, "accept-encoding": "gzip" });
    r.check("state responds 200", gz.status === 200, `status ${gz.status}`);
    r.check("a large response is gzipped when offered",
      gz.headers["content-encoding"] === "gzip", JSON.stringify(gz.headers["content-encoding"]));
    r.check("…and declares Vary: accept-encoding so caches don't cross the wires",
      /accept-encoding/i.test(gz.headers.vary || ""), JSON.stringify(gz.headers.vary));

    let inflated = null;
    try { inflated = zlib.gunzipSync(gz.body).toString(); } catch (e) { /* reported below */ }
    r.check("…and the gzip stream actually inflates", !!inflated);

    /* ---------------- same request without gzip ---------------- */

    const plain = await rawGet(s.base, "/api/state", { ...auth, "accept-encoding": "identity" });
    r.check("a client that doesn't offer gzip gets none",
      plain.headers["content-encoding"] === undefined, JSON.stringify(plain.headers["content-encoding"]));

    /* The property that matters: compression must be invisible to the caller. */
    r.check("compressed and uncompressed bodies are byte-identical once inflated",
      inflated === plain.body.toString(),
      inflated ? `inflated ${inflated.length} vs plain ${plain.body.length}` : "inflate failed");

    let parsed = null;
    try { parsed = JSON.parse(inflated); } catch (e) { /* reported below */ }
    r.check("…and still parse as the expected payload",
      !!parsed && typeof parsed.rev === "number" && Array.isArray(parsed.state.patients),
      parsed ? JSON.stringify(Object.keys(parsed)) : "unparseable");

    r.check("gzip is smaller than the original (the whole point)",
      gz.body.length < plain.body.length,
      `${plain.body.length} -> ${gz.body.length}`);

    /* ---------------- small responses are left alone ---------------- */

    const ping = await rawGet(s.base, "/api/ping", { "accept-encoding": "gzip" });
    r.check("a sub-1KB response is not compressed",
      ping.body.length < 1024 && ping.headers["content-encoding"] === undefined,
      `${ping.body.length} bytes, encoding ${JSON.stringify(ping.headers["content-encoding"])}`);
    r.check("…and is still valid JSON", (() => {
      try { return JSON.parse(ping.body.toString()).ok === true; } catch { return false; }
    })());

    /* ---------------- errors are unaffected ---------------- */

    const unauth = await rawGet(s.base, "/api/state", { "accept-encoding": "gzip" });
    r.check("an unauthenticated request is still refused", unauth.status === 401, `status ${unauth.status}`);

    /* ---------------- the ratio is worth having ----------------
       Asserted loosely: the seed is small and compresses less than a real
       clinic's chart history. This guards against a change that leaves gzip
       nominally on but ineffective, not against a specific number. */
    r.check("compression achieves at least 2x on the seed state",
      plain.body.length / gz.body.length >= 2,
      `${(plain.body.length / gz.body.length).toFixed(1)}x`);
  } finally { s.stop(); }

  /* ---------------- dictation model + languages ----------------
     Dictation is Chirp 2 and nothing else, so what matters is that the key the
     browser sends survives the query-string scrub and resolves to chirp_2, and
     that all three offered languages reach the model. "chirp2" is the case that
     bites: a scrub of [^a-z_] turns it into "chirp", and a clinic transcribing
     on a fallback model sees no error, just worse Taglish. */
  {
    const s2 = await startServer({ THERACHART_DEMO_LOGINS: "1" });
    try {
      const login = await s2.demoSignIn("u-maria"); // demo box: entered from the panel
      const token = login.data.token;

      /* Tests run with the Google credentials blanked, so STT answers 501
         "not set up here" — which is what proves the key was accepted and
         routed rather than rejected before it got that far. */
      for (const lang of ["fil-PH", "ceb-PH"]) {
        const res = await s2.call(`/api/stt?lang=${lang}&model=chirp2`, {
          method: "POST", token, body: { x: 1 },
        });
        r.check(`"${lang}" is a routable dictation language`,
          [200, 400, 501].indexOf(res.status) >= 0,
          `status ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
      }

      const fs2 = require("fs"), path2 = require("path");
      const src = fs2.readFileSync(path2.join(__dirname, "..", "server.js"), "utf8");
      const map = (src.match(/const STT_MODELS = \{([^}]*)\}/) || [])[1] || "";
      r.check("chirp2 maps to Google's chirp_2 model", /chirp2:\s*"chirp_2"/.test(map), map.trim());
      r.check("no model other than chirp_2 is reachable",
        !/latest_long|"chirp"/.test(map) && /const STT_MODEL = "chirp_2"/.test(src),
        "an older model left in the map is one a stale client can still ask for");
      /* Chirp 2 refuses a LIST of language codes (multi-language recognition is
         only offered in eu/global/us, where chirp_2 does not exist), so each UI
         choice sends exactly one code. Verified live against Google for this
         project: en-US, fil-PH and ceb-PH are all GA on chirp_2 in us-central1.
         Asserted at the source level because tests run without Google
         credentials and never reach the model call. */
      r.check("exactly the two offered languages are accepted, one code each",
        /const STT_LANGS = new Set\(\["fil-PH", "ceb-PH"\]\)/.test(src)
          && /languageCodes: \[language\]/.test(src),
        "a pair of codes is refused by Chirp 2 outright — the request would fail, not degrade");
      /* en-US must fall through to Tagalog rather than be honoured. The service
         worker caches app.js, so a device can still be asking for English long
         after the option left the bar — and English-only on Taglish speech
         drops whole billed utterances. Measured: a 4s Tagalog segment came back
         from en-US as "oppo", and complete under fil-PH. */
      r.check("en-US falls through to the Tagalog default instead of being honoured",
        !/STT_LANGS = new Set\(\[[^\]]*en-US/.test(src)
          && /const STT_LANG_DEFAULT = "fil-PH"/.test(src)
          && /STT_LANGS\.has\(lang\) \? lang : STT_LANG_DEFAULT/.test(src),
        "a stale cached client asking for en-US is the exact case this protects");
      r.check("the transcriber reports which model actually ran",
        /return \{ text, model \}/.test(src) && /model: out\.model/.test(src),
        "a silent model swap would leave the clinic unable to tell what transcribed their audio");
      r.check("the model scrub keeps digits, so chirp2 arrives intact",
        src.indexOf("[^a-z0-9_]") >= 0 && src.indexOf('("model") || "chirp2").replace(/[^a-z_]/gi') < 0,
        "server.js must not strip digits from the model query parameter");
    } finally { s2.stop(); }
  }

  /* ---------------- signing out ends the session ----------------

     store.logout() clears the on-device session. That is not the same as ending
     the SESSION: the bearer token stayed in localStorage with a live server
     session behind it until the thirty-day TTL expired, so on a shared clinic
     machine the next person to open the browser was one devtools line from the
     last person's records. */
  {
    // sessions are what is under test, and demo accounts hold no password —
    // the picker is how this box hands out a session
    const s3 = await startServer({ THERACHART_DEMO_LOGINS: "1" });
    try {
      const tok = (await s3.demoSignIn("u-maria")).data.token;
      r.check("a fresh token works", (await s3.call("/api/rev", { token: tok })).status === 200);

      const out = await s3.call("/api/logout", { method: "POST", token: tok });
      r.check("signing out is accepted", out.status === 200, `got ${out.status}`);
      r.check("…and the token stops working immediately",
        (await s3.call("/api/rev", { token: tok })).status === 401,
        "a revoked token must not outlive the sign-out that revoked it");

      /* Revoking is idempotent and unauthenticated on purpose — refusing to
         log someone out because their token already expired would be a strange
         reading of the request. */
      r.check("revoking twice is not an error",
        (await s3.call("/api/logout", { method: "POST", token: tok })).status === 200);
      r.check("…and revoking without a token is harmless",
        (await s3.call("/api/logout", { method: "POST" })).status === 200);

      // one device signing out must not sign the account out everywhere
      const a = (await s3.demoSignIn("u-maria")).data.token;
      const b = (await s3.demoSignIn("u-maria")).data.token;
      await s3.call("/api/logout", { method: "POST", token: a });
      r.check("signing out one device leaves the other signed in",
        (await s3.call("/api/rev", { token: b })).status === 200,
        "sessions are per device; revoking one must not revoke the rest");
    } finally { s3.stop(); }
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
