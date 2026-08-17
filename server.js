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
     BUG_REPORT_WEBHOOK optional URL; tester bug reports are POSTed to it as
                        JSON (with an optional screenshot as a data URL) so you
                        can forward them to email. Reports are stored on the
                        server either way — the webhook only delivers them.
*/

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process"); // local-dev gcloud credential only

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DATA_DIR = process.env.THERACHART_DATA || path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
// Temporary session-audio review (opt-in): raw dictation segments kept only to
// let a clinician re-check the transcript, then auto-deleted on sign or after a
// few days. Stored via files.js (Cloud Storage when GCS_BUCKET is set, so it's
// durable + lifecycle-managed; local disk otherwise).

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

/* ---- Google Sign-In (verify GIS ID tokens; zero-dependency) ----
   The browser's "Sign in with Google" button returns a signed JWT (an ID
   token). We verify it here against Google's public keys, then map the verified
   email to a role via the allowlist before minting our own session token — the
   same token password login issues. No OAuth *secret* is needed for this flow;
   only the public client id (also handed to the browser so the button can init).
     GOOGLE_CLIENT_ID    OAuth 2.0 Web client id — REQUIRED to enable the button
     GOOGLE_ALLOWLIST    "email:role, email:role; …" — who may sign in, and as what
                         (role ∈ therapist|admin|frontdesk; missing → therapist)
     GOOGLE_OWNER_EMAIL  always mapped to admin (default amador.moriles@gmail.com) */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_OWNER_EMAIL = (process.env.GOOGLE_OWNER_EMAIL || "amador.moriles@gmail.com").trim().toLowerCase();
const GOOGLE_ROLES = new Set(["therapist", "admin", "frontdesk"]);
/* The clinic that Google sign-ins join — the operator and anyone they
   allowlist. It must NOT be the seeded demo clinic: the demo logins and their
   password are printed on the sign-in screen, so sharing a clinic with them
   would leave real patient records under a publicly known admin account.
   Override with GOOGLE_CLINIC_ID to point staff at an existing clinic. */
const GOOGLE_CLINIC_ID = (process.env.GOOGLE_CLINIC_ID || "clinic-owner").trim();
const GOOGLE_CLINIC_NAME = (process.env.GOOGLE_CLINIC_NAME || "My Clinic").trim();

// email -> role, parsed once from GOOGLE_ALLOWLIST. The owner is always admin,
// so a minimal install (client id only, no allowlist) still lets the owner in.
const googleAllowlist = (() => {
  const map = new Map();
  for (const entry of String(process.env.GOOGLE_ALLOWLIST || "").split(/[,;\n]/)) {
    const [rawEmail, rawRole] = entry.split(":");
    const email = (rawEmail || "").trim().toLowerCase();
    if (!email) continue;
    const role = (rawRole || "").trim();
    map.set(email, GOOGLE_ROLES.has(role) ? role : "therapist");
  }
  map.set(GOOGLE_OWNER_EMAIL, "admin");
  return map;
})();

// Google's JWKS, cached (their signing keys rotate ~daily). Refetched on a kid
// miss or once the cache is older than an hour.
let _googleKeys = { at: 0, byKid: new Map() };
async function googleSigningKey(kid) {
  const fresh = Date.now() - _googleKeys.at < 60 * 60 * 1000;
  if (fresh && _googleKeys.byKid.has(kid)) return _googleKeys.byKid.get(kid);
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("could not fetch Google signing keys");
  const { keys } = await r.json();
  const byKid = new Map();
  for (const jwk of keys || []) byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
  _googleKeys = { at: Date.now(), byKid };
  return byKid.get(kid) || null;
}

const b64urlBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64urlJson = (s) => JSON.parse(b64urlBuf(s).toString("utf8"));

// Verify a Google ID token and return its claims, or throw. Validates the RS256
// signature against Google's keys, plus audience (our client id), issuer,
// expiry, and a present + verified email.
async function verifyGoogleIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, sig] = parts;
  const header = b64urlJson(h);
  if (header.alg !== "RS256") throw new Error("unexpected token algorithm");
  const key = await googleSigningKey(header.kid);
  if (!key) throw new Error("unknown signing key");
  if (!crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(key, b64urlBuf(sig)))
    throw new Error("bad signature");
  const claims = b64urlJson(p);
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com")
    throw new Error("wrong issuer");
  if (!GOOGLE_CLIENT_ID || claims.aud !== GOOGLE_CLIENT_ID) throw new Error("wrong audience");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("token expired");
  if (!claims.email || claims.email_verified !== true) throw new Error("email not verified");
  return claims;
}

/* ---- AI transcript refinement (Gemini, with a local fallback) ----
   Sends the TEXT transcript (not audio) to Google Gemini to split speakers,
   clean transcription errors, and re-extract the patient's findings.

   Two backends, both handled by ai.js (same request body, different auth):
     • Gemini API (consumer key) — set GEMINI_API_KEY. Simple, but NOT covered
       by a BAA — for demo / non-PHI only.
     • Vertex AI (OAuth, under a Google Cloud BAA) — set GEMINI_VERTEX=1 plus
       GCP_PROJECT and a Google credential (the SAME credential chain STT uses:
       GCP_ACCESS_TOKEN | GOOGLE_APPLICATION_CREDENTIALS | GCP_SA_KEY | Cloud Run
       metadata). This is the PHI-safe path. GEMINI_LOCATION defaults to
       "global" — the only Vertex location serving the Gemini 3.x models.
       No API key needed in this mode.
   With neither configured, a local heuristic refiner runs so the feature works
   with no key and no network. Mode is computed per-request (key may also come
   from facility settings). */
const GEMINI_MODEL = process.env.GEMINI_MODEL || ai.DEFAULT_MODEL;
const GEMINI_INSIGHTS_MODEL = process.env.GEMINI_INSIGHTS_MODEL || ai.DEFAULT_INSIGHTS_MODEL;
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_VERTEX = /^(1|true|yes|on)$/i.test(process.env.GEMINI_VERTEX || "");
// Gemini 3.x publisher models are served from the "global" Vertex location —
// regional endpoints (e.g. us-central1) 404 on them. Pin GEMINI_LOCATION only
// if data residency requires it AND the models exist in that region.
const GEMINI_LOCATION = process.env.GEMINI_LOCATION || "global";

/* ---------------- usage metering ----------------

   Until now nothing in this codebase recorded what a call actually cost, so
   every cost figure was derived from list prices rather than measured, a
   runaway tenant was invisible, and a usage-based price was unsellable.

   Two meters: Gemini tokens (reported by the API) and Speech-to-Text billed
   SECONDS (derived from the WAV we already hold, using Google's own
   round-up-to-the-next-second rule). Both are recorded per clinic per day.

   Thinking tokens are kept apart from answer tokens even though both bill as
   output — thinking is the dominant cost and the thing we tune, so folding it
   in would hide the effect of every change we make to thinkingLevel.

   Deliberately cheap: an in-memory tally flushed to the kv store, capped at 90
   days. This is a cost signal, not an accounting ledger, and it must never slow
   down or break a clinical call. */
const USAGE_KEY = "usageMeter";
const USAGE_DAYS = 90;
let usageDirty = false;
let usageCache = null;

function usageAll() {
  if (usageCache) return usageCache;
  try { usageCache = JSON.parse(db.get(USAGE_KEY) || "{}"); } catch { usageCache = {}; }
  return usageCache;
}

/** Record one unit of spend. `kind` is "gemini" or "stt".

    `purpose` splits the row by which feature spent it. A total that only moves
    up tells you a bill grew; it cannot tell you whether documentation got
    busier or one screen started looping, and those need different responses.
    Tokens are kept per purpose, not just call counts — attributing a spike
    needs pesos, and a cheap feature called often looks identical to an
    expensive one called twice if you only count calls. */
function meter(clinicId, kind, fields, purpose) {
  try {
    const all = usageAll();
    const day = new Date().toISOString().slice(0, 10);
    const cid = clinicId || DEFAULT_CLINIC;
    const bucket = (all[day] = all[day] || {});
    const clinic = (bucket[cid] = bucket[cid] || {});
    const row = (clinic[kind] = clinic[kind] || {});
    const bucketFor = purpose
      ? ((row.byPurpose = row.byPurpose || {})[purpose] = (row.byPurpose || {})[purpose] || {})
      : null;
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "number") {
        row[k] = (row[k] || 0) + v;
        if (bucketFor) bucketFor[k] = (bucketFor[k] || 0) + v;
      } else row[k] = v; // last-writer wins for labels like model
    }
    row.calls = (row.calls || 0) + 1;
    if (bucketFor) bucketFor.calls = (bucketFor.calls || 0) + 1;
    usageDirty = true;
  } catch (e) { console.error("[usage] meter failed:", e.message); }
}

// Flushed on a timer rather than per call: a clinical request must not wait on
// a write that only matters for billing.
setInterval(() => {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    const all = usageAll();
    const cutoff = new Date(Date.now() - USAGE_DAYS * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(all)) if (day < cutoff) delete all[day];
    db.set(USAGE_KEY, JSON.stringify(all));
    // drop rate buckets nobody has touched for a day, so the map cannot grow
    // without bound on a long-lived server with many tenants
    const stale = Date.now() - 86400000;
    for (const [k, b] of rateBuckets) if (b.dayStart < stale && b.minStart < stale) rateBuckets.delete(k);
  } catch (e) { console.error("[usage] flush failed:", e.message); }
}, 30000).unref?.();

