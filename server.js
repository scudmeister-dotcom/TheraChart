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
const DATA_FILE = path.join(DATA_DIR, "therachart.json");
const REV_FILE = path.join(DATA_DIR, "rev");
// Temporary session-audio review (opt-in). Kept only to let a clinician re-check
// dictation, then auto-deleted on sign or after a few days. INTERIM: on Cloud Run
// this local disk is ephemeral — at go-live move these blobs to Cloud Storage
// (encrypted, lifecycle auto-delete) alongside the Cloud SQL migration.
const AUDIO_DIR = path.join(DATA_DIR, "audio");

/* ---- file-backed storage injected into the shared store ---- */
globalThis.THERACHART_STORAGE = {
  getItem() { try { return fs.readFileSync(DATA_FILE, "utf8"); } catch { return null; } },
  setItem(_, v) {
    fs.writeFileSync(DATA_FILE + ".tmp", v);
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  },
  removeItem() { try { fs.unlinkSync(DATA_FILE); } catch { } },
};
const store = require("./store.js");
const ai = require("./ai.js");
store.load();

/* ---- AI transcript refinement (Gemini, with a local fallback) ----
   Sends the TEXT transcript (not audio) to Google Gemini to split speakers,
   clean transcription errors, and re-extract the patient's findings. Set
   GEMINI_API_KEY to enable; otherwise a local heuristic refiner runs so the
   feature works with no key and no network. For PHI, use paid/Vertex AI
   Gemini under a signed BAA (point GEMINI_BASE_URL at your Vertex endpoint). */
const GEMINI_KEY = process.env.GEMINI_API_KEY || null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
// refine mode is computed dynamically (key may come from env OR facility settings)

const GEMINI_OPTS = () => ({ key: activeGeminiKey(), model: GEMINI_MODEL, base: GEMINI_BASE, onError: (w, e) => console.error(`[${w}] Gemini failed, using local:`, e.message) });

function activeGeminiKey() {
  return process.env.GEMINI_API_KEY || (store.settings().geminiKey || "").trim() || null;
}

const refineSystem = ai.refineSystem;
const refineTranscript = (utterances) => ai.refine(utterances, GEMINI_OPTS());
const clinicalInsights = (ctx) => ai.insightsRun(ctx, GEMINI_OPTS());

let rev = (() => { try { return Number(fs.readFileSync(REV_FILE, "utf8")) || 1; } catch { return 1; } })();
function bumpRev() { rev += 1; fs.writeFileSync(REV_FILE, String(rev)); }

