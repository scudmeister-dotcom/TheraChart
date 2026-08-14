/* TheraChart tenancy & authorization checker — the only test that exercises the
   real HTTP boundary. store.js filters reads by clinic too, but that runs in the
   browser, after the bytes have been delivered; these checks assert the server
   itself refuses to hand one clinic's data to another, and refuses to let a
   device push privileges it wasn't granted.

   Boots a throwaway server on a free port against a temp data dir.
   Run: node test/tenancy.test.js */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(dataDir, port) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, THERACHART_DATA: dataDir, PORT: String(port), GEMINI_API_KEY: "", GCP_PROJECT: "",
      // a client id so /api/verify-google validates rather than short-circuiting
      // with "Google sign-in isn't configured"
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`);
      if (r.ok) return child;
    } catch { /* not up yet */ }
    await sleep(50);
  }
  child.kill("SIGKILL");
  throw new Error(`server never became ready:\n${log}`);
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-tenancy-"));
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const server = await boot(dataDir, port);

  const call = async (p, { method = "GET", token, body, raw = false } = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return { status: res.status, res };
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };
  const login = (email, password) => call("/api/login", { method: "POST", body: { email, password } });

  // Against vulnerable code the earlier checks succeed and leave the database in
  // shapes later steps don't expect. Degrade to a named failure rather than
  // crashing, so a regression reads as "✗ <check>" instead of a JSON error.
  const EMPTY = { patients: [], documents: [], appointments: [], users: [], audit: [], clinics: {} };
  const stateOf = async (token, label) => {
    const r = await call("/api/state", { token });
    if (!r.data || !r.data.state) {
      failures.push(`✗ could not read state${label ? ` (${label})` : ""} — HTTP ${r.status}`);
      return { rev: -1, state: JSON.parse(JSON.stringify(EMPTY)) };
    }
    return { rev: r.data.rev, state: { ...EMPTY, ...r.data.state } };
  };

  try {
    /* ---- actors -------------------------------------------------------- */
    const fresh = await login("fresh@therachart.demo", "1234");   // admin of the empty clinic-fresh
    const maria = await login("maria@therachart.demo", "1234");   // therapist,   clinic-demo
    const ana = await login("ana@therachart.demo", "1234");       // front desk,  clinic-demo
    const grace = await login("grace@therachart.demo", "1234");   // admin,       clinic-demo
    const jose = await login("jose@therachart.demo", "1234");     // expired licence, clinic-demo

    check("all demo accounts can sign in", [fresh, maria, ana, grace, jose].every((r) => r.data && r.data.token),
      [fresh, maria, ana, grace, jose].map((r) => (r.data && r.data.error) || "ok").join(" | "));

    const fToken = fresh.data.token, mToken = maria.data.token, aToken = ana.data.token, gToken = grace.data.token;

    /* ---- reads are scoped to the caller's clinic ------------------------ */
    const fState = await stateOf(fToken);
    const otherClinic = (arr) => (arr || []).filter((r) => (r.clinicId || "clinic-demo") !== "clinic-fresh");
    check("GET /api/state leaks no foreign patients", otherClinic(fState.state.patients).length === 0,
      `saw ${otherClinic(fState.state.patients).length}`);
    check("GET /api/state leaks no foreign documents", otherClinic(fState.state.documents).length === 0,
      `saw ${otherClinic(fState.state.documents).length}`);
    check("GET /api/state leaks no foreign appointments", otherClinic(fState.state.appointments).length === 0);
    check("GET /api/state leaks no foreign staff", otherClinic(fState.state.users).length === 0,
      `saw ${otherClinic(fState.state.users).map((u) => u.email).join(", ")}`);
    check("GET /api/state leaks no foreign audit entries", otherClinic(fState.state.audit).length === 0);
    check("other clinics are not even enumerated", Object.keys(fState.state.clinics || {}).join(",") === "clinic-fresh",
      `clinics=${Object.keys(fState.state.clinics || {}).join(",")}`);

    const mState = await stateOf(mToken);
    check("a clinic still sees its own patients", (mState.state.patients || []).length > 0,
      `clinic-demo sees ${(mState.state.patients || []).length}`);
    check("login response is scoped too", otherClinic(maria.data.state.users).length >= 0 &&
      (fresh.data.state.patients || []).length === 0, `login handed fresh ${(fresh.data.state.patients || []).length} patients`);

    /* ---- writes cannot cross a clinic boundary -------------------------- */
    const before = (await stateOf(mToken)).state.patients.length;
    const cur = await stateOf(fToken);
    const wipe = JSON.parse(JSON.stringify(cur.state));
    wipe.patients = [];
    await call("/api/state", { method: "PUT", token: fToken, body: { baseRev: cur.rev, state: wipe } });
    const after = (await stateOf(mToken)).state.patients.length;
    check("a push from another clinic cannot delete patients", after === before, `${before} -> ${after}`);

    const cur2 = await stateOf(fToken);
    const foreignStamp = JSON.parse(JSON.stringify(cur2.state));
    foreignStamp.patients = [{ id: "p-injected", clinicId: "clinic-demo", firstName: "Mal", lastName: "Ory" }];
    // Foreign-stamped rows are DROPPED rather than 403'd: on a shared clinic
    // device the previous user's records are still cached when the next person
    // signs in, so a legitimate first sync can carry them. The push must
    // succeed (or the device retries forever) while planting nothing.
    const accepted = await call("/api/state", { method: "PUT", token: fToken, body: { baseRev: cur2.rev, state: foreignStamp } });
    check("a push carrying another clinic's rows still succeeds", accepted.status === 200, `-> ${accepted.status}`);
    const mAfter = await stateOf(mToken);
    check("but the foreign row is not planted", !(mAfter.state.patients || []).some((p) => p.id === "p-injected"));
    check("and the other clinic's own records are untouched", (mAfter.state.patients || []).length === before,
      `${before} -> ${(mAfter.state.patients || []).length}`);
    const fAfter = await stateOf(fToken);
    check("the dropped row does not land in the pusher's clinic either",
      !(fAfter.state.patients || []).some((p) => p.id === "p-injected"),
      JSON.stringify((fAfter.state.patients || []).map((p) => p.id)));

    /* ---- cross-clinic account control ----------------------------------- */
    const setPw = await call("/api/set-password", { method: "POST", token: fToken, body: { userId: "u-maria", newPassword: "attacker-chosen-pw" } });
    check("cross-clinic password reset is refused", setPw.status === 404, `-> ${setPw.status}`);
    const stillMaria = await login("maria@therachart.demo", "1234");
    check("the target's password is untouched", !!(stillMaria.data && stillMaria.data.token));

    const del = await call("/api/delete-user", { method: "POST", token: fToken, body: { userId: "u-carlo" } });
    check("cross-clinic user deletion is refused", del.status === 404, `-> ${del.status}`);

    /* ---- a device push cannot grant itself privileges ------------------- */
    const aState = await stateOf(aToken);
    const escalate = JSON.parse(JSON.stringify(aState.state));
    const meAna = escalate.users.find((u) => u.id === "u-ana") || {};
    meAna.role = "admin";
    meAna.license = { number: "FORGED", expires: "2099-01-01" };
    await call("/api/state", { method: "PUT", token: aToken, body: { baseRev: aState.rev, state: escalate } });
    const anaNow = (await stateOf(gToken, "ana after push")).state.users.find((u) => u.id === "u-ana") || {};
    check("front desk cannot promote itself to admin", anaNow.role === "frontdesk", `role=${anaNow.role}`);
    check("front desk cannot forge a licence", !anaNow.license, `license=${JSON.stringify(anaNow.license)}`);
    const stillBlocked = await call("/api/delete-user", { method: "POST", token: aToken, body: { userId: "u-carlo" } });
    check("front desk still refused by admin-only endpoints", stillBlocked.status === 403, `-> ${stillBlocked.status}`);

    const s3 = await stateOf(aToken);
    const invent = JSON.parse(JSON.stringify(s3.state));
    invent.users.push({ id: "u-ghost", name: "Ghost", email: "ghost@therachart.demo", role: "admin", active: true });
    await call("/api/state", { method: "PUT", token: aToken, body: { baseRev: s3.rev, state: invent } });
    const ghost = (await stateOf(gToken)).state.users.find((u) => u.id === "u-ghost");
    check("a push cannot invent an account", !ghost);

    const s4 = await stateOf(aToken);
    const omit = JSON.parse(JSON.stringify(s4.state));
    omit.users = omit.users.filter((u) => u.id !== "u-grace"); // try to delete the admin by omission
    await call("/api/state", { method: "PUT", token: aToken, body: { baseRev: s4.rev, state: omit } });
    const graceStill = (await stateOf(mToken)).state.users.find((u) => u.id === "u-grace");
    check("a push cannot delete staff by omitting them", !!graceStill);

    /* ---- but the legitimate admin flow still works ---------------------- */
    const s5 = await stateOf(gToken);
    const edit = JSON.parse(JSON.stringify(s5.state));
    const target = edit.users.find((u) => u.id === "u-maria") || {};
    target.license = { number: "PT-RENEWED-01", expires: "2099-12-31" };
    const okPush = await call("/api/state", { method: "PUT", token: gToken, body: { baseRev: s5.rev, state: edit } });
    const mariaNow = (await stateOf(gToken, "maria after admin edit")).state.users.find((u) => u.id === "u-maria") || {};
    check("an admin can still edit a colleague's licence in their own clinic",
      okPush.status === 200 && mariaNow.license && mariaNow.license.number === "PT-RENEWED-01",
      `status=${okPush.status} license=${JSON.stringify(mariaNow.license)}`);

    // A sole admin must be able to record their OWN licence, or canDocument()
    // never passes and they can never write a note — a one-person clinic, or a
    // freshly created one, would be permanently stuck.
    const sLic = await stateOf(fToken, "sole admin licence");
    const licEdit = JSON.parse(JSON.stringify(sLic.state));
    const soleAdmin = licEdit.users.find((u) => u.id === fresh.data.userId);
    if (soleAdmin) soleAdmin.license = { number: "PT-SELF-001", expires: "2099-01-01" };
    await call("/api/state", { method: "PUT", token: fToken, body: { baseRev: sLic.rev, state: licEdit } });
    const licNow = (await stateOf(fToken, "licence after")).state.users.find((u) => u.id === fresh.data.userId) || {};
    check("a sole admin can record their own licence",
      licNow.license && licNow.license.number === "PT-SELF-001", JSON.stringify(licNow.license));

    const s6 = await stateOf(gToken);
    const selfPromote = JSON.parse(JSON.stringify(s6.state));
    const graceRec = selfPromote.users.find((u) => u.id === "u-grace");
    if (graceRec) graceRec.role = "therapist";
    await call("/api/state", { method: "PUT", token: gToken, body: { baseRev: s6.rev, state: selfPromote } });
    const graceNow = (await stateOf(gToken, "grace after self-promote")).state.users.find((u) => u.id === "u-grace") || {};
    check("not even an admin may rewrite their own role", graceNow.role === "admin", `role=${graceNow.role}`);

    /* ---- settings are PER CLINIC ---------------------------------------- */
    // They ride in clinics[id].settings, so one clinic's configuration can
    // never be read or changed by another. `audioReview` is the sharp edge:
    // it decides whether a patient's dictation audio is retained at all.
    const setClinic = async (token, rev, state, clinicId, patch, name) => {
      const next = JSON.parse(JSON.stringify(state));
      const prior = (next.clinics && next.clinics[clinicId]) || { id: clinicId };
      next.clinics = { ...(next.clinics || {}) };
      next.clinics[clinicId] = {
        ...prior, id: clinicId,
        ...(name ? { name } : {}),
        settings: { ...(prior.settings || {}), ...patch },
      };
      return call("/api/state", { method: "PUT", token, body: { baseRev: rev, state: next } });
    };

    const sSet = await stateOf(gToken, "settings");
    const saved = await setClinic(gToken, sSet.rev, sSet.state, "clinic-demo",
      { slotMinutes: 30, progressEvery: 8, audioReview: true }, "Renamed Clinic");
    check("an admin can change their own clinic's settings", saved.status === 200, `-> ${saved.status}`);

    const demoNow = (await stateOf(gToken, "settings after")).state.settings;
    check("the change is reflected back to that clinic",
      demoNow.slotMinutes === 30 && demoNow.progressEvery === 8 && demoNow.audioReview === true,
      JSON.stringify({ slot: demoNow.slotMinutes, prog: demoNow.progressEvery, audio: demoNow.audioReview }));
    check("an admin can still rename their own clinic", demoNow.facilityName === "Renamed Clinic", demoNow.facilityName);

    // the whole point: the OTHER clinic is unaffected
    const freshNow = (await stateOf(fToken, "other clinic settings")).state.settings;
    check("another clinic's slot length is untouched", freshNow.slotMinutes === 45, String(freshNow.slotMinutes));
    check("another clinic's progress threshold is untouched", freshNow.progressEvery === 5, String(freshNow.progressEvery));
    check("one clinic cannot switch on audio retention for another", freshNow.audioReview !== true,
      `clinic-fresh audioReview=${freshNow.audioReview}`);
    check("another clinic keeps its own name", freshNow.facilityName !== "Renamed Clinic", freshNow.facilityName);
    check("a device is not shown another clinic's settings block",
      !JSON.stringify((await stateOf(fToken, "leak check")).state.clinics || {}).includes("clinic-demo"),
      JSON.stringify((await stateOf(fToken, "leak check")).state.clinics));

    // a non-admin cannot change settings at all
    const sNon = await stateOf(mToken, "non-admin settings");
    await setClinic(mToken, sNon.rev, sNon.state, "clinic-demo", { audioReview: false, slotMinutes: 15 });
    const afterNonAdmin = (await stateOf(gToken, "settings after non-admin")).state.settings;
    check("a non-admin push cannot change clinic settings",
      afterNonAdmin.slotMinutes === 30 && afterNonAdmin.audioReview === true,
      JSON.stringify({ slot: afterNonAdmin.slotMinutes, audio: afterNonAdmin.audioReview }));

    // one clinic's admin cannot reach into another's entry
    const sRen = await stateOf(fToken, "foreign rename");
    const hijack = JSON.parse(JSON.stringify(sRen.state));
    hijack.clinics = {
      "clinic-demo": { id: "clinic-demo", name: "Hijacked", settings: { audioReview: false, slotMinutes: 5 } },
      "clinic-fresh": { id: "clinic-fresh", name: "New Clinic" },
    };
    await call("/api/state", { method: "PUT", token: fToken, body: { baseRev: sRen.rev, state: hijack } });
    const demoAfterHijack = (await stateOf(gToken, "after hijack")).state.settings;
    check("one clinic's admin cannot rename another clinic", demoAfterHijack.facilityName === "Renamed Clinic", demoAfterHijack.facilityName);
    check("one clinic's admin cannot rewrite another's settings",
      demoAfterHijack.slotMinutes === 30 && demoAfterHijack.audioReview === true,
      JSON.stringify({ slot: demoAfterHijack.slotMinutes, audio: demoAfterHijack.audioReview }));

    /* ---- AI endpoints ship PHI off-box: gate them like documentation ----- */
    const anaRefine = await call("/api/refine", { method: "POST", token: aToken, body: { transcript: ["left shoulder pain"] } });
    check("front desk cannot drive /api/refine", anaRefine.status === 403, `-> ${anaRefine.status}`);
    const anaInsights = await call("/api/insights", { method: "POST", token: aToken, body: { findings: [] } });
    check("front desk cannot drive /api/insights", anaInsights.status === 403, `-> ${anaInsights.status}`);
    const joseRefine = await call("/api/refine", { method: "POST", token: jose.data.token, body: { transcript: ["left shoulder pain"] } });
    check("an expired licence cannot drive /api/refine", joseRefine.status === 403, `-> ${joseRefine.status}`);
    const mariaRefine = await call("/api/refine", { method: "POST", token: mToken, body: { transcript: ["left shoulder pain"] } });
    check("a licensed therapist still can", mariaRefine.status === 200, `-> ${mariaRefine.status}`);

    /* ---- object ids from another clinic must not resolve ---------------- */
    const foreignDoc = (mAfter.state.documents || [])[0];
    check("a clinic-demo document exists to test against", !!foreignDoc);
    if (foreignDoc) {
      const audioGet = await call(`/api/audio?docId=${encodeURIComponent(foreignDoc.id)}`, { token: fToken });
      check("/api/audio will not resolve a foreign document", audioGet.status === 404, `-> ${audioGet.status}`);
      const audioDel = await call(`/api/audio?docId=${encodeURIComponent(foreignDoc.id)}`, { method: "DELETE", token: fToken });
      check("/api/audio DELETE will not reach a foreign document", audioDel.status === 404, `-> ${audioDel.status}`);
      const ownAudio = await call(`/api/audio?docId=${encodeURIComponent(foreignDoc.id)}`, { token: mToken });
      check("the owning clinic can still reach its own document's audio", ownAudio.status === 200, `-> ${ownAudio.status}`);
    }

    // a real uploaded attachment (the seeded one is inline dataUrl, so it would
    // 404 for the wrong reason) — upload as maria, reference it, then try to
    // fetch the key from the other clinic
    const up = await call("/api/files", { method: "POST", token: mToken, body: { name: "xray.txt", type: "text/plain", dataBase64: Buffer.from("chest xray").toString("base64") } });
    check("upload returns a storage key", !!(up.data && up.data.key), JSON.stringify(up.data));
    if (up.data && up.data.key && (await stateOf(mToken, "attachment setup")).state.patients.length) {
      const s7 = await stateOf(mToken, "attachment setup");
      const attach = JSON.parse(JSON.stringify(s7.state));
      attach.patients[0].attachments = (attach.patients[0].attachments || []).concat([{ id: "a-test", name: "xray.txt", type: "text/plain", key: up.data.key }]);
      await call("/api/state", { method: "PUT", token: mToken, body: { baseRev: s7.rev, state: attach } });
      const mine = await call(`/api/files?key=${encodeURIComponent(up.data.key)}`, { token: mToken, raw: true });
      check("the owning clinic can download its attachment", mine.status === 200, `-> ${mine.status}`);
      const theirs = await call(`/api/files?key=${encodeURIComponent(up.data.key)}`, { token: fToken, raw: true });
      check("another clinic cannot download it", theirs.status === 404, `-> ${theirs.status}`);
    }

    /* ---- e-sign re-auth for Google accounts ------------------------------ */
    // A Google account has no password, so /api/verify-password can never pass
    // for one; /api/verify-google re-confirms with the same provider instead.
    // The happy path needs a real Google token and can't be tested here — but
    // every way it must REFUSE can be.
    const vg = (token, body) => call("/api/verify-google", { method: "POST", token, body });
    check("verify-google refuses an unauthenticated caller",
      (await call("/api/verify-google", { method: "POST", body: { credential: "x" } })).status === 401);
    for (const [label, cred] of [["a missing credential", undefined], ["an empty credential", ""],
                                 ["a junk credential", "not-a-jwt"], ["a malformed JWT", "aaa.bbb.ccc"]]) {
      const r = await vg(mToken, { credential: cred });
      check(`verify-google rejects ${label}`, r.status === 200 && r.data && r.data.ok === false,
        `${r.status} ${JSON.stringify(r.data)}`);
    }
    // and a password account is unaffected — it still verifies by password
    const okPw = await call("/api/verify-password", { method: "POST", token: mToken, body: { password: "1234" } });
    check("a password account still verifies by password", okPw.status === 200 && okPw.data.ok === true, JSON.stringify(okPw.data));
    const badPw = await call("/api/verify-password", { method: "POST", token: mToken, body: { password: "wrong" } });
    check("a wrong password is still refused", badPw.data.ok === false);

    /* ---- the static handler serves the app, not the server -------------- */
    // ROOT holds the server and its tooling as well as the web app, so a
    // serve-anything handler published server.js, db.js, ai.js and the deploy
    // script (which names the GCP project and buckets). Allowlisted now, so
    // anything added server-side later is private by default.
    for (const p of ["/server.js", "/db.js", "/ai.js", "/files.js", "/package.json",
                     "/deploy-gcp.sh", "/test/tenancy.test.js", "/README.md", "/vercel.json"]) {
      const r = await call(p, { raw: true });
      check(`server-side file ${p} is not served`, r.status === 404, `-> ${r.status}`);
    }
    for (const p of ["/", "/index.html", "/app.js", "/store.js", "/sync.js", "/parser.js",
                     "/insights.js", "/clinical.js", "/styles.css", "/sw.js",
                     "/manifest.webmanifest", "/icons/icon-192.png", "/assets/fonts/fonts.css"]) {
      const r = await call(p, { raw: true });
      check(`the app still serves ${p}`, r.status === 200, `-> ${r.status}`);
    }
    // path traversal must not climb out of the app root
    for (const p of ["/../server.js", "/../../etc/passwd", "/./server.js"]) {
      const r = await call(p, { raw: true });
      check(`traversal ${p} is refused`, r.status === 404, `-> ${r.status}`);
    }

    /* ---- login lockout cannot be flushed -------------------------------- */
    // Trip the lock on one account, then spray >1000 distinct identifiers. The
    // old code called loginFails.clear() to bound memory, which released every
    // live lock and let guessing resume.
    for (let i = 0; i < 5; i++) await login("grace@therachart.demo", "wrong-password");
    const lockedNow = await login("grace@therachart.demo", "1234");
    check("5 bad passwords locks the account", lockedNow.status === 429, `-> ${lockedNow.status}`);
    for (let i = 0; i < 1100; i++) await login(`flood${i}@nowhere.invalid`, "x");
    const afterFlood = await login("grace@therachart.demo", "1234");
    check("a flood of junk identifiers does not release the lock", afterFlood.status === 429, `-> ${afterFlood.status}`);
  } finally {
    server.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failures.length) {
    console.error(`\nTheraChart tenancy checker: ${passed} passed, ${failures.length} FAILED\n`);
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }
  console.log(`TheraChart tenancy checker: ${passed}/${passed} checks passed`);
})().catch((e) => { console.error("tenancy checker crashed:", e); process.exit(1); });
