/* TheraChart file storage backend.

   Bytes that are too big to live inside the synced JSON state / Postgres blob:
   patient attachments (referrals, imaging, scanned charts) and opt-in session-
   audio review segments. Stored out-of-band so they never bloat the database.

     • local  (default) — files under DATA_DIR/files, preserving the key path as
                real subdirectories. Zero-dependency; local dev and demos.
                (Ephemeral on Cloud Run, like the flat DB.)
     • gcs    — Google Cloud Storage, when GCS_BUCKET is set. Cheap (~$0.02/GB),
                durable. Uses the SAME OAuth credential chain as STT/Vertex.

   Keys look like "att/<id>" (attachments) or "audio/<docId>/<seg>.wav" (audio).
   The store keeps only small references; downloads stream through the server so
   they stay behind the login. */

const fs = require("fs");
const path = require("path");

function createFiles() {
  let backend = "local";
  let dir = null;
  let bucket = null;
  let getToken = null;
  let fetchImpl = null;

  async function init(opts = {}) {
    dir = path.join(opts.dataDir || path.join(__dirname, "data"), "files");
    if (opts.bucket && (opts.getToken || opts.client)) {
      backend = "gcs";
      bucket = opts.bucket;
      getToken = opts.getToken;
      fetchImpl = opts.fetch || (typeof fetch !== "undefined" ? fetch : null);
      if (opts.client) { getToken = opts.client.getToken; fetchImpl = opts.client.fetch; } // test seam
    } else {
      backend = "local";
      fs.mkdirSync(dir, { recursive: true });
    }
    return info();
  }

  const gcsBase = "https://storage.googleapis.com";
  const encKey = (k) => encodeURIComponent(k);
  // Local: keep the key's "/" structure as real folders; sanitize each segment.
  const segs = (key) => String(key).split("/").filter(Boolean).map((s) => s.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const localPath = (key) => path.join(dir, ...segs(key));

  async function put(key, buffer, contentType) {
    if (backend === "gcs") {
      const token = await getToken();
      const url = `${gcsBase}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encKey(key)}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType || "application/octet-stream" },
        body: buffer,
      });
      if (!res.ok) throw new Error(`GCS upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { key };
    }
    const p = localPath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buffer);
    return { key };
  }

  // returns { buffer, contentType } or null if missing
  async function get(key) {
    if (backend === "gcs") {
      const token = await getToken();
      const url = `${gcsBase}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encKey(key)}?alt=media`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS download ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get ? res.headers.get("content-type") : null };
    }
    try { return { buffer: fs.readFileSync(localPath(key)), contentType: null }; }
    catch { return null; }
  }

  async function del(key) {
    if (backend === "gcs") {
      const token = await getToken();
      const res = await fetchImpl(`${gcsBase}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encKey(key)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (!res.ok && res.status !== 404) throw new Error(`GCS delete ${res.status}`);
      return;
    }
    try { fs.unlinkSync(localPath(key)); } catch { }
  }

  // List every object whose key starts with `prefix` (e.g. "audio/<docId>/").
  // Returns [{ key, size }]. Prefixes should end in "/" (a folder boundary).
  async function list(prefix) {
    if (backend === "gcs") {
      const token = await getToken();
      const out = [];
      let pageToken = "";
      do {
        const url = `${gcsBase}/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
        const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`GCS list ${res.status}`);
        const data = await res.json();
        for (const it of data.items || []) out.push({ key: it.name, size: Number(it.size) || 0 });
        pageToken = data.nextPageToken || "";
      } while (pageToken);
      return out;
    }
    const startDir = path.join(dir, ...segs(prefix));
    const out = [];
    (function walk(d, keyPrefix) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, keyPrefix + e.name + "/");
        else { let size = 0; try { size = fs.statSync(full).size; } catch { } out.push({ key: keyPrefix + e.name, size }); }
      }
    })(startDir, prefix.endsWith("/") ? prefix : prefix + "/");
    return out;
  }

  function info() { return backend === "gcs" ? { backend, bucket } : { backend, dir }; }

  return { init, put, get, del, list, info };
}

module.exports = createFiles();
module.exports.createFiles = createFiles; // for tests