/* ---- sessions (persisted so device tokens survive server restarts) ---- */
const SESS_FILE = path.join(DATA_DIR, "sessions.json");
const sessions = new Map(); // token -> { userId, at }
try {
  for (const [t, s] of Object.entries(JSON.parse(fs.readFileSync(SESS_FILE, "utf8")))) sessions.set(t, s);
} catch { }
function saveSessions() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000; // sessions expire after 30 days
  for (const [t, s] of sessions) if (s.at < cutoff) sessions.delete(t);
  fs.writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(sessions)));
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
  if (s.settings) {
    // devices only need to know whether a key is set, never its value
    s.settings.geminiKeySet = !!(s.settings.geminiKey && String(s.settings.geminiKey).trim());
    delete s.settings.geminiKey;
  }
  return s;
}
function bootstrapInfo() {
  return {
    rev,
    facilityName: store.settings().facilityName,
    users: store.users().map((u) => ({
      id: u.id, name: u.name, role: u.role, active: u.active,
      license: u.license ? { number: u.license.number, expires: u.license.expires } : null,
    })),
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
setInterval(() => reminderTick().catch((e) => console.error(e)), 60 * 1000);
reminderTick().catch((e) => console.error(e));

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
      return json(res, 200, { ok: true, server: "therachart", rev, stt: sttStatus(), refine: activeGeminiKey() ? "gemini" : "local" });
    }
    if (url.pathname === "/api/bootstrap") {
      return json(res, 200, bootstrapInfo());
    }
    if (url.pathname === "/api/refine-prompt") {
      return json(res, 200, { prompt: refineSystem(), model: GEMINI_MODEL, active: activeGeminiKey() ? "gemini" : "local" });
    }
    if (url.pathname === "/api/ai-status") {
      const mode = activeGeminiKey() ? "gemini" : "local";
      return json(res, 200, { refine: mode, insights: mode, model: GEMINI_MODEL, stt: sttStatus() });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const { userId, pin } = await readBody(req);
      const lf = loginFails.get(userId) || { n: 0, lockUntil: 0 };
      if (lf.lockUntil > Date.now()) {
        return json(res, 429, { error: "Too many failed attempts — wait a minute and try again." });
      }
      const fail = store.login(userId, pin);
      store.load().sessionUserId = null; // server holds no session in state
      store.save();
      if (fail) {
        lf.n += 1;
        if (lf.n >= 5) { lf.n = 0; lf.lockUntil = Date.now() + 60 * 1000; }
        if (loginFails.size > 1000) loginFails.clear(); // bound memory
        loginFails.set(userId, lf);
        return json(res, 401, { error: fail });
      }
      loginFails.delete(userId);
      bumpRev(); // audit entry was added
      return json(res, 200, { token: tokenFor(userId), rev, state: publicState() });
    }

    const user = userForReq(req);
    if (url.pathname.startsWith("/api/")) {
      if (!user) return json(res, 401, { error: "Not signed in." });

      if (url.pathname === "/api/rev") return json(res, 200, { rev });
      if (url.pathname === "/api/gemini-key" && req.method === "POST") {
        // the key is server-only config — set it here, never through synced state
        if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can change the Gemini key." });
        const { key } = await readBody(req);
        const k = String(key || "").trim();
        const s = store.settings();
        if (k) s.geminiKey = k; else delete s.geminiKey;
        store.save();
        store.audit(user.id, k ? "gemini-key-set" : "gemini-key-cleared", k ? "Gemini API key saved (server-only)" : "Gemini API key removed");
        bumpRev();
        return json(res, 200, { ok: true, rev, geminiKeySet: !!k, refine: activeGeminiKey() ? "gemini" : "local" });
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
        // the Gemini key is server-only and never travels in client state —
        // preserve it across the import so a device push can't wipe or set it
        const keepKey = store.settings().geminiKey;
        store.importAll(state, { preserveSession: false });
        const s = store.settings();
        delete s.geminiKeySet; // derived flag must never persist to disk
        if (keepKey) s.geminiKey = keepKey; else delete s.geminiKey;
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

server.listen(PORT, () => {
  console.log(`TheraChart clinic server running:`);
  console.log(`  app:  http://localhost:${PORT}`);
  console.log(`  data: ${DATA_FILE}`);
  console.log(`  reminders: checking every 60s${process.env.REMINDER_WEBHOOK ? " → " + process.env.REMINDER_WEBHOOK : " (logged; set REMINDER_WEBHOOK to deliver)"}`);
  console.log(`  AI cleanup: ${activeGeminiKey() ? `Gemini (${GEMINI_MODEL})` : "local heuristic (set GEMINI_API_KEY or a key in Facility Admin for Gemini)"}`);
  console.log(`  dictation: ${sttConfigured() ? `Google Cloud Speech-to-Text (project ${GCP_PROJECT}, ${STT_LOCATION})` : "browser engine only (set GCP_PROJECT + credentials for Google Cloud STT — see GOOGLE_SETUP.md)"}`);
  console.log(`  audio review: ${audioReviewOn() ? `ON — consented segments kept up to ${audioReviewDays()} days, then auto-deleted (interim: ${AUDIO_DIR})` : "off (no audio stored)"}`);
  try { audioSweep(); } catch (e) { console.error("[audio] initial sweep failed:", e.message); }
});
