/* TheraChart db checker — verifies the persistence backend: the file backend
   round-trips, and the Postgres backend preloads, serves reads from its cache,
   and flushes write-behind (upserts + deletes) to the database, including on
   shutdown. Postgres is exercised through a mock client (no real DB needed).
   Run: node test/db.test.js */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDb } = require("../db.js");

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for a pg Pool backed by an in-memory "kv table".
function mockClient(seed = {}) {
  const table = new Map(Object.entries(seed));
  const counts = { insert: 0, delete: 0, select: 0, create: 0 };
  return {
    table, counts,
    async query(sql, params) {
      if (/CREATE TABLE/i.test(sql)) { counts.create++; return { rows: [] }; }
      if (/^\s*INSERT/i.test(sql)) { counts.insert++; table.set(params[0], params[1]); return { rows: [] }; }
      if (/^\s*DELETE/i.test(sql)) { counts.delete++; table.delete(params[0]); return { rows: [] }; }
      if (/^\s*SELECT/i.test(sql)) { counts.select++; return { rows: [...table.entries()].map(([name, value]) => ({ name, value })) }; }
      return { rows: [] };
    },
    async end() { this.ended = true; },
  };
}

(async () => {
  // ---- file backend -----------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-db-"));
  const fdb = createDb();
  const finfo = await fdb.init({ dataDir: dir });
  check("file backend selected when no DATABASE_URL", finfo.backend === "file", JSON.stringify(finfo));
  check("get on empty file returns null", fdb.get("store") === null);
  fdb.set("store", '{"hello":"world"}');
  check("file set then get round-trips", fdb.get("store") === '{"hello":"world"}');
  check("file set writes the canonical filename",
    fs.existsSync(path.join(dir, "therachart.json")), "expected therachart.json on disk");
  fdb.set("rev", "7");
  check("file rev persists under its own name",
    fs.existsSync(path.join(dir, "rev")) && fdb.get("rev") === "7");
  fdb.del("store");
  check("file del removes the value", fdb.get("store") === null);

  // ---- postgres backend: preload + cache reads --------------------------
  const seeded = mockClient({ store: '{"seeded":true}', rev: "42" });
  const pdb = createDb();
  const pinfo = await pdb.init({ dataDir: dir, client: seeded });
  check("postgres backend selected when client injected", pinfo.backend === "postgres", JSON.stringify(pinfo));
  check("CREATE TABLE issued once at init", seeded.counts.create === 1);
  check("preloaded rows served from cache (store)", pdb.get("store") === '{"seeded":true}');
  check("preloaded rows served from cache (rev)", pdb.get("rev") === "42");
  check("unknown key returns null", pdb.get("sessions") === null);

  // ---- write-behind: cache updates immediately, DB flushes async --------
  pdb.set("store", '{"changed":1}');
  check("read reflects the write immediately (before flush)", pdb.get("store") === '{"changed":1}');
  check("DB not yet written synchronously", seeded.table.get("store") === '{"seeded":true}');
  await pdb.flush();
  check("flush upserts the new value to the DB", seeded.table.get("store") === '{"changed":1}');

  // debounced auto-flush also lands without an explicit flush()
  pdb.set("sessions", '{"tok":1}');
  await wait(400); // > FLUSH_DEBOUNCE_MS
  check("debounced auto-flush writes to the DB", seeded.table.get("sessions") === '{"tok":1}');

  // ---- delete flushes through -------------------------------------------
  pdb.del("rev");
  check("read after del is null immediately", pdb.get("rev") === null);
  await pdb.flush();
  check("flush removes the row from the DB", !seeded.table.has("rev"));

  // ---- delete-wins-over-stale-write within one flush --------------------
  const race = mockClient({ store: "old" });
  const rdb = createDb();
  await rdb.init({ dataDir: dir, client: race });
  rdb.set("store", "new");
  rdb.del("store"); // queued after the write in the same batch
  await rdb.flush();
  check("delete queued after write wins (row gone)", !race.table.has("store"));
  check("cache reflects the delete", rdb.get("store") === null);

  // ---- close() flushes and ends the pool --------------------------------
  const closing = mockClient();
  const cdb = createDb();
  await cdb.init({ dataDir: dir, client: closing });
  cdb.set("store", "final");
  await cdb.close();
  check("close() flushes pending writes", closing.table.get("store") === "final");
  check("close() ends the pool", closing.ended === true);

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`TheraChart db checker: ${passed}/${passed + failures.length} checks passed`);
  if (failures.length) { console.log("\n" + failures.join("\n")); process.exit(1); }
})().catch((e) => { console.error("db test crashed:", e); process.exit(1); });
