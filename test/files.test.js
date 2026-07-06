/* TheraChart files checker — the attachment storage backend: the local backend
   round-trips bytes, and the GCS backend hits the right Cloud Storage URLs with
   a Bearer token (verified through a mock fetch — no real bucket needed).
   Run: node test/files.test.js */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFiles } = require("../files.js");

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

// A mock GCS: records requests and simulates an object store.
function mockGcs() {
  const objects = new Map();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", auth: (opts.headers || {}).authorization });
    if (/\/upload\/storage\/v1\/b\//.test(url)) {
      const name = decodeURIComponent(url.match(/[?&]name=([^&]+)/)[1]);
      objects.set(name, Buffer.from(opts.body));
      return { ok: true, status: 200, async text() { return ""; } };
    }
    const m = url.match(/\/b\/[^/]+\/o\/([^?]+)/);
    const key = m && decodeURIComponent(m[1]);
    if ((opts.method || "GET") === "DELETE") { objects.delete(key); return { ok: true, status: 200 }; }
    if (!objects.has(key)) return { ok: false, status: 404, async text() { return "not found"; } };
    const buf = objects.get(key);
    return { ok: true, status: 200, headers: { get: () => "application/pdf" }, async arrayBuffer() { return buf; } };
  };
  return { objects, calls, client: { getToken: async () => "TESTTOKEN", fetch: fetchImpl } };
}

(async () => {
  // ---- local backend ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-files-"));
  const lf = createFiles();
  const li = await lf.init({ dataDir: dir });
  check("local backend selected without a bucket", li.backend === "local", JSON.stringify(li));
  await lf.put("att/f-1", Buffer.from("hello pdf bytes"), "application/pdf");
  const got = await lf.get("att/f-1");
  check("local get round-trips the bytes", got && got.buffer.toString() === "hello pdf bytes");
  check("missing local key returns null", (await lf.get("att/nope")) === null);
  await lf.del("att/f-1");
  check("local del removes the file", (await lf.get("att/f-1")) === null);

  // ---- gcs backend (mock) ----
  const gcs = mockGcs();
  const gf = createFiles();
  const gi = await gf.init({ dataDir: dir, bucket: "therachart-files", client: gcs.client });
  check("gcs backend selected with bucket + client", gi.backend === "gcs" && gi.bucket === "therachart-files");
  await gf.put("att/f-2", Buffer.from("scan bytes"), "application/pdf");
  const up = gcs.calls.find((c) => /\/upload\//.test(c.url));
  check("upload hits the GCS upload endpoint", !!up && /uploadType=media&name=att%2Ff-2/.test(up.url), up && up.url);
  check("upload sends a Bearer token", up && up.auth === "Bearer TESTTOKEN");
  check("object landed in the (mock) bucket", gcs.objects.get("att/f-2").toString() === "scan bytes");
  const g2 = await gf.get("att/f-2");
  check("gcs get round-trips the bytes", g2 && g2.buffer.toString() === "scan bytes");
  check("gcs get uses alt=media + Bearer", gcs.calls.some((c) => /alt=media/.test(c.url) && c.auth === "Bearer TESTTOKEN"));
  check("gcs missing key returns null", (await gf.get("att/missing")) === null);
  await gf.del("att/f-2");
  check("gcs del removes the object", !gcs.objects.has("att/f-2"));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`TheraChart files checker: ${passed}/${passed + failures.length} checks passed`);
  if (failures.length) { console.log("\n" + failures.join("\n")); process.exit(1); }
})().catch((e) => { console.error("files test crashed:", e); process.exit(1); });
