#!/usr/bin/env node
/* TheraChart clinic server — a single-file Node server with zero dependencies.

   Run on one machine in the clinic:
     node server.js            (defaults to port 8080)
     PORT=3000 node server.js

   What it does:
   - Serves the TheraChart app to every phone/iPad/computer on the network
   - Holds the shared clinic database (data/therachart.json) — the same
     store.js business logic the browser uses runs here, server-side
   - Authenticates logins server-side (PINs never leave the server via API)
   - Runs the reminder scheduler: due reminders are marked sent every minute
     and can be forwarded to a real SMS/email gateway via REMINDER_WEBHOOK
   - Keeps data inside the clinic: no third-party cloud involved

   Environment:
     PORT               port to listen on (default 8080)
     THERACHART_DATA    data directory (default ./data)
     REMINDER_WEBHOOK   optional URL; each due reminder is POSTed to it as
                        JSON so you can wire any SMS/email provider
*/

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DATA_DIR = process.env.THERACHART_DATA || path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
// Temporary session-audio review (opt-in). Kept only to let a clinician re-check
// dictation, then auto-deleted on sign or after a few days. INTERIM: on Cloud Run
// this local disk is ephemeral — at go-live move these blobs to Cloud Storage
// (encrypted, lifecycle auto-delete) alongside the Cloud SQL migration.
const AUDIO_DIR = path.join(DATA_DIR, "audio");

/* ---- durable storage injected into the shared store ----
   Backed by db.js: a flat file by default, or Postgres when DATABASE_URL is set
   (so records survive Cloud Run's ephemeral disk). The store blob, the sync
   revision, and device sessions all persist through db. db.init() is awaited in
   start() BEFORE any store access, so the (async) Postgres preload is ready. */
const db = require("./db.js");
globalThis.THERACHART_STORAGE = {
  getItem() { return db.get("store"); },
  setItem(_, v) { db.set("store", v); },
  removeItem() { db.del("store"); },
};
const store = require("./store.js");
const ai = require("./ai.js");
const files = require("./files.js");

// Attachment bytes live out-of-band (see files.js). GCS when GCS_BUCKET is set
// (+ a Google credential, same chain as STT/Vertex); otherwise local disk.
const GCS_BUCKET = process.env.GCS_BUCKET || "";
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 20 * 1024 * 1024); // 20 MB

/* ---- password hashing (scrypt, node crypto, zero-dependency) ----
   Injected into the store so login/set-password hash + verify server-side.
   Format: scrypt$<saltHex>$<hashHex>. Legacy plaintext pins are migrated to
   this at startup (hashLegacyPins) and never stored in cleartext thereafter. */
const AUTH = {
  hash(plain) {
    const salt = crypto.randomBytes(16);
    const h = crypto.scryptSync(String(plain), salt, 64);
    return `scrypt$${salt.toString("hex")}$${h.toString("hex")}`;
  },
  verify(user, plain) {
    const stored = user.passwordHash;
    if (!stored) return user.pin != null && user.pin === String(plain); // not yet migrated
    const [scheme, saltHex, hashHex] = String(stored).split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    let actual;
    try { actual = crypto.scryptSync(String(plain), Buffer.from(saltHex, "hex"), expected.length); }
    catch { return false; }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  },
};
store.setAuthenticator(AUTH);

/* ---- AI transcript refinement (Gemini, with a local fallback) ----
   Sends the TEXT transcript (not audio) to Google Gemini to split speakers,
   clean transcription errors, and re-extract the patient's findings.

   Two backends, both handled by ai.js (same request body, different auth):
     • Gemini API (consumer key) — set GEMINI_API_KEY. Simple, but NOT covered
       by a BAA — for demo / non-PHI only.
     • Vertex AI (OAuth, under a Google Cloud BAA) — set GEMINI_VERTEX=1 plus
       GCP_PROJECT and a Google credential (the SAME credential chain STT uses:
       GCP_ACCESS_TOKEN | GOOGLE_APPLICATION_CREDENTIALS | GCP_SA_KEY | Cloud Run
       metadata). This is the PHI-safe path. GEMINI_LOCATION defaults to the STT
       location. No API key needed in this mode.
   With neither configured, a local heuristic refiner runs so the feature works
   with no key and no network. Mode is computed per-request (key may also come
   from facility settings). */