/* ---------------- AI rate limits ----------------

   Every AI route checks a ROLE, and nothing checked a RATE. A signed-in account
   with the right role could call Gemini as fast as the network allowed, so the
   only thing standing between a retry loop and an open-ended bill was that
   nobody had written one yet. Individually these calls are cheap — the patient
   assistant measures about a peso for eight questions — which is exactly why
   volume, not unit cost, is the exposure.

   These are RUNAWAY DETECTORS, not quotas. Every limit is set several times
   above the busiest plausible clinic, because the failure mode of a limit that
   is too tight is a therapist blocked mid-visit, and that is far worse than the
   money. A twelve-therapist clinic documenting sixty visits a day sits at
   roughly a tenth of these.

   Per clinic rather than per user: the bill is per clinic, and a limit that one
   tenant could exhaust on another's behalf would be its own problem.

   Fixed windows rather than sliding — a boundary can let through up to double
   for one minute, which is irrelevant when the point is to catch something
   calling in a loop forever. */
const AI_LIMITS = {
  refine:    { perMin: 40,  perDay: 2000 },   // one per processed recording
  insights:  { perMin: 40,  perDay: 2000 },   // one per chart change
  assistant: { perMin: 20,  perDay: 600 },    // interactive, so genuinely open-ended
  blend:     { perMin: 30,  perDay: 600 },    // a button, a few fields per visit
  extract:   { perMin: 5,   perDay: 120 },    // whole PDFs, the priciest single call
  // STT chunks fan out in parallel — a 20-minute recording is ~24 at once — so
  // the per-minute figure has to clear a burst comfortably. Spend per visit is
  // already bounded by the per-visit ceiling in the recorder.
  stt:       { perMin: 200, perDay: 20000 },
};
const rateBuckets = new Map();

/** null if the call is allowed; otherwise details of the limit it hit. */
function rateHit(clinicId, purpose) {
  const lim = AI_LIMITS[purpose];
  if (!lim) return null;
  const now = Date.now();
  const key = `${clinicId || DEFAULT_CLINIC}:${purpose}`;
  let b = rateBuckets.get(key);
  if (!b) { b = { minStart: now, minCount: 0, dayStart: now, dayCount: 0 }; rateBuckets.set(key, b); }
  if (now - b.minStart >= 60000) { b.minStart = now; b.minCount = 0; }
  if (now - b.dayStart >= 86400000) { b.dayStart = now; b.dayCount = 0; }
  if (b.minCount >= lim.perMin)
    return { scope: "minute", limit: lim.perMin, retryAfter: Math.max(1, Math.ceil((60000 - (now - b.minStart)) / 1000)) };
  if (b.dayCount >= lim.perDay)
    return { scope: "day", limit: lim.perDay, retryAfter: Math.max(1, Math.ceil((86400000 - (now - b.dayStart)) / 1000)) };
  b.minCount += 1; b.dayCount += 1;
  return null;
}

/** Send a 429 and return true if this call is over the limit.

    The message is written for a clinician mid-visit, not an operator reading
    logs: it says the work is safe, what to do now, and who to tell. A recording
    survives this — the audio is still in IndexedDB and Process can be pressed
    again — and that is worth saying out loud. */
function aiRateLimited(res, req, user, purpose) {
  const hit = rateHit(clinicOfUser(user), purpose);
  if (!hit) return false;
  console.warn(`[ratelimit] clinic=${clinicOfUser(user)} purpose=${purpose} hit the per-${hit.scope} limit of ${hit.limit}`);
  res.setHeader("retry-after", String(hit.retryAfter));
  json(res, 429, {
    error: hit.scope === "minute"
      ? "The AI is handling a lot of requests from your clinic right now. Nothing has been lost — wait a moment and try again."
      : "Your clinic has reached today's limit for this AI feature. Nothing has been lost, and it resets automatically. If you are seeing this during normal work, tell your administrator — the limit is set well above ordinary use, so it usually means something is retrying in a loop.",
    retryAfter: hit.retryAfter,
    scope: hit.scope,
  });
  return true;
}

/** Billed seconds for a WAV, by Google's rule: round UP to the next second.
    16 kHz, 16-bit, mono = 32000 bytes/second, minus the 44-byte header. */
const wavBilledSeconds = (buf) => Math.max(1, Math.ceil((buf.length - 44) / 32000));

/* The PLATFORM OWNER — you, the operator — as opposed to a clinic's admin.

   A clinic admin runs their own clinic: staff, settings, their patients. The
   platform owner onboards clinics, which means creating tenants they are not a
   member of and seeing that every clinic exists. That is a strictly larger
   power, so it is a separate check rather than another `role`.

   Identity is the GOOGLE_OWNER_EMAIL address and nothing else. Deliberately NOT
   `role === "admin"`: every seeded demo login includes two admins whose password
   is printed on the public sign-in screen, so anything gated on the admin role
   alone is gated on a published credential. An account also has to be active,
   so revoking it revokes this too. */
const isPlatformOwner = (user) =>
  !!user && user.active !== false && String(user.email || "").trim().toLowerCase() === GOOGLE_OWNER_EMAIL;

const GEMINI_OPTS = (user, purpose) => {
  const onUsage = (u) => meter(clinicOfUser(user), "gemini",
    { model: u.model, in: u.in, out: u.out, thinking: u.thinking },
    purpose || u.purpose || "other");
  return vertexConfigured()
    ? { vertex: true, project: GCP_PROJECT, location: GEMINI_LOCATION, getToken: gcpAccessToken,
        model: GEMINI_MODEL, insightsModel: GEMINI_INSIGHTS_MODEL, purpose, onUsage,
        onError: (w, e) => console.error(`[${w}] Gemini (Vertex) failed, using local:`, e.message) }
    : { key: activeGeminiKey(), model: GEMINI_MODEL, insightsModel: GEMINI_INSIGHTS_MODEL, base: GEMINI_BASE,
        purpose, onUsage,
        onError: (w, e) => console.error(`[${w}] Gemini failed, using local:`, e.message) };
};

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
const refineTranscript = (utterances, user) => ai.refine(utterances, GEMINI_OPTS(user, "refine"));
const clinicalInsights = (ctx, user) => ai.insightsRun(ctx, GEMINI_OPTS(user, "insights"));
const patientAssistant = (chart, question, history, user) => ai.patientAssistant(chart, question, history, GEMINI_OPTS(user, "assistant"));

// rev + sessions persist through db (populated from it in start(), below).
let rev = 1;
function bumpRev() { rev += 1; db.set("rev", String(rev)); }

/* ---- sessions (persisted so device tokens survive server restarts) ---- */
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // sessions expire after 30 days
const sessions = new Map(); // token -> { userId, at }
function saveSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
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
  if (!sess) return null;
  // enforce expiry on READ, not just at login-time pruning
  if (Date.now() - sess.at > SESSION_TTL_MS) { sessions.delete(token); saveSessions(); return null; }
  const user = store.getUser(sess.userId);
  // a voided account's existing tokens must stop working immediately
  return user && user.active !== false ? user : null;
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

/* ---- clinic tenancy (enforced HERE, not in the browser) ----------------
   store.js also filters reads by clinic, but that is a rendering
   convenience: it runs on the device, after the bytes have already been
   delivered. The server is the only place a tenant boundary can actually
   be enforced, so every read is narrowed to the caller's clinic on the way
   out and every write is confined to it on the way in.

   Records predating tenancy carry no clinicId; they belong to the demo
   clinic, matching store.js's own fallback. Keep the two in step. */
const DEFAULT_CLINIC = "clinic-demo";
const TENANT_COLLECTIONS = ["patients", "documents", "appointments", "audit", "accessRequests", "users"];
const clinicOf = (rec) => (rec && rec.clinicId) || DEFAULT_CLINIC;
const clinicOfUser = (user) => (user && user.clinicId) || DEFAULT_CLINIC;
const sameClinic = (rec, user) => clinicOf(rec) === clinicOfUser(user);

/** The state a given user is allowed to receive: their clinic's slice only.
    `settings` stays shared (facility-wide scheduling defaults, per store.js). */
function scopedState(user) {
  const s = publicState();
  const cid = clinicOfUser(user);
  for (const k of TENANT_COLLECTIONS) {
    if (Array.isArray(s[k])) s[k] = s[k].filter((r) => clinicOf(r) === cid);
  }
  // a device has no business knowing which other clinics exist on this server
  if (s.clinics) s.clinics = { [cid]: s.clinics[cid] || { id: cid, name: store.clinicName(cid) } };
  // the device resolves settings from clinics[cid]; send the effective block
  // too so it never falls back to another clinic's legacy defaults
  s.settings = store.settingsFor(cid);
  return s;
}

/* Security-relevant user fields a device may never set by pushing state.
   Roles, licences and account status are what the EMR gates on, so they
   change only through the audited endpoints (/api/users, /api/delete-user,
   /api/set-password) or an admin edit within their own clinic. */
