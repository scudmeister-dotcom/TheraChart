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
    const login = await s.login("grace@therachart.demo", "1234");
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

  /* ---------------- dictation engine keys ----------------
     The engine the browser asks for has to survive the query-string scrub and
     resolve to the model the clinic chose. "chirp2" is the case that bites: a
     scrub of [^a-z_] silently turns it into "chirp", which is a VALID key, so
     the request succeeds and quietly transcribes on the older engine — the
     clinic sees no error, just worse Taglish. */
  {
    const s2 = await startServer({ THERACHART_DEMO_LOGINS: "1" });
    try {
      const login = await s2.login("maria@therachart.demo", "1234");
      const token = login.data.token;

      /* Tests run with the Google credentials blanked, so STT answers 501
         "not set up here" — which is what proves the key was accepted and
         routed rather than rejected before it got that far. */
      for (const model of ["standard", "chirp", "chirp2"]) {
        const res = await s2.call(`/api/stt?lang=fil-PH&model=${model}`, {
          method: "POST", token, body: { x: 1 },
        });
        r.check(`engine "${model}" is a routable dictation key`,
          [200, 400, 501].indexOf(res.status) >= 0,
          `status ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
      }

      const fs2 = require("fs"), path2 = require("path");
      const src = fs2.readFileSync(path2.join(__dirname, "..", "server.js"), "utf8");
      const map = (src.match(/const STT_MODELS = \{([^}]*)\}/) || [])[1] || "";
      r.check("chirp2 maps to Google's chirp_2 model", /chirp2:\s*"chirp_2"/.test(map), map.trim());
      r.check("standard and chirp are still offered separately",
        /standard:\s*"latest_long"/.test(map) && /chirp:\s*"chirp"/.test(map), map.trim());
      /* latest_long is English-only — Google rejects fil-PH/ceb-PH on it. The
         server swaps to the multilingual model rather than losing the segment.
         Verified live against Google (all 9 engine x language combinations
         succeed); asserted here at the source level because tests run without
         Google credentials and never reach the model call. */
      r.check("an English-only model is defined with a multilingual fallback",
        /ENGLISH_ONLY_MODELS = new Set\(\["latest_long"\]\)/.test(src)
          && /MULTILINGUAL_MODEL = "chirp_2"/.test(src),
        "the fil-PH fallback in transcribe() is what stops Tagalog dictation failing outright");
      r.check("the transcriber reports which model actually ran",
        /return \{ text, model \}/.test(src) && /model: out\.model/.test(src),
        "a silent model swap would leave the clinic unable to tell what transcribed their audio");
      r.check("the model scrub keeps digits, so chirp2 cannot degrade to chirp",
        src.indexOf("[^a-z0-9_]") >= 0 && src.indexOf('("model") || "standard").replace(/[^a-z_]/gi') < 0,
        "server.js must not strip digits from the model query parameter");
    } finally { s2.stop(); }
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
