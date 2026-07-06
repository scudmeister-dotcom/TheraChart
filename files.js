/* TheraChart file storage backend.

   Patient attachments (referrals, imaging, scanned old charts) and, later,
   session audio are BYTES — too big to live inside the synced JSON state /
   Postgres blob, where they'd bloat every save. This module stores those bytes
   out-of-band:

     • local  (default) — files under DATA_DIR/files. Zero-dependency; local dev
                and demos. (Ephemeral on Cloud Run, like the flat DB.)
     • gcs    — Google Cloud Storage, when GCS_BUCKET is set. Cheap (~$0.02/GB),
                durable, and keeps the database small + fast. Uses the SAME OAuth
                credential chain as STT/Vertex (no key files on Cloud Run).

   The store keeps only a small reference per attachment ({ id, name, type, size,
   key }) — never the bytes. Downloads are streamed back through the server so
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

  // Local key → a safe flat filename under DATA_DIR/files.
  const localPath = (key) => path.join(dir, String(key).replace(/[^a-zA-Z0-9._-]/g, "_"));
  const gcsBase = "https://storage.googleapis.com";

  async function put(key, buffer, contentType) {
    if (backend === "gcs") {
      const token = await getToken();
      const url = `${gcsBase}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType || "application/octet-stream" },
        body: buffer,
      });
      if (!res.ok) throw new Error(`GCS upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { key };
    }
    fs.writeFileSync(localPath(key), buffer);
    return { key };
  }

  // returns { buffer, contentType } or null if missing
  async function get(key) {
    if (backend === "gcs") {
      const token = await getToken();
      const url = `${gcsBase}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS download ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType: res.headers.get ? res.headers.get("content-type") : null };
    }
    try { return { buffer: fs.readFileSync(localPath(key)), contentType: null }; }
    catch { return null; }
  }

  async function del(key) {
    if (backend === "gcs") {
      const token = await getToken();
      const url = `${gcsBase}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;
      const res = await fetchImpl(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (!res.ok && res.status !== 404) throw new Error(`GCS delete ${res.status}`);
      return;
    }
    try { fs.unlinkSync(localPath(key)); } catch { }
  }

  function info() { return backend === "gcs" ? { backend, bucket } : { backend, dir }; }

  return { init, put, get, del, info };
}

module.exports = createFiles();
module.exports.createFiles = createFiles; // for tests