/* Fields a device may never set for ITSELF by pushing state. An admin can
   still change every one of them for a COLLEAGUE. These are the actual
   escalation vectors — the front-desk account that promoted itself to admin
   went through `role`. */
const SELF_LOCKED_FIELDS = ["role", "active", "clinicId", "email", "authProvider", "googleSub", "mustChangePassword"];
/* `license` is deliberately NOT self-locked. A sole admin — a one-person
   clinic, or the owner's freshly created clinic — has to be able to record
   their own licence number, or canDocument() never passes and they can never
   write a note at all. Locking it bought no real security either: an admin who
   wanted to fake a licence could create a second admin and have them enter it.
   The change is audited like any other. */
const USER_PRIVILEGE_FIELDS = [...SELF_LOCKED_FIELDS, "license"];

/** Fold a device's pushed state into the server's, confined to the pusher's
    clinic. Other clinics are carried over from the server verbatim, so a
    device physically cannot delete or alter a tenant it can't see. Returns
    { state } on success or { error } if the push tried to cross a boundary. */
function graftPushedState(pushed, user) {
  const cid = clinicOfUser(user);
  const server = JSON.parse(store.exportAll());
  const isAdmin = user.role === "admin";
  const out = { ...server };

  let dropped = 0;
  for (const k of TENANT_COLLECTIONS) {
    const incoming = Array.isArray(pushed[k]) ? pushed[k] : [];
    // Records stamped for another clinic are DROPPED, not rejected. Refusing the
    // whole push looked tidier but bricks a real workflow: on a shared clinic
    // device the previous user's records are still in localStorage when the next
    // person signs in, so their first sync legitimately carries another clinic's
    // rows. Dropping is equally safe — the device could never write them either
    // way — and lets the device recover instead of retrying a 403 forever.
    const foreign = incoming.filter((r) => r && r.clinicId && r.clinicId !== cid);
    dropped += foreign.length;
    const others = (server[k] || []).filter((r) => clinicOf(r) !== cid);
    const mine = incoming
      .filter((r) => !(r && r.clinicId && r.clinicId !== cid))
      .map((r) => ({ ...r, clinicId: cid })); // stamp legacy/unstamped
    out[k] = others.concat(mine);
  }
  if (dropped) console.warn(`[tenancy] dropped ${dropped} record(s) from another clinic in a push by ${user.id}`);

  /* Signed notes are append-only records. store.js's offline merge already
     says "a signed status always beats a draft" and unions signatures and
     amendments — but that only governs the merge path, so a straight PUT could
     quietly unsign a locked note and drop its signature. Re-assert the same
     rules here, where they are actually enforceable: a corrected note goes
     through the amendment flow, not through a state push. */
  const serverDocs = new Map((server.documents || []).map((d) => [d.id, d]));
  out.documents = (out.documents || []).map((doc) => {
    const prior = serverDocs.get(doc.id);
    if (!prior || prior.status !== "signed") return doc;
    const union = (a, b, keyFn) => {
      const seen = new Map();
      for (const it of [...(a || []), ...(b || [])]) if (it && !seen.has(keyFn(it))) seen.set(keyFn(it), it);
      return [...seen.values()];
    };
    return {
      ...doc,
      status: "signed",                                        // never downgraded
      signatures: union(prior.signatures, doc.signatures, (s) => `${s.time || s.at || ""}|${s.userId || s.by || ""}`),
      amendments: union(prior.amendments, doc.amendments, (x) => `${x.time || x.at || ""}|${x.userId || x.by || ""}`),
      history: union(prior.history, doc.history, (h) => `${h.time || ""}|${h.action || ""}|${h.userId || ""}`),
    };
  });

  // Users need field-level care: an admin may edit licences and account status
  // inside their own clinic (the staff screen does this through a state push),
  // but nobody may invent an account or edit their own privileges.
  const serverUsers = new Map((server.users || []).map((u) => [u.id, u]));
  const pushedById = new Map(out.users.filter((u) => u && u.id).map((u) => [u.id, u]));
  const reconciled = [];
  for (const existing of server.users || []) {
    if (clinicOf(existing) !== cid) continue;      // other clinics are restored verbatim below
    const pushedUser = pushedById.get(existing.id);
    // A push that simply omits an account must not delete it: removal runs
    // through /api/delete-user, which refuses to strand the last admin.
    if (!pushedUser) { reconciled.push(existing); continue; }
    const merged = { ...existing, ...pushedUser };
    for (const f of USER_PRIVILEGE_FIELDS) {
      // an admin may change a colleague's privileges, and their own licence,
      // but never their own role, account status or clinic
      const isSelf = pushedUser.id === user.id;
      const mayEdit = isAdmin && (!isSelf || !SELF_LOCKED_FIELDS.includes(f));
      if (mayEdit && Object.prototype.hasOwnProperty.call(pushedUser, f)) continue;
      if (Object.prototype.hasOwnProperty.call(existing, f)) merged[f] = existing[f];
      else delete merged[f];
    }
    merged.clinicId = cid; // never movable by a push, even by an admin
    reconciled.push(merged);
  }
  // accounts the push invented are dropped — /api/users is the only way in,
  // because it is what hashes a password and forces a change at first login
  out.users = (server.users || []).filter((u) => clinicOf(u) !== cid).concat(reconciled);

  /* The top-level `settings` block is the pre-tenancy default and is now
     FROZEN: a device is sent its clinic's effective settings under this key
     for convenience, so accepting it back would write one clinic's config
     into the shared fallback and leak it to every other clinic. Real settings
     changes arrive in clinics[cid].settings, handled just below. */
  out.settings = server.settings;
  // A clinic may be renamed — and its settings changed — only by its own
  // admin; every other clinic's entry is carried over from the server
  // untouched. This is where per-clinic settings actually arrive, since they
  // live in clinics[id].settings.
  out.clinics = { ...(server.clinics || {}) };
  if (isAdmin && pushed.clinics && typeof pushed.clinics === "object" && pushed.clinics[cid]) {
    out.clinics[cid] = { ...pushed.clinics[cid], id: cid };
  }

  // Gemini is configured purely from host env vars — never let a device push
  // introduce or persist a stored key, in the legacy block or a clinic's own.
  for (const block of [out.settings, ...Object.values(out.clinics).map((c) => c && c.settings)]) {
    if (block) { delete block.geminiKey; delete block.geminiKeySet; }
  }
  return { state: out };
}

// Locate an attachment by its storage key — scoped to the caller's clinic,
// because this lookup IS the download authorization gate (as well as the
// source of the file's name/type for the response headers).
function findAttachmentByKey(key, user) {
  if (!key) return null;
  for (const p of store.allPatients()) {
    if (!sameClinic(p, user)) continue;
    for (const a of p.attachments || []) if (a.key === key) return a;
  }
  return null;
}

/** Resolve a document id only if it belongs to the caller's clinic. */
function docForUser(docId, user) {
  const doc = docId ? store.getDoc(docId) : null;
  if (!doc) return null;
  // a document inherits its patient's clinic; fall back to its own stamp
  const patient = store.getPatient(doc.patientId);
  return sameClinic(patient || doc, user) ? doc : null;
}
function bootstrapInfo() {
  // NOTE: the employee roster is deliberately NOT exposed here — employees sign
  // in by email, so an unauthenticated visitor can't enumerate staff/PII.
  return {
    rev,
    facilityName: store.settingsFor(DEFAULT_CLINIC).facilityName, // pre-auth: no caller to scope to
    googleClientId: GOOGLE_CLIENT_ID, // "" when unconfigured → the button is hidden
    testAccounts: demoLogins(),       // seeded demo logins to surface on the sign-in screen
  };
}

/* Demo/test logins shown on the sign-in screen.

   These are genuinely useful — a sales demo or a tester should be able to click
   a row and be inside the app — but publishing a working admin password on an
   unauthenticated endpoint is not something that should happen by DEFAULT. It
   did: any deployment that ran the seed advertised grace@therachart.demo (an
   admin) and its password to anyone who fetched /api/bootstrap.

   So the panel is now opt-in. THERACHART_DEMO_LOGINS=1 turns it on for a demo
   box; a real clinic deployment simply doesn't set it and the endpoint returns
   an empty list, which makes the panel disappear on the sign-in screen.

   The accounts themselves still exist in the seed — this hides them, it does
   not disable them. Deleting the seeded accounts (or changing their passwords)
   is still the thing to do before real patients are on an instance. */