const GEMINI_MODEL = process.env.GEMINI_MODEL || ai.DEFAULT_MODEL;
const GEMINI_INSIGHTS_MODEL = process.env.GEMINI_INSIGHTS_MODEL || ai.DEFAULT_PRO_MODEL;
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_VERTEX = /^(1|true|yes|on)$/i.test(process.env.GEMINI_VERTEX || "");
const GEMINI_LOCATION = process.env.GEMINI_LOCATION || process.env.STT_LOCATION || "us-central1";

const GEMINI_OPTS = () => vertexConfigured()
  ? { vertex: true, project: GCP_PROJECT, location: GEMINI_LOCATION, getToken: gcpAccessToken,
      model: GEMINI_MODEL, insightsModel: GEMINI_INSIGHTS_MODEL,
      onError: (w, e) => console.error(`[${w}] Gemini (Vertex) failed, using local:`, e.message) }
  : { key: activeGeminiKey(), model: GEMINI_MODEL, insightsModel: GEMINI_INSIGHTS_MODEL, base: GEMINI_BASE,
      onError: (w, e) => console.error(`[${w}] Gemini failed, using local:`, e.message) };

function activeGeminiKey() {
  return process.env.GEMINI_API_KEY || null;
}
// Vertex needs the flag + a project + a usable Google credential (reuses STT's chain).
function vertexConfigured() { return GEMINI_VERTEX && !!GCP_PROJECT && !!sttCredentialSource(); }
// Is any real Gemini backend reachable (vs. the local heuristic)?
function geminiActive() { return vertexConfigured() || !!activeGeminiKey(); }
function geminiEngineDesc() {
  if (vertexConfigured()) return `Vertex AI (project ${GCP_PROJECT} · ${GEMINI_LOCATION})`;
  if (activeGeminiKey()) return "Gemini API (consumer key)";
  return "local heuristic (set GEMINI_API_KEY, or GEMINI_VERTEX=1 + GCP creds for a BAA)";
}

const refineSystem = ai.refineSystem;
const refineTranscript = (utterances) => ai.refine(utterances, GEMINI_OPTS());
const clinicalInsights = (ctx) => ai.insightsRun(ctx, GEMINI_OPTS());

// rev + sessions persist through db (populated from it in start(), below).
let rev = 1;
function bumpRev() { rev += 1; db.set("rev", String(rev)); }

/* ---- sessions (persisted so device tokens survive server restarts) ---- */
const sessions = new Map(); // token -> { userId, at }
function saveSessions() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000; // sessions expire after 30 days
  for (const [t, s] of sessions) if (s.at < cutoff) sessions.delete(t);
  db.set("sessions", JSON.stringify(Object.fromEntries(sessions)));
}

// PINs are short — slow down guessing (per-account: 5 misses = 1-minute hold)
const loginFails = new Map(); // userId -> { n, lockUntil }

function tokenFor(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId, at: Date.now() });
  saveSessions();
  return token;
}
function userForReq(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const sess = token && sessions.get(token);
  return sess ? store.getUser(sess.userId) : null;
}

/* ---- state sanitizers ----
   sessionUserId is per-device; PINs never go out over the API; the Gemini
   key is server-only config and never leaves the server. */
