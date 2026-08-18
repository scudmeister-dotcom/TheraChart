/* Shared harness for tests that drive the real clinic server over HTTP.
   Boots `server.js` on a free port against a throwaway data directory, so a
   test never touches ./data and two tests never collide on a port. */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Boot a server and return { base, call, login, stop, dataDir, log }.
    opts.dataDir points the server at an existing directory (for migration
    tests that need to seed a specific database); omit it for a fresh one,
    which is what almost every test wants. */
async function startServer(env = {}, opts = {}) {
  const ownsDir = !opts.dataDir;
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "therachart-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
    // blank the AI/cloud vars so a developer's real credentials never leak into
    // a test run (and tests never make a billable call). THERACHART_DATA and
    // PORT are set last so a caller can't accidentally point a test at ./data.
    env: { ...process.env, GEMINI_API_KEY: "", GEMINI_VERTEX: "", GCP_PROJECT: "", GCS_BUCKET: "", REMINDER_WEBHOOK: "", ...env, THERACHART_DATA: dataDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited during startup:\n${log}`);
    try { if ((await fetch(`${base}/api/ping`)).ok) { ready = true; break; } } catch { /* not up yet */ }
    await sleep(50);
  }
  if (!ready) { child.kill("SIGKILL"); throw new Error(`server never became ready:\n${log}`); }

  const call = async (p, { method = "GET", token, body, raw = false } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return { status: res.status, res };
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, data };
  };

  return {
    base, call, dataDir,
    log: () => log,
    login: (email, password) => call("/api/login", { method: "POST", body: { email, password } }),
    /* Enter a seeded demo account the way the picker does. On a server that
       offers a demo, typing its password is refused — the account is opened by
       being chosen, not by presenting a shared secret — so tests that need a
       demo session go through here. `token` is only needed in invite mode. */
    demoSignIn: (userId, token) =>
      call("/api/demo-signin", { method: "POST", token, body: { userId } }),
    stop() {
      child.kill("SIGKILL");
      // only clean up a directory we created — never one handed to us
      if (ownsDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    },
  };
}

/** Tiny check/report scaffold shared by the HTTP tests. */
function reporter(label) {
  let passed = 0;
  const failures = [];
  return {
    check(name, cond, detail) {
      if (cond) passed += 1;
      else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
    },
    note(msg) { failures.push(`✗ ${msg}`); },
    done() {
      if (failures.length) {
        console.error(`\nTheraChart ${label}: ${passed} passed, ${failures.length} FAILED\n`);
        failures.forEach((f) => console.error(f));
        process.exit(1);
      }
      console.log(`TheraChart ${label}: ${passed}/${passed} checks passed`);
    },
  };
}

module.exports = { startServer, reporter, freePort, sleep };
