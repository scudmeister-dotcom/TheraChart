/* TheraChart asset-wiring checker — every script index.html loads must also be
   servable and cacheable.
   Run: node test/assets.test.js

   This exists because of a failure that is invisible in code review and silent
   at runtime until a feature simply doesn't work. Three lists have to agree:

     index.html   <script src="…">      what the browser asks for
     server.js    CLIENT_FILES          what the server is willing to serve
     sw.js        SHELL                 what works offline / from the home screen

   Miss the second and the file 404s, the global is undefined, and the feature
   fails with no error the user can see. Miss the third and the app keeps
   serving yesterday's code from cache. Both have happened. The lists are read
   as text rather than imported, because server.js starts listening on import
   and sw.js expects a service-worker global. */

"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
const failures = [];
const check = (n, c, d) => { if (c) passed += 1; else failures.push(`✗ ${n}${d ? `\n    ${d}` : ""}`); };

/* ---------------------------------------------------------------- *
 *  What the page asks for
 * ---------------------------------------------------------------- */

const html = read("index.html");
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map((m) => m[1]);

check("index.html loads at least the known app scripts", scripts.length >= 6, JSON.stringify(scripts));
check("every script index.html loads exists on disk",
  scripts.every((s) => fs.existsSync(path.join(ROOT, s))),
  JSON.stringify(scripts.filter((s) => !fs.existsSync(path.join(ROOT, s)))));
check("every stylesheet index.html loads exists on disk",
  styles.every((s) => fs.existsSync(path.join(ROOT, s))),
  JSON.stringify(styles.filter((s) => !fs.existsSync(path.join(ROOT, s)))));

/* ---------------------------------------------------------------- *
 *  What the server will serve
 * ---------------------------------------------------------------- */

const serverSrc = read("server.js");
const clientFilesBlock = (serverSrc.match(/const CLIENT_FILES = new Set\(\[([\s\S]*?)\]\)/) || [])[1];
check("server.js still declares a CLIENT_FILES allowlist", !!clientFilesBlock,
  "the allowlist was renamed or restructured — update this test with it");

const clientDirsBlock = (serverSrc.match(/const CLIENT_DIRS = \[([\s\S]*?)\]/) || [])[1] || "";
const quoted = (block) => [...(block || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const CLIENT_FILES = quoted(clientFilesBlock);
const CLIENT_DIRS = quoted(clientDirsBlock);

const webPath = (src) => "/" + String(src).replace(/^\.?\//, "");
const servable = (src) => {
  const p = webPath(src);
  return CLIENT_FILES.indexOf(p) >= 0 || CLIENT_DIRS.some((d) => p.startsWith(d));
};

{
  const missing = scripts.concat(styles).filter((s) => !servable(s));
  check("every script and stylesheet index.html loads is servable by server.js",
    missing.length === 0,
    missing.length ? `not in CLIENT_FILES/CLIENT_DIRS: ${JSON.stringify(missing)} — the browser would get a 404` : "");
}

{
  // The reverse direction: an allowlisted file that no longer exists is dead
  // weight at best, and at worst hides a rename that broke something else.
  const gone = CLIENT_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f.replace(/^\//, ""))));
  check("every file on the server allowlist exists", gone.length === 0, JSON.stringify(gone));
}

/* ---------------------------------------------------------------- *
 *  What the service worker caches
 * ---------------------------------------------------------------- */

const swSrc = read("sw.js");
const shellBlock = (swSrc.match(/const SHELL = \[([\s\S]*?)\]/) || [])[1];
check("sw.js still declares a SHELL list", !!shellBlock,
  "the offline shell was renamed or restructured — update this test with it");

const SHELL = quoted(shellBlock).map(webPath);

{
  const missing = scripts.concat(styles).filter((s) => SHELL.indexOf(webPath(s)) < 0);
  check("every script and stylesheet index.html loads is in the offline shell",
    missing.length === 0,
    missing.length ? `not in sw.js SHELL: ${JSON.stringify(missing)} — the app would break offline` : "");
}

{
  const gone = SHELL.filter((f) => f !== "/" && !fs.existsSync(path.join(ROOT, f.replace(/^\//, ""))));
  check("every file in the offline shell exists", gone.length === 0,
    gone.length ? `${JSON.stringify(gone)} — addAll() rejects wholesale, so ONE bad path disables the whole cache` : "");
}

/* The cache name is the only thing that evicts a stale shell. If the shell
   list changes and the version doesn't, returning users keep the old code —
   which is how a fix can look deployed and not be. This can't be checked
   automatically against history, so assert only that a version exists. */
check("the service-worker cache is versioned", /const CACHE = "therachart-v\d+"/.test(swSrc),
  "bump therachart-vN whenever SHELL changes, or returning users keep the old app");

/* ---------------------------------------------------------------- *
 *  Modules load in dependency order
 * ---------------------------------------------------------------- */

{
  // app.js reads the other modules' globals at parse time, so it must come last
  // of the shared modules; sync.js runs against an already-built app.
  const idx = (f) => scripts.findIndex((s) => webPath(s) === f);
  const appAt = idx("/app.js");
  const deps = ["/parser.js", "/insights.js", "/clinical.js", "/validate.js", "/store.js"];
  const late = deps.filter((d) => idx(d) >= 0 && idx(d) > appAt);
  check("every module app.js depends on is loaded before it", late.length === 0,
    late.length ? `${JSON.stringify(late)} load after app.js — their globals would be undefined` : "");
  check("validate.js is wired into the page", idx("/validate.js") >= 0,
    "intake guardrails only run if the page loads validate.js");
}

/* ---------------------------------------------------------------- *
 *  The test suite runs every checker
 * ---------------------------------------------------------------- */

{
  const pkg = JSON.parse(read("package.json"));
  const script = pkg.scripts.test || "";
  const checkers = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js"));
  const unrun = checkers.filter((f) => script.indexOf(`test/${f}`) < 0);
  check("npm test runs every checker in test/", unrun.length === 0,
    unrun.length ? `${JSON.stringify(unrun)} exist but are never run` : "");
}

/* ---------------------------------------------------------------- */

if (failures.length) {
  console.error(`\nTheraChart asset checker: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error(f));
  process.exit(1);
}
console.log(`TheraChart asset checker: ${passed}/${passed} checks passed`);