function publicState() {
  const s = JSON.parse(store.exportAll());
  s.sessionUserId = null;
  // credentials are server-only — never sync password hashes (or legacy pins) to devices
  if (Array.isArray(s.users)) s.users = s.users.map((u) => { const c = { ...u }; delete c.passwordHash; delete c.pin; return c; });
  // never sync any stored Gemini key value to devices (legacy installs only —
  // the key is now configured purely via host env vars)
  if (s.settings) delete s.settings.geminiKey;
  return s;
}
// Locate an attachment by its storage key across all patients — used to gate
// downloads and to recover the file's name/type for the response headers.
function findAttachmentByKey(key) {
  if (!key) return null;
  for (const p of store.patients()) {
    for (const a of p.attachments || []) if (a.key === key) return a;
  }
  return null;
}
function bootstrapInfo() {
  // NOTE: the employee roster is deliberately NOT exposed here — employees sign
  // in by email, so an unauthenticated visitor can't enumerate staff/PII.
  return {
    rev,
    facilityName: store.settings().facilityName,
  };
}

/* ---- speech-to-text (Google Cloud Speech-to-Text v2, under your BAA) ----
   The browser records speech, encodes 16 kHz WAV in the page, and POSTs each
   short segment here. This proxies the audio to Google Cloud Speech-to-Text, so
   the audio travels only from your own server to Google under your Google Cloud
   BAA — never to a free/consumer speech service. Two models are offered:
     - "standard" → Google's latest_long model (lower cost)
     - "chirp"    → Google's Chirp model (best multilingual, incl. Tagalog/Cebuano)

   Configure with environment variables (see GOOGLE_SETUP.md):
     GCP_PROJECT   your Google Cloud project id           (required)
     STT_LOCATION  recognition region (default us-central1; chirp needs a region, not "global")
   Credentials — first one found wins:
     GCP_ACCESS_TOKEN                a short-lived OAuth token (quick tests: `gcloud auth print-access-token`)
     GOOGLE_APPLICATION_CREDENTIALS  path to a service-account key JSON (local dev)
     GCP_SA_KEY                      the service-account key JSON inline (one env var)
     (on Cloud Run / GCE nothing is needed — the attached service account is used automatically) */

const GCP_PROJECT = process.env.GCP_PROJECT || "";
const STT_LOCATION = process.env.STT_LOCATION || "us-central1";
const STT_MODELS = { standard: "latest_long", chirp: "chirp" };

function sttCredentialSource() {
  if (process.env.GCP_ACCESS_TOKEN) return "token";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return "key-file";
  if (process.env.GCP_SA_KEY) return "key-inline";
  if (process.env.K_SERVICE || process.env.GCE_METADATA_HOST) return "metadata"; // Cloud Run / GCE
  return null;
}
function sttConfigured() { return !!(GCP_PROJECT && sttCredentialSource()); }
function sttStatus() { return { available: sttConfigured(), models: Object.keys(STT_MODELS), location: STT_LOCATION }; }

