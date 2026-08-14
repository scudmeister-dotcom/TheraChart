/* TheraChart persistence backend.

   The app's data layer (store.js) treats storage as a SYNCHRONOUS key→string
   map (getItem/setItem/removeItem). Locally that's a flat file on disk. On
   Cloud Run that disk is EPHEMERAL — it resets on every deploy, restart, or
   scale event — so records would vanish. This module keeps the same synchronous
   interface but lets the durable backend be either:

     • file      (default) — one file per key under DATA_DIR. Zero-dependency,
                  exactly today's behavior. Used for local dev and demos.
     • postgres  — set DATABASE_URL. Values live in a tiny `kv` table so they
                  survive Cloud Run restarts. Because store.js writes
                  synchronously but pg is async, Postgres uses a read-through /
                  write-behind cache: reads are served from memory (preloaded at
                  init), writes update memory immediately and are flushed to the
                  database in the background (and on shutdown).

   Only the three server-side blobs go through here: the main store ("store"),
   the sync revision ("rev"), and device sessions ("sessions"). The `pg` package
   is required lazily, so nothing is needed unless DATABASE_URL is set.

   NOTE (single-instance): the whole store is one row, so this assumes ONE writer.
   Deploy Cloud Run with `--max-instances 1` until the schema is normalized. */

const fs = require("fs");
const path = require("path");

// Stable, human-readable filenames for the file backend (unchanged from the
// original server so existing local data keeps working with no migration).
const FILE_NAMES = { store: "therachart.json", rev: "rev", sessions: "sessions.json" };
const KEYS = Object.keys(FILE_NAMES);

const FLUSH_DEBOUNCE_MS = 250; // coalesce write bursts; bounds worst-case loss window

function createDb() {
  let backend = "file";
  let dataDir = null;

  // ---- file backend (synchronous, no cache needed) ----
  const filePath = (name) => path.join(dataDir, FILE_NAMES[name] || `${name}.json`);
  const fileGet = (name) => { try { return fs.readFileSync(filePath(name), "utf8"); } catch { return null; } };
  const fileSet = (name, value) => {
    const p = filePath(name);
    fs.writeFileSync(p + ".tmp", value);
    fs.renameSync(p + ".tmp", p);
  };
  const fileDel = (name) => { try { fs.unlinkSync(filePath(name)); } catch { } };

  // ---- postgres backend (write-behind cache over an injected client) ----
  let client = null;                 // { query(sql, params) => Promise, end() => Promise }
  const cache = new Map();           // name -> value (runtime source of truth)
  const dirty = new Set();           // names needing an upsert
  const deleted = new Set();         // names needing a delete
  let flushTimer = null;
  let flushChain = Promise.resolve();
  let onError = (e) => console.error("[db] flush failed:", e.message);

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DEBOUNCE_MS);
  }

  // Serialize flushes; each pass drains whatever is dirty/deleted, including
  // writes that arrive mid-flush (the while-loop re-checks).
  function flush() {
    flushChain = flushChain.then(doFlush).catch((e) => { onError(e); });
    return flushChain;
  }
  async function doFlush() {
    if (!client) return;
    while (dirty.size || deleted.size) {
      const writes = [...dirty]; dirty.clear();
      const dels = [...deleted]; deleted.clear();
      try {
        for (const name of writes) {
          // a delete queued after this write wins — skip the stale upsert
          if (deleted.has(name)) continue;
          await client.query(
            "INSERT INTO kv (name, value, updated_at) VALUES ($1, $2, now()) " +
            "ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            [name, cache.get(name)]
          );
        }
        for (const name of dels) {
          if (dirty.has(name)) continue; // a re-write queued after the delete wins
          await client.query("DELETE FROM kv WHERE name = $1", [name]);
        }
      } catch (e) {
        /* Re-queue whatever this pass was carrying. The names are drained from
           `dirty` BEFORE the query runs, so without this a single failed flush
           discards them permanently: the value sits in memory looking saved and
           never reaches the database even once it is reachable again. Re-adding
           an entry that did land is harmless — the upsert is idempotent. */
        for (const n of writes) if (!deleted.has(n)) dirty.add(n);
        for (const n of dels) if (!dirty.has(n)) deleted.add(n);
        throw e;
      }
    }
  }

  /* Force everything pending to the database NOW and REPORT whether it landed.

     The debounced write-behind path above is right for throughput but wrong as
     an acknowledgement. set() returns the moment memory is updated, so a caller
     can answer "saved" while the row is still queued — and if the database is
     unreachable the change is dropped with nothing but a log line. That is not
     hypothetical: with Cloud SQL stopped and the instance still warm, the app
     accepted logins and state pushes and returned 200 for every one of them,
     while `[db] flush failed: ECONNREFUSED` scrolled past in the logs. The data
     would have died with the container.

     Any request that is about to tell a clinician their record is saved must
     await this and surface a failure instead. Unlike flush(), this REJECTS. */
  async function flushNow() {
    if (backend !== "postgres") return;      // the file backend writes synchronously
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    // Chain onto any in-flight flush so ordering holds. The second handler
    // retries after an earlier failure rather than inheriting its rejection.
    const run = flushChain.then(doFlush, doFlush);
    flushChain = run.catch(() => { });        // keep the background chain usable
    await run;
  }

  const pgGet = (name) => (cache.has(name) ? cache.get(name) : null);
  const pgSet = (name, value) => { cache.set(name, value); deleted.delete(name); dirty.add(name); scheduleFlush(); };
  const pgDel = (name) => { cache.delete(name); dirty.delete(name); deleted.add(name); scheduleFlush(); };

  /* init: choose the backend and, for Postgres, connect + preload the cache.
     opts = { dataDir, databaseUrl, client?, onError? }
     `client` is an injection seam for tests (a stand-in for a pg Pool). */
  async function init(opts = {}) {
    dataDir = opts.dataDir || path.join(__dirname, "data");
    if (opts.onError) onError = opts.onError;

    if (!opts.databaseUrl && !opts.client) { backend = "file"; return info(); }

    backend = "postgres";
    if (opts.client) {
      client = opts.client;
    } else {
      let Pool;
      try { ({ Pool } = require("pg")); }
      catch { throw new Error("DATABASE_URL is set but the 'pg' package isn't installed. Run `npm install pg`."); }
      client = new Pool({ connectionString: opts.databaseUrl, max: 4, idleTimeoutMillis: 30000 });
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS kv (name text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"
    );
    const { rows } = await client.query("SELECT name, value FROM kv");
    for (const r of rows) cache.set(r.name, r.value);
    return info();
  }

  function get(name) { return backend === "postgres" ? pgGet(name) : fileGet(name); }
  function set(name, value) { return backend === "postgres" ? pgSet(name, String(value)) : fileSet(name, String(value)); }
  function del(name) { return backend === "postgres" ? pgDel(name) : fileDel(name); }

  function info() {
    return backend === "postgres"
      ? { backend, pending: dirty.size + deleted.size, keys: [...cache.keys()] }
      : { backend, dataDir };
  }

  // Flush pending writes and close the pool — call on graceful shutdown so
  // Cloud Run's SIGTERM doesn't drop the last in-memory writes.
  async function close() {
    if (backend !== "postgres") return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await flush();
    if (client && client.end) { try { await client.end(); } catch { } }
  }

  return { init, get, set, del, flush, flushNow, close, info, KEYS, FILE_NAMES };
}

module.exports = createDb();
module.exports.createDb = createDb; // for tests that want an isolated instance