const DEMO_LOGINS_ENABLED = process.env.THERACHART_DEMO_LOGINS === "1";
const DEMO_LOGIN_PASSWORD = "1234";
const SEEDED_DEMO_IDS = new Set(store.SEEDED_DEMO_USER_IDS);
function demoLogins() {
  if (!DEMO_LOGINS_ENABLED) return [];
  const today = new Date().toISOString().slice(0, 10);
  return store.users()
    /* Match the seeded ids too, not just the email domain: store.ensureEmails()
       mints an @therachart.demo address for any account created without one —
       including a therapist the clinic adds through Calendar → "+ Add PT" — so
       the domain alone would eventually list real staff. */
    .filter((u) => /@therachart\.demo$/i.test(u.email || "") && SEEDED_DEMO_IDS.has(u.id))
    .slice(0, 10)
    .map((u) => {
      let status = "";
      if (u.active === false) status = "sign-in blocked (voided)";
      else if (u.role !== "frontdesk" && u.license && u.license.expires && u.license.expires < today)
        status = "license expired — EMR read-only";
      /* The clinic name groups the rows in the sign-in dropdown. It matters
         because u-fresh deliberately lives in its OWN empty clinic — listing it
         flat under "Demo Clinic" would promise the seeded charts and then open
         a blank EMR. Safe to publish: these are seeded demo clinics, and the
         demo clinic's name is already the public facilityName. */
      return {
        name: u.name, email: u.email, role: u.role, password: DEMO_LOGIN_PASSWORD, status,
        clinic: store.clinicName(clinicOfUser(u)),
      };
    });
}

/* ---- speech-to-text (Google Cloud Speech-to-Text v2, under your BAA) ----
   The browser records speech, encodes 16 kHz WAV in the page, and POSTs each
   short segment here. This proxies the audio to Google Cloud Speech-to-Text, so
   the audio travels only from your own server to Google under your Google Cloud
   BAA — never to a free/consumer speech service. Two models are offered:
     - "standard" → Google's latest_long model (lower cost)
     - "chirp"    → Google's Chirp universal model (multilingual, incl. fil-PH/ceb-PH)
     - "chirp2"   → Google's Chirp 2, the newer generation of the same family

   Configure with environment variables (see GOOGLE_SETUP.md):
     GCP_PROJECT   your Google Cloud project id           (required)
     STT_LOCATION  recognition region (default us-central1; chirp needs a region, not "global")
   Credentials — first one found wins:
     GCP_ACCESS_TOKEN                a short-lived OAuth token (quick tests: `gcloud auth print-access-token`)
     GOOGLE_APPLICATION_CREDENTIALS  path to a service-account key JSON (local dev)
     GCP_SA_KEY                      the service-account key JSON inline (one env var)
     GCP_USE_GCLOUD=1                local dev: ask the developer's own gcloud for a
                                     token whenever the cache lapses. Unlike a pasted
                                     GCP_ACCESS_TOKEN this never goes stale mid-session,
                                     and unlike a key file it writes no long-lived
                                     credential to disk (key creation is disabled by
                                     org policy anyway). Ignored where gcloud is absent,
                                     so it can never affect Cloud Run.
     (on Cloud Run / GCE nothing is needed — the attached service account is used automatically) */

const GCP_PROJECT = process.env.GCP_PROJECT || "";
const STT_LOCATION = process.env.STT_LOCATION || "us-central1";
/* Which Google Speech-to-Text v2 model each engine choice maps to.

   chirp_2 is Google's newer universal model and is the one to use for Filipino
   clinics: verified against the live locations API, fil-PH and ceb-PH are both
   GA on chirp AND chirp_2 in us-central1 and asia-southeast1. chirp_3 is
   advertised in the docs but the API refuses it for this project ("no longer
   generally available"), so it is deliberately not offered.

   Keep "chirp" as its own option rather than silently upgrading everyone: the
   two models transcribe Taglish differently, and a clinic should be able to
   A/B them on their own accents rather than take our word for it. */
const STT_MODELS = { standard: "latest_long", chirp: "chirp", chirp2: "chirp_2" };
// Models Google will only run on English, and what to use instead. Verified
// against the live locations API: fil-PH and ceb-PH are GA on chirp and chirp_2.
const ENGLISH_ONLY_MODELS = new Set(["latest_long"]);
const MULTILINGUAL_MODEL = "chirp_2";

function sttCredentialSource() {
  if (process.env.GCP_ACCESS_TOKEN) return "token";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return "key-file";
  if (process.env.GCP_SA_KEY) return "key-inline";
  if (/^(1|true|yes|on)$/i.test(process.env.GCP_USE_GCLOUD || "") && gcloudPath()) return "gcloud";
  if (process.env.K_SERVICE || process.env.GCE_METADATA_HOST) return "metadata"; // Cloud Run / GCE
  return null;
}