// ---- OAuth access token (cached until shortly before expiry) ----
let _tok = { value: null, exp: 0 };
async function gcpAccessToken() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp - 60000) return _tok.value;
  const src = sttCredentialSource();
  if (src === "token") { _tok = { value: process.env.GCP_ACCESS_TOKEN, exp: now + 50 * 60 * 1000 }; return _tok.value; }
  if (src === "key-file" || src === "key-inline") {
    const keyJson = JSON.parse(src === "key-inline"
      ? process.env.GCP_SA_KEY
      : fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
    const t = await jwtBearerToken(keyJson);
    _tok = { value: t.access_token, exp: now + (t.expires_in - 30) * 1000 };
    return _tok.value;
  }
  // metadata server (Cloud Run / GCE) — no key file needed
  const host = process.env.GCE_METADATA_HOST || "metadata.google.internal";
  const r = await fetch(`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error("Could not get a Google Cloud token from the metadata server.");
  const t = await r.json();
  _tok = { value: t.access_token, exp: now + (t.expires_in - 30) * 1000 };
  return _tok.value;
}

// self-signed JWT → OAuth2 token (service-account flow), zero-dependency
async function jwtBearerToken(key) {
  const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const claim = { iss: key.client_email, scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 };
  const input = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claim)}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(key.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${input}.${sig}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Google token exchange failed: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function transcribe(wavBuffer, lang, modelKey) {
  if (!sttConfigured()) {
    throw Object.assign(new Error(
      "Google Cloud Speech-to-Text isn't set up on this server yet. Set GCP_PROJECT and a Google credential (see GOOGLE_SETUP.md), then restart."), { code: 501 });
  }
  const model = STT_MODELS[modelKey] || STT_MODELS.standard;
  const token = await gcpAccessToken();
  const host = STT_LOCATION === "global" ? "speech.googleapis.com" : `${STT_LOCATION}-speech.googleapis.com`;
  const url = `https://${host}/v2/projects/${GCP_PROJECT}/locations/${STT_LOCATION}/recognizers/_:recognize`;
  const body = {
    config: { autoDecodingConfig: {}, model, languageCodes: [lang && lang !== "auto" ? lang : "en-US"] },
    content: wavBuffer.toString("base64"),
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Speech-to-Text failed: ${(data.error && data.error.message) || `HTTP ${r.status}`}`);
  return (data.results || [])
    .map((res) => (res.alternatives && res.alternatives[0] && res.alternatives[0].transcript) || "")
    .join(" ").trim();
}

/* ---- temporary session-audio review (opt-in, auto-deleting) ----
   Audio is kept ONLY when the whole chain opts in: the facility turned the
   feature on, the patient consented, and the note isn't signed yet. It exists
   just long enough for a clinician to re-check the dictation, then it's deleted
   the moment the note is signed (or by the sweep after `audioReviewDays`). This
   is the one exception to "TheraChart never stores audio," and it's disclosed. */
function audioReviewDays() { return Math.max(1, Number(store.settings().audioReviewDays) || 7); }
function audioReviewOn() { return !!store.settings().audioReview; }

// server-side gate: may we keep audio for this document right now?
function audioRetentionOK(doc) {
  if (!audioReviewOn() || !doc || doc.status === "signed") return false;
  const p = store.getPatient(doc.patientId);
  return !!(p && p.audioConsent && p.audioConsent.granted);
}
const docAudioDir = (docId) => path.join(AUDIO_DIR, String(docId).replace(/[^a-z0-9_-]/gi, ""));

function saveAudioSegment(docId, wavBuffer) {
  const dir = docAudioDir(docId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`;
  fs.writeFileSync(path.join(dir, name), wavBuffer);
  return name;
}
function listAudioSegments(docId) {
  const dir = docAudioDir(docId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".wav")); } catch { return []; }
  return files.sort().map((f) => {
    let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch {}
    return { id: f, time: Number(f.split("-")[0]) || 0, size };
  });
}
function deleteAudio(docId) {
  const dir = docAudioDir(docId);
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) { fs.unlinkSync(path.join(dir, f)); n++; } fs.rmdirSync(dir); } catch {}
  return n;
}

// backstop sweep: drop audio for notes that are now signed, gone, or too old
function audioSweep() {
  let dirs = [];
  try { dirs = fs.readdirSync(AUDIO_DIR); } catch { return; }
  const maxAgeMs = audioReviewDays() * 24 * 3600 * 1000;
  let purged = false;
  for (const docId of dirs) {
    const doc = store.getDoc(docId);
    let newest = 0;
    for (const s of listAudioSegments(docId)) newest = Math.max(newest, s.time);
    const stale = newest && Date.now() - newest > maxAgeMs;
    if (!doc || doc.status === "signed" || !audioReviewOn() || stale) {
      const n = deleteAudio(docId);
      if (n) { purged = true; store.audit(null, "audio-purged", `${docId}: ${n} segment(s) deleted (${!doc ? "note gone" : doc.status === "signed" ? "signed" : stale ? "expired" : "review off"})`); }
    }
  }
  if (purged) bumpRev(); // let devices pick up the new audit entries
}
setInterval(() => { try { audioSweep(); } catch (e) { console.error("[audio] sweep failed:", e.message); } }, 3600 * 1000);

function readRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("audio too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ---- reminder scheduler ---- */
async function reminderTick() {
  const now = new Date().toISOString();
  let changed = 0;
  for (const appt of store.appointments()) {
    if (appt.status !== "booked") continue;
    for (const r of appt.reminders || []) {
      if (!r.status.startsWith("scheduled") || r.when > now) continue;
      const patient = store.getPatient(appt.patientId);
      const payload = {
        to: patient ? { name: store.patientName(patient), phone: patient.phone, email: patient.email } : null,
        method: r.method,
        visit: appt.start,
        message: `Reminder from ${store.settings().facilityName}: you have a physical therapy visit on ${new Date(appt.start).toLocaleString()}. Reply to reschedule.`,
      };
      let delivered = "sent (logged)";
      if (process.env.REMINDER_WEBHOOK) {
        try {
          await fetch(process.env.REMINDER_WEBHOOK, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          delivered = "sent (webhook)";
        } catch (e) {
          delivered = "send failed — will not retry";
          console.error("[reminder] webhook failed:", e.message);
        }
      }
      r.status = delivered;
      store.audit(null, "reminder-sent", `${payload.to ? payload.to.name : "?"} for ${appt.start} via ${r.method}`);
      console.log(`[reminder] ${delivered}: ${payload.message}`);
      changed++;
    }
  }
  if (changed) { store.save(); bumpRev(); }
}
// The reminder scheduler is started in start(), AFTER db.init() + store.load() —
// running it earlier would read the store before durable storage is ready.

/* ---- http ---- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 15 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    /* ---------- API ---------- */
    if (url.pathname === "/api/ping") {
      return json(res, 200, { ok: true, server: "therachart", rev, stt: sttStatus(), refine: geminiActive() ? "gemini" : "local" });
    }
    if (url.pathname === "/api/bootstrap") {
      return json(res, 200, bootstrapInfo());
    }
    if (url.pathname === "/api/refine-prompt") {
      return json(res, 200, { prompt: refineSystem(), model: GEMINI_MODEL, active: geminiActive() ? "gemini" : "local" });
    }
    if (url.pathname === "/api/ai-status") {
      const mode = geminiActive() ? "gemini" : "local";
      return json(res, 200, { refine: mode, insights: mode, model: GEMINI_MODEL, insightsModel: GEMINI_INSIGHTS_MODEL, provider: vertexConfigured() ? "vertex" : (activeGeminiKey() ? "api" : "local"), engine: geminiEngineDesc(), stt: sttStatus() });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      const identifier = body.email != null ? body.email : body.userId; // email is the login; userId kept for back-compat
      const secret = body.password != null ? body.password : body.pin;   // password; pin kept for back-compat
      const rlKey = String(identifier || "").trim().toLowerCase();        // rate-limit per identifier
      const lf = loginFails.get(rlKey) || { n: 0, lockUntil: 0 };
      if (lf.lockUntil > Date.now()) {
        return json(res, 429, { error: "Too many failed attempts — wait a minute and try again." });
      }
      const fail = store.login(identifier, secret);
      store.load().sessionUserId = null; // server holds no session in state
      store.save();
      if (fail) {
        lf.n += 1;
        if (lf.n >= 5) { lf.n = 0; lf.lockUntil = Date.now() + 60 * 1000; }
        if (loginFails.size > 1000) loginFails.clear(); // bound memory
        loginFails.set(rlKey, lf);
        return json(res, 401, { error: fail });
      }
      loginFails.delete(rlKey);
      const authed = store.findUserByLogin(identifier);
      bumpRev(); // audit entry was added
      return json(res, 200, { token: tokenFor(authed.id), userId: authed.id, rev, state: publicState() });
    }

    const user = userForReq(req);
    if (url.pathname.startsWith("/api/")) {
      if (!user) return json(res, 401, { error: "Not signed in." });

      if (url.pathname === "/api/rev") return json(res, 200, { rev });
      if (url.pathname === "/api/verify-password" && req.method === "POST") {
        // re-authenticate the signed-in user (used for e-signing / amending)
        const { password } = await readBody(req);
        return json(res, 200, { ok: store.verifyPassword(user.id, password) });
      }
      if (url.pathname === "/api/files" && req.method === "POST") {
        // upload attachment bytes out-of-band; returns a key the client stores
        // on the patient (never the bytes) so the synced blob stays small.
        const { name, type, dataBase64 } = await readBody(req);
        if (!dataBase64) return json(res, 400, { error: "No file data." });
        const buffer = Buffer.from(String(dataBase64), "base64");
        if (!buffer.length) return json(res, 400, { error: "Empty or invalid file data." });
        if (buffer.length > MAX_FILE_BYTES) return json(res, 413, { error: `File too large (limit ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).` });
        const key = `att/${store.uid("f")}`;
        try { await files.put(key, buffer, type || "application/octet-stream"); }
        catch (e) { return json(res, 502, { error: "Storage upload failed: " + e.message }); }
        store.audit(user.id, "file-uploaded", `${name || key} (${buffer.length} bytes)`);
        return json(res, 200, { key, size: buffer.length });
      }
      if (url.pathname === "/api/files" && req.method === "GET") {
        // stream a stored file back — but only if it's referenced by a real
        // attachment (that check is also the authorization gate + metadata source).
        const key = url.searchParams.get("key");
        const att = key && findAttachmentByKey(key);
        if (!att) return json(res, 404, { error: "File not found." });
        let f;
        try { f = await files.get(key); } catch (e) { return json(res, 502, { error: "Storage read failed: " + e.message }); }
        if (!f) return json(res, 404, { error: "File not found." });
        res.writeHead(200, {
          "content-type": att.type || f.contentType || "application/octet-stream",
          "content-disposition": `attachment; filename="${encodeURIComponent(att.name || "file").replace(/%20/g, " ")}"`,
          "cache-control": "private, no-store",
        });
        return res.end(f.buffer);
      }
      if (url.pathname === "/api/set-password" && req.method === "POST") {
        // self-service change (needs current password), or an admin setting
        // another user's password (needs the admin role, no current password).
        const { userId, currentPassword, newPassword } = await readBody(req);
        const targetId = userId && userId !== user.id ? userId : user.id;
        let mustChange = false;
        if (targetId !== user.id) {
          if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can change another user's password." });
          mustChange = true; // an admin-set password is temporary — force a change at next login
        } else if (!store.verifyPassword(user.id, currentPassword)) {
          return json(res, 403, { error: "Current password is incorrect." });
        }
        const result = store.setPassword(targetId, newPassword, user, { mustChange }); // hashes + audits
        if (result.error) return json(res, 400, { error: result.error });
        bumpRev();
        return json(res, 200, { ok: true, rev });
      }
      if (url.pathname === "/api/users" && req.method === "POST") {
        if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can add employees." });
        const result = store.addUser(await readBody(req), user); // password hashed server-side
        if (result.error) return json(res, 400, { error: result.error });
        bumpRev();
        return json(res, 200, { ok: true, rev, userId: result.user.id });
      }
      if (url.pathname === "/api/delete-user" && req.method === "POST") {
        if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can remove employees." });
        const { userId } = await readBody(req);
        const result = store.deleteUser(userId, user);
        if (result.error) return json(res, 400, { error: result.error });
        bumpRev();
        return json(res, 200, { ok: true, rev });
      }
      if (url.pathname === "/api/refine" && req.method === "POST") {
        const { transcript } = await readBody(req);
        if (!Array.isArray(transcript) || !transcript.length) return json(res, 400, { error: "No transcript to refine." });
        const clean = transcript.map((t) => String(t || "").slice(0, 2000)).slice(0, 500);
        const result = await refineTranscript(clean);
        return json(res, 200, result);
      }
      if (url.pathname === "/api/insights" && req.method === "POST") {
        const ctx = await readBody(req);
        const result = await clinicalInsights(ctx || {});
        return json(res, 200, result);
      }
      if (url.pathname === "/api/extract-doc" && req.method === "POST") {
        if (!store.canDocument(user)) return json(res, 403, { error: "Your account can’t create clinical documents." });
        const { pdf, mime } = await readBody(req);
        if (!pdf || typeof pdf !== "string") return json(res, 400, { error: "No document received." });
        if (pdf.length > 11 * 1024 * 1024) return json(res, 400, { error: "Document too large (limit ~8 MB)." });
        try {
          const result = await ai.extractRecords(pdf, mime, GEMINI_OPTS());
          return json(res, 200, result);
        } catch (e) {
          return json(res, e.code === 501 ? 501 : 500, { error: e.message });
        }
      }
      if (url.pathname === "/api/stt" && req.method === "POST") {
        const lang = (url.searchParams.get("lang") || "en-US").replace(/[^a-z-]/gi, "");
        const model = (url.searchParams.get("model") || "standard").replace(/[^a-z_]/gi, "");
        const docId = url.searchParams.get("docId") || "";
        const wav = await readRawBody(req);
        if (wav.length < 200) return json(res, 400, { error: "Empty audio." });
        // opt-in temporary retention: keep the raw segment for later review if
        // the facility enabled it and the patient consented (even if transcription
        // fails — the audio is exactly what you'd want to fall back on)
        const doc = docId ? store.getDoc(docId) : null;
        let retained = false;
        if (doc && audioRetentionOK(doc)) { try { saveAudioSegment(docId, wav); retained = true; } catch (e) { console.error("[audio] save failed:", e.message); } }
        try {
          const text = await transcribe(wav, lang, model);
          return json(res, 200, { text, retained });
        } catch (e) {
          return json(res, e.code === 501 ? 501 : 500, { error: e.message, retained });
        }
      }
      if (url.pathname === "/api/audio") {
        const docId = url.searchParams.get("docId") || "";
        const doc = docId ? store.getDoc(docId) : null;
        if (!doc) return json(res, 404, { error: "Document not found." });
        if (!store.canAccessEmr(user)) return json(res, 403, { error: "Not permitted." });
        if (req.method === "GET") {
          const seg = url.searchParams.get("seg");
          if (!seg) return json(res, 200, { segments: listAudioSegments(docId), reviewDays: audioReviewDays() });
          // stream one segment (auth already checked above)
          const safe = seg.replace(/[^a-z0-9_.-]/gi, "");
          const file = path.join(docAudioDir(docId), safe);
          if (!safe.endsWith(".wav") || !fs.existsSync(file)) return json(res, 404, { error: "Segment not found." });
          res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
          return fs.createReadStream(file).pipe(res);
        }
        if (req.method === "DELETE") {
          const n = deleteAudio(docId);
          if (n) { store.audit(user.id, "audio-deleted", `${doc.title}: ${n} segment(s)`); bumpRev(); }
          return json(res, 200, { deleted: n });
        }
        return json(res, 405, { error: "Method not allowed." });
      }
      if (url.pathname === "/api/state" && req.method === "GET") {
        return json(res, 200, { rev, state: publicState() });
      }
      if (url.pathname === "/api/state" && req.method === "PUT") {
        const { baseRev, state } = await readBody(req);
        if (baseRev !== rev) {
          return json(res, 409, { rev, state: publicState() });
        }
        if (!state || !Array.isArray(state.patients) || !Array.isArray(state.users)) {
          return json(res, 400, { error: "Malformed state." });
        }
        state.sessionUserId = null;
        // capture server-side password hashes so a device push (whose state has
        // them stripped) can't wipe or forge them
        const creds = new Map(store.users().map((u) => [u.id, u.passwordHash]));
        store.importAll(state, { preserveSession: false });
        for (const u of store.users()) {
          const h = creds.get(u.id);
          if (h) u.passwordHash = h; else delete u.passwordHash;
          delete u.pin; // clients can never introduce a plaintext credential
        }
        // Gemini is configured only via host env vars now — never let a client
        // push introduce or persist a stored key/flag
        const s = store.settings();
        delete s.geminiKey;
        delete s.geminiKeySet;
        store.save();
        bumpRev();
        try { audioSweep(); } catch (e) { console.error("[audio] sweep failed:", e.message); } // drop audio for notes just signed
        return json(res, 200, { rev });
      }
      return json(res, 404, { error: "Unknown API endpoint." });
    }

    /* ---------- static app ---------- */
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(ROOT, file);
    const rel = path.relative(ROOT, full);
    // never serve the database/session files (they hold PHI and the Gemini
    // key) or any hidden path over HTTP
    const inDataDir = !path.relative(path.resolve(DATA_DIR), full).startsWith("..");
    if (rel.startsWith("..") || inDataDir || rel.split(path.sep).some((s) => s.startsWith(".")) ||
        !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

async function start() {
  // Bring up durable storage FIRST (Postgres preload is async), then hydrate
  // the in-memory store, revision, and sessions from it before serving.
  const dbInfo = await db.init({ dataDir: DATA_DIR, databaseUrl: process.env.DATABASE_URL || null });
  const filesInfo = await files.init({ dataDir: DATA_DIR, bucket: GCS_BUCKET || null, getToken: GCS_BUCKET ? gcpAccessToken : null });
  store.load();
  const migrated = store.hashLegacyPins(); // one-time: plaintext pins -> scrypt hashes
  const emailed = store.ensureEmails();    // one-time: give pre-email-login accounts a login email
  const r = Number(db.get("rev")); if (r) rev = r;
  try { for (const [t, s] of Object.entries(JSON.parse(db.get("sessions") || "{}"))) sessions.set(t, s); } catch { }

  // Reminder scheduler — safe to touch the store now that it's hydrated.
  reminderTick().catch((e) => console.error(e));
  setInterval(() => reminderTick().catch((e) => console.error(e)), 60 * 1000);

  server.listen(PORT, () => {
    console.log(`TheraChart clinic server running:`);
    console.log(`  app:  http://localhost:${PORT}`);
    console.log(`  data: ${dbInfo.backend === "postgres" ? "Postgres (durable) — keys: " + dbInfo.keys.join(", ") : DATA_DIR + " (flat file)"}`);
    console.log(`  auth: email + hashed passwords (scrypt)${migrated ? ` — migrated ${migrated} legacy PIN(s)` : ""}${emailed ? ` — assigned ${emailed} login email(s)` : ""}`);
    console.log(`  files: ${filesInfo.backend === "gcs" ? `Google Cloud Storage (bucket ${filesInfo.bucket})` : filesInfo.dir + " (local disk — ephemeral on Cloud Run; set GCS_BUCKET)"}`);
    console.log(`  reminders: checking every 60s${process.env.REMINDER_WEBHOOK ? " → " + process.env.REMINDER_WEBHOOK : " (logged; set REMINDER_WEBHOOK to deliver)"}`);
    console.log(`  AI cleanup: ${geminiEngineDesc()}${geminiActive() ? ` — refine/extract: ${GEMINI_MODEL} · insights: ${GEMINI_INSIGHTS_MODEL}` : ""}`);
    console.log(`  dictation: ${sttConfigured() ? `Google Cloud Speech-to-Text (project ${GCP_PROJECT}, ${STT_LOCATION})` : "browser engine only (set GCP_PROJECT + credentials for Google Cloud STT — see GOOGLE_SETUP.md)"}`);
    console.log(`  audio review: ${audioReviewOn() ? `ON — consented segments kept up to ${audioReviewDays()} days, then auto-deleted (interim: ${AUDIO_DIR})` : "off (no audio stored)"}`);
    try { audioSweep(); } catch (e) { console.error("[audio] initial sweep failed:", e.message); }
  });
}

// Graceful shutdown: flush any pending writes so Cloud Run's SIGTERM (sent
// before an instance is stopped) doesn't drop the last in-memory changes.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${sig} received — flushing storage…`);
  try { await db.close(); } catch (e) { console.error("[db] shutdown flush failed:", e.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref(); // don't hang if a socket lingers
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((e) => { console.error("Startup failed:", e); process.exit(1); });
