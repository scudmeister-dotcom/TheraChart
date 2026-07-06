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
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DATA_DIR = process.env.THERACHART_DATA || path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "therachart.json");
const REV_FILE = path.join(DATA_DIR, "rev");

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

/* ---- self-hosted transcription (Whisper) ----
   The browser records speech, converts it to 16 kHz WAV locally, and POSTs
   it here. Audio is transcribed on THIS machine and deleted — it never
   reaches a third party. Engine resolution:
     1. WHISPER_CMD env — any shell command with {file} and optional {lang}
        placeholders (e.g. whisper.cpp: 'whisper-cli -m model.bin -nt -f {file}')
     2. bundled whisper/transcribe.py if python3 + faster-whisper are installed
     3. otherwise transcription reports "engine not installed" with setup help */

let whisperCmd = process.env.WHISPER_CMD || null;
let whisperReady = !!whisperCmd;

function detectWhisper() {
  if (whisperCmd) { console.log(`[whisper] using WHISPER_CMD`); return; }
  execFile("python3", ["-c", "import faster_whisper"], (err) => {
    if (!err) {
      whisperCmd = `python3 ${JSON.stringify(path.join(ROOT, "whisper", "transcribe.py"))} {file} {lang}`;
      whisperReady = true;
      console.log(`[whisper] faster-whisper detected — private transcription enabled (model: ${process.env.WHISPER_MODEL || "small"})`);
    } else {
      console.log("[whisper] not installed — run 'pip install faster-whisper' (or set WHISPER_CMD) to enable private transcription");
    }
  });
}
detectWhisper();

function transcribe(wavBuffer, lang) {
  return new Promise((resolve, reject) => {
    if (!whisperReady) {
      return reject(Object.assign(new Error(
        "Whisper is not installed on the clinic server. Run 'pip install faster-whisper' there (or set WHISPER_CMD) and restart."), { code: 501 }));
    }
    const tmp = path.join(DATA_DIR, `dictation-${crypto.randomBytes(6).toString("hex")}.wav`);
    fs.writeFileSync(tmp, wavBuffer);
    const cmd = whisperCmd.replace("{file}", JSON.stringify(tmp)).replace("{lang}", lang || "auto");
    execFile("/bin/sh", ["-c", cmd], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch { }
      if (err) return reject(new Error(`transcription failed: ${(stderr || err.message).slice(0, 400)}`));
      resolve(stdout.trim());
    });
  });
}

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
      return json(res, 200, { ok: true, server: "therachart", rev, whisper: whisperReady, refine: activeGeminiKey() ? "gemini" : "local" });
    }
    if (url.pathname === "/api/bootstrap") {
      return json(res, 200, bootstrapInfo());
    }
    if (url.pathname === "/api/refine-prompt") {
      return json(res, 200, { prompt: refineSystem(), model: GEMINI_MODEL, active: activeGeminiKey() ? "gemini" : "local" });
    }
    if (url.pathname === "/api/ai-status") {
      const mode = activeGeminiKey() ? "gemini" : "local";
      return json(res, 200, { refine: mode, insights: mode, model: GEMINI_MODEL });
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
      if (url.pathname === "/api/transcribe" && req.method === "POST") {
        const lang = (url.searchParams.get("lang") || "auto").replace(/[^a-z-]/gi, "");
        const wav = await readRawBody(req);
        if (wav.length < 200) return json(res, 400, { error: "Empty audio." });
        try {
          const text = await transcribe(wav, lang);
          return json(res, 200, { text });
        } catch (e) {
          return json(res, e.code === 501 ? 501 : 500, { error: e.message });
        }
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
});