// Where the developer's gcloud lives, resolved once. Null when it isn't
// installed, which is what keeps the "gcloud" source out of the chain on
// Cloud Run. Set GCLOUD_PATH to override.
let _gcloudBin;
function gcloudPath() {
  if (_gcloudBin !== undefined) return _gcloudBin;
  _gcloudBin = [
    process.env.GCLOUD_PATH,
    path.join(process.env.HOME || "", "google-cloud-sdk/bin/gcloud"),
    "/opt/homebrew/bin/gcloud",
    "/usr/local/bin/gcloud",
  ].find((p) => p && fs.existsSync(p)) || null;
  return _gcloudBin;
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
  if (src === "gcloud") {
    const out = await new Promise((resolve, reject) => {
      execFile(gcloudPath(), ["auth", "print-access-token"], { timeout: 20000 }, (err, stdout, stderr) =>
        err ? reject(new Error(`gcloud auth print-access-token failed: ${(stderr || err.message).trim().slice(0, 200)}`))
            : resolve(stdout));
    });
    const value = out.trim();
    if (!value) throw new Error("gcloud returned an empty access token — run `gcloud auth login`.");
    // gcloud tokens last an hour; refresh a little early, same as the others.
    _tok = { value, exp: now + 50 * 60 * 1000 };
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
  let model = STT_MODELS[modelKey] || STT_MODELS.standard;

  /* latest_long is English-centric. Google refuses it outright for fil-PH and
     ceb-PH ("language not supported by the model"), so a therapist who picked
     Tagalog while the engine sat on Standard lost the whole segment with only
     a generic failure to show for it — on the one feature the product is sold
     on. Rather than fail, move to the multilingual model and report which one
     actually ran, so the UI can say so instead of pretending nothing changed. */
  if (ENGLISH_ONLY_MODELS.has(model) && !/^en\b|^en[-_]/i.test(String(lang || ""))) {
    model = MULTILINGUAL_MODEL;
  }
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
  const text = (data.results || [])
    .map((res) => (res.alternatives && res.alternatives[0] && res.alternatives[0].transcript) || "")
    .join(" ").trim();
  return { text, model };
}

/* ---- temporary session-audio review (opt-in, auto-deleting) ----
   Audio is kept ONLY when the whole chain opts in: the facility turned the
   feature on, the patient consented, and the note isn't signed yet. It exists
   just long enough for a clinician to re-check the dictation, then it's deleted
   the moment the note is signed (or by the sweep after `audioReviewDays`). This
   is the one exception to "TheraChart never stores audio," and it's disclosed. */
/* Audio retention is decided per CLINIC — one clinic's admin must never be
   able to switch on audio keeping for another clinic's patients — so every
   lookup here is keyed off the record's own clinic, not a server-wide flag. */
const clinicOfDoc = (doc) => {
  if (!doc) return DEFAULT_CLINIC;
  const p = store.getPatient(doc.patientId);
  return clinicOf(p || doc);
};
function audioReviewDays(clinicId) { return Math.max(1, Number(store.settingsFor(clinicId).audioReviewDays) || 7); }
function audioReviewOn(clinicId) { return !!store.settingsFor(clinicId).audioReview; }

// server-side gate: may we keep audio for this document right now?
function audioRetentionOK(doc) {
  if (!doc || doc.status === "signed") return false;
  if (!audioReviewOn(clinicOfDoc(doc))) return false;
  const p = store.getPatient(doc.patientId);
  return !!(p && p.audioConsent && p.audioConsent.granted);
}
// Audio segments live in the file store (GCS or local) under audio/<docId>/,
// so on Cloud Run they persist + auto-delete just like attachments — not on the
// ephemeral disk. Filenames still start with the timestamp for ordering/aging.
const audioPrefix = (docId) => `audio/${String(docId).replace(/[^a-z0-9_-]/gi, "")}/`;
const audioSegKey = (docId, name) => audioPrefix(docId) + String(name).replace(/[^0-9a-zA-Z._-]/g, "");

async function saveAudioSegment(docId, wavBuffer) {
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`;
  await files.put(audioPrefix(docId) + name, wavBuffer, "audio/wav");
  return name;
}
async function listAudioSegments(docId) {
  const items = await files.list(audioPrefix(docId));
  return items
    .map((it) => { const name = it.key.split("/").pop(); return { id: name, time: Number(name.split("-")[0]) || 0, size: it.size }; })
    .sort((a, b) => a.time - b.time);
}
async function deleteAudio(docId) {
  const items = await files.list(audioPrefix(docId));
  for (const it of items) await files.del(it.key);
  return items.length;
}

// backstop sweep: drop audio for notes that are now signed, gone, or too old
async function audioSweep() {
  const items = await files.list("audio/");
  const byDoc = new Map(); // docId -> [{ key, time }]
  for (const it of items) {
    const parts = it.key.split("/"); // audio/<docId>/<name>
    if (parts.length < 3) continue;
    const name = parts[2];
    if (!byDoc.has(parts[1])) byDoc.set(parts[1], []);
    byDoc.get(parts[1]).push({ key: it.key, time: Number(name.split("-")[0]) || 0 });
  }
  let purged = false;
  for (const [docId, segs] of byDoc) {
    const doc = store.getDoc(docId);
    // retention window and the review flag both come from the note's own
    // clinic; orphaned audio falls back to the default clinic's window
    const cid = doc ? clinicOfDoc(doc) : DEFAULT_CLINIC;
    const maxAgeMs = audioReviewDays(cid) * 24 * 3600 * 1000;
    const newest = segs.reduce((m, s) => Math.max(m, s.time), 0);
    const stale = newest && Date.now() - newest > maxAgeMs;
    if (!doc || doc.status === "signed" || !audioReviewOn(cid) || stale) {
      for (const s of segs) await files.del(s.key);
      purged = true;
      store.audit(null, "audio-purged", `${docId}: ${segs.length} segment(s) deleted (${!doc ? "note gone" : doc.status === "signed" ? "signed" : stale ? "expired" : "review off"})`);
    }
  }
  if (purged) bumpRev(); // let devices pick up the new audit entries
}
setInterval(() => { audioSweep().catch((e) => console.error("[audio] sweep failed:", e.message)); }, 3600 * 1000);

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
  for (const appt of store.allAppointments()) {
    if (appt.status !== "booked") continue;
    for (const r of appt.reminders || []) {
      if (!r.status.startsWith("scheduled") || r.when > now) continue;
      const patient = store.getPatient(appt.patientId);
      const payload = {
        to: patient ? { name: store.patientName(patient), phone: patient.phone, email: patient.email } : null,
        method: r.method,
        visit: appt.start,
        message: `Reminder from ${store.settingsFor(clinicOf(patient || appt)).facilityName}: you have a physical therapy visit on ${new Date(appt.start).toLocaleString()}. Reply to reschedule.`,
      };
      let delivered = "sent (logged)";
      if (process.env.REMINDER_WEBHOOK) {
        try {
          await fetch(process.env.REMINDER_WEBHOOK, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
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
  // the walkthrough screenshots are JPEG — without this they fall through to
  // application/octet-stream and the browser offers to download them
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json",
};

/* Which files are actually the web app.
   The server shares a directory with the code that runs it — server.js, db.js,
   ai.js, files.js, the deploy script, the tests — and a plain "serve anything
   under ROOT" handler published all of it. None of it is secret (the repo is
   public and credentials come from env vars), but deploy-gcp.sh names the
   project and buckets, and an allowlist means anything added server-side later
   is private by default rather than public by accident. */
const CLIENT_FILES = new Set([
  "/index.html", "/styles.css", "/sw.js", "/manifest.webmanifest",
  // the scripts index.html loads, in order
  "/parser.js", "/insights.js", "/clinical.js", "/validate.js", "/store.js", "/app.js", "/sync.js",
]);
const CLIENT_DIRS = ["/icons/", "/assets/", "/marketing-screenshots/"];
const isClientAsset = (webPath) =>
  CLIENT_FILES.has(webPath) || CLIENT_DIRS.some((d) => webPath.startsWith(d));

/* Compress JSON responses.

   This is a cost line, not a nicety. A device polls /api/rev every 6s and
   refetches the WHOLE clinic state whenever the revision moved, so a busy
   clinic re-downloads the entire record set hundreds of times a day. Uncompressed
   that dominates the bill: modelled at three clinic sizes, egress ran several
   times the AI spend and grew with chart history, while the clinical text itself
   gzips roughly 8:1 because it is repetitive JSON.

   Applied in json() so all ~70 call sites get it at once. Skipped below 1 KB,
   where the header overhead and CPU are not worth it, and skipped entirely for a
   client that did not offer gzip. Async rather than gzipSync: the service runs
   --max-instances 1, so blocking the event loop on a multi-megabyte payload
   would stall every other request behind it.

   This does NOT make the whole-blob sync design correct — a delta/since-rev
   endpoint is the real fix. It buys the room to do that later. */
const GZIP_MIN_BYTES = 1024;

function json(res, code, obj) {
  if (res.headersSent) { try { res.end(); } catch { } return; } // never re-write headers mid-response
  const body = JSON.stringify(obj);
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const accepts = String((res.req && res.req.headers && res.req.headers["accept-encoding"]) || "");

  if (Buffer.byteLength(body) < GZIP_MIN_BYTES || !/\bgzip\b/i.test(accepts)) {
    res.writeHead(code, headers);
    return res.end(body);
  }
  zlib.gzip(body, (err, buf) => {
    if (res.headersSent) return;                       // client vanished mid-compress
    if (err) {                                          // never fail a response over compression
      res.writeHead(code, headers);
      return res.end(body);
    }
    res.writeHead(code, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" });
    res.end(buf);
  });
}

/* Errors that reach a client must not carry internals. Node's messages
   routinely embed absolute filesystem paths, database hosts and storage bucket
   keys, and the top-level catch at the bottom of the request handler sits
   OUTSIDE the auth check — so an unauthenticated caller could read them by
   provoking an exception. Log the real error against a short reference and
   return only the reference, so a user's report can still be tied to a log
   line without publishing the internals. */
function fail(res, code, message, e, req) {
  const ref = crypto.randomBytes(4).toString("hex");
  console.error(`[error ${ref}] ${req ? `${req.method} ${req.url}` : ""} —`, e);
  return json(res, code, { error: message, ref });
}

/* Confirm a change is durably stored BEFORE telling the client it saved.

   db.js keeps a write-behind cache, so store.save() returns as soon as memory
   is updated and the row is written in the background. When the database is
   unreachable that write is discarded with only a log line — which means a
   clinician can sign a note, see the green "Synced with clinic server" badge,
   and lose the record when the container restarts.

   Applied to the endpoints that carry clinical data or credentials. Login is
   deliberately NOT gated: its only write is an audit row, and being able to
   READ charts through a brief database blip is worth more clinically than
   refusing to open the app. The first write after that will still fail loudly.

   Returns true when the change is safely stored; when false, a response has
   already been sent and the caller must return. */
async function persisted(res, req) {
  try { await db.flushNow(); return true; }
  catch (e) {
    fail(res, 503,
      "Your change was NOT saved to the clinic server — its database is unreachable. Do not rely on this record; try again once the server is back.",
      e, req);
    return false;
  }
}

function readBody(req, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) { reject(new Error("body too large")); req.destroy(); }
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
      // assistant is model-only (no local fallback): available only when Gemini/Vertex is configured
      return json(res, 200, { refine: mode, insights: mode, assistant: geminiActive() ? mode : "unavailable", model: GEMINI_MODEL, insightsModel: GEMINI_INSIGHTS_MODEL, provider: vertexConfigured() ? "vertex" : (activeGeminiKey() ? "api" : "local"), engine: geminiEngineDesc(), stt: sttStatus() });
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
        if (loginFails.size > 1000) {
          // Bound memory WITHOUT dropping live lockouts: clearing the whole map
          // let an attacker flush a victim's hold by spraying junk identifiers,
          // then resume guessing. Evict lapsed entries first, and only fall back
          // to dropping the oldest if every entry is still holding a lock.
          const now = Date.now();
          for (const [k, v] of loginFails) if (v.lockUntil <= now) loginFails.delete(k);
          for (const k of loginFails.keys()) {
            if (loginFails.size <= 1000) break;
            loginFails.delete(k);
          }
        }
        loginFails.set(rlKey, lf);
        return json(res, 401, { error: fail });
      }
      loginFails.delete(rlKey);
      const authed = store.findUserByLogin(identifier);
      bumpRev(); // audit entry was added
      return json(res, 200, { token: tokenFor(authed.id), userId: authed.id, rev, isOwner: isPlatformOwner(authed), state: scopedState(authed) });
    }

    if (url.pathname === "/api/google-login" && req.method === "POST") {
      if (!GOOGLE_CLIENT_ID) return json(res, 503, { error: "Google sign-in isn't configured on this server." });
      const { credential } = await readBody(req);
      let claims;
      try { claims = await verifyGoogleIdToken(credential); }
      catch (e) { return json(res, 401, { error: "Google sign-in couldn't be verified (" + e.message + ")." }); }
      const email = String(claims.email).trim().toLowerCase();
      // The env allowlist is one source of truth; an admin approving an access
      // request is the other — it provisions an active Google account, so that
      // account may sign in from then on even without an allowlist entry.
      let role = googleAllowlist.get(email);
      if (!role) {
        const approved = store.getUserByEmail(email);
        if (approved && approved.active && approved.authProvider === "google") role = approved.role;
      }
      if (!role) {
        // Not authorized yet: queue a request for an admin to approve, instead
        // of a dead end. (Deduped by email while pending.)
        // into the clinic an approved Google sign-in would join, so the request
        // reaches whoever can actually act on it
        store.requestAccess({ email, name: claims.name, googleSub: claims.sub, source: "google", clinicId: GOOGLE_CLINIC_ID });
        store.audit(null, "login-denied", `google:${email} (awaiting approval)`);
        bumpRev();
        return json(res, 403, { error: "Your access request has been sent to an administrator for approval. You'll be able to sign in once it's approved." });
      }
      const r = store.upsertGoogleUser({ email, name: claims.name, role, googleSub: claims.sub, clinicId: GOOGLE_CLINIC_ID });
      if (r.error) return json(res, 400, { error: r.error });
      // give the clinic a readable name the first time someone lands in it,
      // so Facility Admin doesn't show a bare id
      store.ensureClinic(r.user.clinicId, GOOGLE_CLINIC_NAME);
      store.load().sessionUserId = null; // server holds no session in state
      store.save();
      bumpRev(); // audit entries (login / user-created) were added
      return json(res, 200, { token: tokenFor(r.user.id), userId: r.user.id, rev, isOwner: isPlatformOwner(r.user), state: scopedState(r.user) });
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
        // base64 inflates the file ~4/3, so size the body limit off MAX_FILE_BYTES
        const { name, type, dataBase64 } = await readBody(req, Math.ceil(MAX_FILE_BYTES * 4 / 3) + 1024 * 1024);
        if (!dataBase64) return json(res, 400, { error: "No file data." });
        const buffer = Buffer.from(String(dataBase64), "base64");
        if (!buffer.length) return json(res, 400, { error: "Empty or invalid file data." });
        if (buffer.length > MAX_FILE_BYTES) return json(res, 413, { error: `File too large (limit ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).` });
        const key = `att/${store.uid("f")}`;
        try { await files.put(key, buffer, type || "application/octet-stream"); }
        catch (e) { return fail(res, 502, "Storage upload failed.", e, req); }
        store.audit(user.id, "file-uploaded", `${name || key} (${buffer.length} bytes)`);
        return json(res, 200, { key, size: buffer.length });
      }
      if (url.pathname === "/api/files" && req.method === "GET") {
        // stream a stored file back — but only if it's referenced by a real
        // attachment (that check is also the authorization gate + metadata source).
        const key = url.searchParams.get("key");
        const att = key && findAttachmentByKey(key, user);
        if (!att) return json(res, 404, { error: "File not found." });
        let f;
        try { f = await files.get(key); } catch (e) { return fail(res, 502, "Storage read failed.", e, req); }
        if (!f) return json(res, 404, { error: "File not found." });
        res.writeHead(200, {
          "content-type": att.type || f.contentType || "application/octet-stream",
          "content-disposition": `attachment; filename="${encodeURIComponent(att.name || "file").replace(/%20/g, " ")}"`,
          "cache-control": "private, no-store",
        });
        return res.end(f.buffer);
      }
      if (url.pathname === "/api/verify-google" && req.method === "POST") {
        /* Re-authenticate the SIGNED-IN user with a fresh Google ID token, for
           e-signing and amending. A Google account has no password, so the
           usual /api/verify-password can never pass for one — re-confirming
           with the same provider they signed in with is the equivalent act.

           The token must belong to THIS user: a valid Google token proves only
           that somebody has a Google account, so the verified email has to
           match the session's, or anyone could sign another clinician's note
           from their own Google login. */
        if (!GOOGLE_CLIENT_ID) return json(res, 503, { error: "Google sign-in isn't configured on this server." });
        const { credential } = await readBody(req);
        let claims;
        try { claims = await verifyGoogleIdToken(credential); }
        catch (e) { return json(res, 200, { ok: false, error: "Google couldn't verify that (" + e.message + ")." }); }
        const same = String(claims.email || "").trim().toLowerCase() === String(user.email || "").trim().toLowerCase();
        if (!same) {
          store.audit(user.id, "esign-verify-failed", `google account ${claims.email} does not match ${user.email}`);
          bumpRev();
          return json(res, 200, { ok: false, error: "That Google account isn't the one signed in here." });
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/set-password" && req.method === "POST") {
        // self-service change (needs current password), or an admin setting
        // another user's password (needs the admin role, no current password).
        const { userId, currentPassword, newPassword } = await readBody(req);
        const targetId = userId && userId !== user.id ? userId : user.id;
        let mustChange = false;
        if (targetId !== user.id) {
          if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can change another user's password." });
          // being an admin somewhere is not being an admin everywhere: without
          // this check any clinic's admin could seize any account on the server
          if (!sameClinic(store.getUser(targetId), user)) return json(res, 404, { error: "User not found." });
          mustChange = true; // an admin-set password is temporary — force a change at next login
        } else if (!store.verifyPassword(user.id, currentPassword)) {
          return json(res, 403, { error: "Current password is incorrect." });
        }
        const result = store.setPassword(targetId, newPassword, user, { mustChange }); // hashes + audits
        if (result.error) return json(res, 400, { error: result.error });
        bumpRev();
        if (!(await persisted(res, req))) return;
        return json(res, 200, { ok: true, rev });
      }
      /* ---- bug reports from testers ----
         Testers are the most valuable source of defects this product has, and
         the friction between "that's odd" and a written report is where most
         reports die. So this takes a note, an optional screenshot and the
         context the tester would otherwise have to describe by hand, and files
         it in one click.

         Stored server-side under its own key rather than in the clinic state
         blob: reports are not clinical data, and putting them in the blob would
         sync every tester's complaints to every device in the clinic.

         Delivery is the same webhook pattern the reminder scheduler uses. The
         report is persisted FIRST and the webhook is best-effort, so a broken
         or unconfigured webhook loses a note instead of the report. */
      if (url.pathname === "/api/bug-report" && req.method === "POST") {
        const body = await readBody(req);
        const clip = (v, n) => String(v == null ? "" : v).slice(0, n).trim();
        const report = {
          id: "bug-" + crypto.randomBytes(5).toString("hex"),
          at: new Date().toISOString(),
          summary: clip(body.summary, 2000),
          expected: clip(body.expected, 2000),
          steps: clip(body.steps, 4000),
          severity: ["blocks-me", "annoying", "cosmetic", "idea"].includes(body.severity) ? body.severity : "annoying",
          reporter: { id: user.id, name: user.name, role: user.role, email: user.email || "" },
          clinic: clinicOfUser(user),
          context: {
            route: clip((body.context || {}).route, 200),
            screen: clip((body.context || {}).screen, 60),
            browser: clip((body.context || {}).browser, 300),
            online: !!(body.context || {}).online,
            appRev: rev,
            model: GEMINI_MODEL,
          },
        };
        if (!report.summary) return json(res, 400, { error: "Tell us what happened, in a sentence or two." });

        // A screenshot is a data: URL; cap it so one report can't fill the row.
        const shot = String(body.screenshot || "");
        const shotOk = /^data:image\/(png|jpeg|webp);base64,/.test(shot) && shot.length <= 4 * 1024 * 1024;
        if (shot && !shotOk) return json(res, 400, { error: "That screenshot is too large or not an image. Keep it under 4 MB." });

        let stored = false;
        try {
          const prior = JSON.parse(db.get("bugReports") || "[]");
          // newest first, capped — the webhook is the real inbox
          prior.unshift({ ...report, screenshot: shotOk ? shot : null });
          db.set("bugReports", JSON.stringify(prior.slice(0, 200)));
          await db.flushNow();
          stored = true;
        } catch (e) { console.error("[bug] could not store report:", e.message); }

        let delivered = false;
        if (process.env.BUG_REPORT_WEBHOOK) {
          try {
            const r = await fetch(process.env.BUG_REPORT_WEBHOOK, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...report, screenshot: shotOk ? shot : null }),
              signal: AbortSignal.timeout(20000),
            });
            delivered = r.ok;
            if (!r.ok) console.error("[bug] webhook returned", r.status);
          } catch (e) { console.error("[bug] webhook failed:", e.message); }
        }
        console.log(`[bug] ${report.id} from ${report.reporter.name} (${report.severity}) — stored=${stored} delivered=${delivered}: ${report.summary.slice(0, 90)}`);
        if (!stored && !delivered) return json(res, 500, { error: "Couldn't file that report. Please tell Amador directly." });
        return json(res, 200, { ok: true, id: report.id, delivered });
      }

      /* What this clinic has actually spent. Admin-only: it is commercial
         information, and on a multi-tenant server one clinic must not see
         another's volumes. Prices are applied here rather than stored, so a
         rate change re-prices history instead of leaving it stale. */
      if (url.pathname === "/api/usage" && req.method === "GET") {
        if (user.role !== "admin") return json(res, 403, { error: "Admins only." });
        const cid = clinicOfUser(user);
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
        const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const all = usageAll();
        const out = { from, to: new Date().toISOString().slice(0, 10), days, byDay: {}, byPurpose: {},
          totals: { geminiIn: 0, geminiOut: 0, geminiThinking: 0, geminiCalls: 0, sttSeconds: 0, sttCalls: 0 } };
        for (const [day, clinics] of Object.entries(all)) {
          if (day < from) continue;
          const row = (clinics || {})[cid];
          if (!row) continue;
          const g = row.gemini || {}, t = row.stt || {};
          out.byDay[day] = {
            geminiIn: g.in || 0, geminiOut: g.out || 0, geminiThinking: g.thinking || 0,
            geminiCalls: g.calls || 0, sttSeconds: t.seconds || 0, sttCalls: t.calls || 0,
          };
          out.totals.geminiIn += g.in || 0; out.totals.geminiOut += g.out || 0;
          out.totals.geminiThinking += g.thinking || 0; out.totals.geminiCalls += g.calls || 0;
          out.totals.sttSeconds += t.seconds || 0; out.totals.sttCalls += t.calls || 0;
          // which feature spent it — the question a total cannot answer
          for (const [p, v] of Object.entries(g.byPurpose || {})) {
            const acc = (out.byPurpose[p] = out.byPurpose[p] || { in: 0, out: 0, thinking: 0, calls: 0 });
            acc.in += v.in || 0; acc.out += v.out || 0;
            acc.thinking += v.thinking || 0; acc.calls += v.calls || 0;
          }
        }
        /* List prices, August 2026 (Gemini 3.7 Flash introductory to
           2026-12-31; Speech-to-Text v2 standard). Thinking bills as output. */
        const T = out.totals;
        const geminiUsd = (T.geminiIn * 0.75 + (T.geminiOut + T.geminiThinking) * 3.75) / 1e6;
        const sttUsd = (T.sttSeconds / 60) * 0.016;
        // price each purpose the same way, so a spike names its own cause
        const priced = (v) => (v.in * 0.75 + (v.out + v.thinking) * 3.75) / 1e6;
        for (const [p, v] of Object.entries(out.byPurpose)) v.usd = Number(priced(v).toFixed(5));
        out.estimatedUsd = {
          gemini: Number(geminiUsd.toFixed(4)),
          stt: Number(sttUsd.toFixed(4)),
          total: Number((geminiUsd + sttUsd).toFixed(4)),
          note: "List prices applied at read time; not an invoice.",
        };
        return json(res, 200, out);
      }

      // The reports themselves, for an admin who wants them without the inbox.
      if (url.pathname === "/api/bug-reports" && req.method === "GET") {
        if (user.role !== "admin") return json(res, 403, { error: "Admins only." });
        let list = [];
        try { list = JSON.parse(db.get("bugReports") || "[]"); } catch { /* none yet */ }
        // strip screenshots from the list view; they are large and rarely needed in bulk
        return json(res, 200, { reports: list.map(({ screenshot, ...r }) => ({ ...r, hasScreenshot: !!screenshot })) });
      }

      if (url.pathname === "/api/users" && req.method === "POST") {
        if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can add employees." });
        const result = store.addUser(await readBody(req), user); // password hashed server-side
        if (result.error) return json(res, 400, { error: result.error });
        bumpRev();
        if (!(await persisted(res, req))) return;
        return json(res, 200, { ok: true, rev, userId: result.user.id });
      }
      if (url.pathname === "/api/delete-user" && req.method === "POST") {
        if (user.role !== "admin") return json(res, 403, { error: "Only an administrator can remove employees." });
        const { userId } = await readBody(req);
        if (!sameClinic(store.getUser(userId), user)) return json(res, 404, { error: "User not found." });
        const result = store.deleteUser(userId, user);
        if (result.error) return json(res, 400, { error: result.error });
        bumpRev();
        if (!(await persisted(res, req))) return;
        return json(res, 200, { ok: true, rev });
      }
      if (url.pathname === "/api/refine" && req.method === "POST") {
        // Clinical documentation, so the gate is canDocument (as /api/extract-doc
        // uses) — canAccessEmr would let front desk through, and this ships
        // transcript PHI off-box to Gemini.
        if (!store.canDocument(user)) return json(res, 403, { error: "Your account can’t create clinical documents." });
        if (aiRateLimited(res, req, user, "refine")) return;
        const { transcript } = await readBody(req);
        if (!Array.isArray(transcript) || !transcript.length) return json(res, 400, { error: "No transcript to refine." });
        const clean = transcript.map((t) => String(t || "").slice(0, 2000)).slice(0, 500);
        const result = await refineTranscript(clean, user);
        return json(res, 200, result);
      }
      /* Blend a therapist's own wording with the AI's, for ONE field.
         Same gate as the other clinical AI paths — this writes prose that ends
         up in a signed record. The prompt is deliberately narrow: combine, do
         not add. Anything not in one of the two inputs must not appear. */
      if (url.pathname === "/api/blend-note" && req.method === "POST") {
        if (!store.canDocument(user)) return json(res, 403, { error: "Your account can\u2019t create clinical documents." });
        if (aiRateLimited(res, req, user, "blend")) return;
        const b = await readBody(req);
        const mine = String(b.mine || "").slice(0, 6000).trim();
        const other = String(b.ai || "").slice(0, 6000).trim();
        if (!mine || !other) return json(res, 400, { error: "Both versions are needed to blend." });
        if (!geminiActive()) return json(res, 503, { error: "Blending needs the AI service, which isn\u2019t configured here." });
        try {
          const prompt = [
            "You are helping a physical therapist merge two versions of ONE section of a clinical note.",
            "VERSION A is what the therapist typed themselves. VERSION B was produced from a recording of the visit.",
            "",
            "Produce ONE merged version that keeps every clinical fact present in either version.",
            "HARD RULES:",
            "- Do NOT introduce any finding, measurement, symptom or plan that is not in A or B.",
            "- Where they disagree on a fact, keep BOTH and mark the disagreement inline like: (recording says 8/10; typed says 7/10).",
            "- Keep the therapist's voice and clinical shorthand where the meaning is the same.",
            "- Do not add pleasantries, headings, or commentary. Return the merged text only.",
            "",
            `SECTION: ${String(b.field || "note").slice(0, 40)}`,
            "", "VERSION A (therapist typed):", mine, "", "VERSION B (from recording):", other,
          ].join("\n");
          const out = await ai.geminiJson(prompt,
            { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            Object.assign(GEMINI_OPTS(user, "blend"), { thinkingLevel: "medium", temperature: 0.1 }));
          return json(res, 200, { text: String((out && out.text) || "").trim() });
        } catch (e) {
          const ref = crypto.randomBytes(4).toString("hex");
          console.error(`[error ${ref}] POST /api/blend-note \u2014`, e);
          return json(res, 500, { error: "Couldn\u2019t blend those. Edit by hand instead.", ref });
        }
      }

      if (url.pathname === "/api/insights" && req.method === "POST") {
        // decision support for a licensed clinician — same gate as /api/refine
        if (!store.canDocument(user)) return json(res, 403, { error: "Your account can’t create clinical documents." });
        if (aiRateLimited(res, req, user, "insights")) return;
        const ctx = await readBody(req);
        const result = await clinicalInsights(ctx || {}, user);
        return json(res, 200, result);
      }
      if (url.pathname === "/api/patient-assistant" && req.method === "POST") {
        if (!store.canAccessEmr(user)) return json(res, 403, { error: "Not permitted." });
        if (aiRateLimited(res, req, user, "assistant")) return;
        const { chart, question, history } = await readBody(req);
        const q = String(question || "").slice(0, 2000).trim();
        if (!q) return json(res, 400, { error: "No question provided." });
        const turns = Array.isArray(history) ? history.slice(-8).map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", text: String(t.text || "").slice(0, 2000) })) : [];
        try {
          const result = await patientAssistant(chart || {}, q, turns, user);
          return json(res, 200, result);
        } catch (e) {
          // a 501 carries our own "not set up on this server yet" text, which is
          // actionable; anything else may be a raw provider error
          if (e.code === 501) return json(res, 501, { error: e.message });
          return fail(res, 500, "The AI service could not complete that request.", e, req);
        }
      }
      if (url.pathname === "/api/extract-doc" && req.method === "POST") {
        if (!store.canDocument(user)) return json(res, 403, { error: "Your account can’t create clinical documents." });
        if (aiRateLimited(res, req, user, "extract")) return;
        const { pdf, mime } = await readBody(req);
        if (!pdf || typeof pdf !== "string") return json(res, 400, { error: "No document received." });
        if (pdf.length > 11 * 1024 * 1024) return json(res, 400, { error: "Document too large (limit ~8 MB)." });
        try {
          const result = await ai.extractRecords(pdf, mime, GEMINI_OPTS(user, "extract"));
          return json(res, 200, result);
        } catch (e) {
          // a 501 carries our own "not set up on this server yet" text, which is
          // actionable; anything else may be a raw provider error
          if (e.code === 501) return json(res, 501, { error: e.message });
          return fail(res, 500, "The AI service could not complete that request.", e, req);
        }
      }
      if (url.pathname === "/api/stt" && req.method === "POST") {
        const lang = (url.searchParams.get("lang") || "en-US").replace(/[^a-z-]/gi, "");
        // digits must survive the scrub or "chirp2" silently becomes "chirp" —
        // a wrong-but-valid model key, so the request succeeds and the clinic
        // gets the older engine without any sign that it happened
        const model = (url.searchParams.get("model") || "standard").replace(/[^a-z0-9_]/gi, "");
        const docId = url.searchParams.get("docId") || "";
        /* Checked before the body is read: a runaway recorder posting megabytes
           of audio should be turned away at the door, not after we have taken
           delivery of it. */
        if (aiRateLimited(res, req, user, "stt")) return;
        const wav = await readRawBody(req);
        if (wav.length < 200) return json(res, 400, { error: "Empty audio." });
        // opt-in temporary retention: keep the raw segment for later review if
        // the facility enabled it and the patient consented (even if transcription
        // fails — the audio is exactly what you'd want to fall back on)
        const doc = docForUser(docId, user);
        let retained = false;
        if (doc && audioRetentionOK(doc)) { try { await saveAudioSegment(docId, wav); retained = true; } catch (e) { console.error("[audio] save failed:", e.message); } }
        // Google rounds each request up to the next second, and we hold the
        // exact buffer, so this is the billed figure — not an estimate.
        const billedSeconds = wavBilledSeconds(wav);
        meter(clinicOfUser(user), "stt", { seconds: billedSeconds, bytes: wav.length, model });
        /* `billedSeconds` goes back to the caller so the chart can record what
           a visit actually cost against the same number that drives the bill,
           rather than the client's own estimate of how long someone spoke.
           It is deliberately absent from the 501 below: that means Cloud STT
           was never configured, so the audio never reached Google and nothing
           was billed for it. */
        try {
          const out = await transcribe(wav, lang, model);
          // `model` is what actually ran, which is not always what was asked
          // for — see the English-only fallback in transcribe()
          return json(res, 200, { text: out.text, model: out.model, retained, billedSeconds });
        } catch (e) {
          // 501 is our own "Speech-to-Text isn't set up yet" guidance; anything
          // else is a raw Google error and stays in the log
          if (e.code === 501) return json(res, 501, { error: e.message, retained });
          const ref = crypto.randomBytes(4).toString("hex");
          console.error(`[error ${ref}] POST /api/stt —`, e);
          // audio that reached Google and failed there is still billed
          return json(res, 500, { error: "Transcription failed.", ref, retained, billedSeconds });
        }
      }
      if (url.pathname === "/api/audio") {
        const docId = url.searchParams.get("docId") || "";
        // clinic-scoped: recorded patient audio (and the DELETE below, which
        // destroys it) must never be reachable from another tenant
        const doc = docForUser(docId, user);
        if (!doc) return json(res, 404, { error: "Document not found." });
        if (!store.canAccessEmr(user)) return json(res, 403, { error: "Not permitted." });
        if (req.method === "GET") {
          const seg = url.searchParams.get("seg");
          if (!seg) return json(res, 200, { segments: await listAudioSegments(docId), reviewDays: audioReviewDays(clinicOfDoc(doc)) });
          // stream one segment (auth already checked above)
          const safe = seg.replace(/[^a-z0-9_.-]/gi, "");
          if (!safe.endsWith(".wav")) return json(res, 404, { error: "Segment not found." });
          const f = await files.get(audioSegKey(docId, safe));
          if (!f) return json(res, 404, { error: "Segment not found." });
          res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
          return res.end(f.buffer);
        }
        if (req.method === "DELETE") {
          const n = await deleteAudio(docId);
          if (n) { store.audit(user.id, "audio-deleted", `${doc.title}: ${n} segment(s)`); bumpRev(); }
          return json(res, 200, { deleted: n });
        }
        return json(res, 405, { error: "Method not allowed." });
      }
      /* ---- operator: onboarding a new clinic ----
         Platform-owner only. Everything else in this file is scoped so a signed-in
         user sees their own clinic; these two deliberately span tenants, so the
         gate is the whole security story. The 403 is identical for "you are a
         clinic admin" and "you are a demo login", and says nothing about what
         exists on the other side of it. */
      if (url.pathname === "/api/clinics") {
        if (!isPlatformOwner(user)) {
          store.audit(user.id, "operator-denied", url.pathname);
          bumpRev();
          return json(res, 403, { error: "That area is limited to the platform operator." });
        }
        if (req.method === "GET") return json(res, 200, { clinics: store.clinicSummaries() });
        if (req.method === "POST") {
          const { clinicName, ownerName, ownerEmail, password } = await readBody(req);
          const r = store.createClinic({ clinicName, ownerName, ownerEmail, password }, user);
          if (r.error) return json(res, 400, { error: r.error });
          bumpRev();
          /* The temporary password goes back so the operator can hand it over
             once. It is already hashed in storage and is never readable again —
             a lost one is reset from Facility Admin, not recovered. */
          return json(res, 200, {
            clinic: { id: r.clinic.id, name: r.clinic.name },
            admin: { id: r.user.id, name: r.user.name, email: r.user.email },
            temporaryPassword: String(password),
          });
        }
        return json(res, 405, { error: "Method not allowed." });
      }

      if (url.pathname === "/api/state" && req.method === "GET") {
        return json(res, 200, { rev, isOwner: isPlatformOwner(user), state: scopedState(user) });
      }
      if (url.pathname === "/api/state" && req.method === "PUT") {
        const { baseRev, state } = await readBody(req);
        if (baseRev !== rev) {
          return json(res, 409, { rev, state: scopedState(user) });
        }
        if (!state || !Array.isArray(state.patients) || !Array.isArray(state.users)) {
          return json(res, 400, { error: "Malformed state." });
        }
        // entity ids flow into HTML attributes on every device and into audio
        // storage prefixes — accept only plain slug ids from a device push
        const badId = (x) => !x || typeof x.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(x.id);
        for (const k of ["patients", "users", "documents", "appointments"]) {
          if (!Array.isArray(state[k]) || state[k].some(badId)) return json(res, 400, { error: "Malformed state." });
        }
        state.sessionUserId = null;
        // Confine the push to the pusher's clinic and re-assert server-held
        // privilege fields. The device only ever saw its own tenant, so this
        // is also what stops its narrowed view from deleting everyone else.
        const grafted = graftPushedState(state, user);
        if (grafted.error) return json(res, 403, { error: grafted.error });
        // capture server-side password hashes so a device push (whose state has
        // them stripped) can't wipe or forge them
        const creds = new Map(store.users().map((u) => [u.id, u.passwordHash]));
        store.importAll(grafted.state, { preserveSession: false });
        for (const u of store.users()) {
          const h = creds.get(u.id);
          if (h) u.passwordHash = h; else delete u.passwordHash;
          delete u.pin; // clients can never introduce a plaintext credential
        }
        // (any pushed Gemini key was already stripped in graftPushedState,
        // which is the copy that actually gets imported)
        store.save();
        bumpRev();
        if (!(await persisted(res, req))) return;   // never acknowledge an unsaved chart
        audioSweep().catch((e) => console.error("[audio] sweep failed:", e.message)); // drop audio for notes just signed
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
        !fs.existsSync(full) || fs.statSync(full).isDirectory() ||
        !isClientAsset(file.split(path.sep).join("/"))) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    const stream = fs.createReadStream(full);
    stream.on("error", () => { try { res.destroy(); } catch { } });
    stream.pipe(res);
  } catch (e) {
    fail(res, 500, "Something went wrong on the server.", e, req);
  }
});

async function start() {
  // Bring up durable storage FIRST (Postgres preload is async), then hydrate
  // the in-memory store, revision, and sessions from it before serving.
  const dbInfo = await db.init({ dataDir: DATA_DIR, databaseUrl: process.env.DATABASE_URL || null });
  const filesInfo = await files.init({ dataDir: DATA_DIR, bucket: GCS_BUCKET || null, getToken: GCS_BUCKET ? gcpAccessToken : null });
  store.load();
  /* Demo box: put the seeded demo logins back before the pin-hashing step below
     picks them up. seed() only fires on empty storage, so without this a
     long-lived deployment shows the demo clinic but has no accounts to enter it
     with. Tied to the same switch that reveals the sign-in panel, so a real
     clinic deployment neither creates nor advertises them. */
  const demo = DEMO_LOGINS_ENABLED ? store.ensureDemoAccounts() : null;
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
    if (DEMO_LOGINS_ENABLED) {
      console.log(`  demo logins: ON — published on the sign-in screen${demo && demo.users ? `, restored ${demo.users} account(s)` : ""}${demo && demo.content ? ", seeded the demo clinic" : ""}`);
    }
    console.log(`  files: ${filesInfo.backend === "gcs" ? `Google Cloud Storage (bucket ${filesInfo.bucket})` : filesInfo.dir + " (local disk — ephemeral on Cloud Run; set GCS_BUCKET)"}`);
    console.log(`  reminders: checking every 60s${process.env.REMINDER_WEBHOOK ? " → " + process.env.REMINDER_WEBHOOK : " (logged; set REMINDER_WEBHOOK to deliver)"}`);
    console.log(`  AI cleanup: ${geminiEngineDesc()}${geminiActive() ? ` — refine/extract: ${GEMINI_MODEL} · insights: ${GEMINI_INSIGHTS_MODEL}` : ""}`);
    console.log(`  dictation: ${sttConfigured() ? `Google Cloud Speech-to-Text (project ${GCP_PROJECT}, ${STT_LOCATION})` : "browser engine only (set GCP_PROJECT + credentials for Google Cloud STT — see GOOGLE_SETUP.md)"}`);
    console.log(`  audio review (default clinic): ${audioReviewOn(DEFAULT_CLINIC) ? `ON — consented segments kept up to ${audioReviewDays(DEFAULT_CLINIC)} days in ${filesInfo.backend === "gcs" ? "Cloud Storage" : "local files"}, then auto-deleted` : "off (no audio stored)"}`);
    audioSweep().catch((e) => console.error("[audio] initial sweep failed:", e.message));
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
