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

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
