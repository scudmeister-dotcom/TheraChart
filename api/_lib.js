/* Shared helpers for the Vercel serverless functions. Files starting with "_"
   are treated by Vercel as libraries, not routes. The Gemini key comes from
   the Vercel environment variable GEMINI_API_KEY (set it in the Vercel
   dashboard → Project → Settings → Environment Variables). */

const ai = require("../ai.js");

const key = () => process.env.GEMINI_API_KEY || null;
// Flash for refine/extract; Pro for the reasoning-heavy Insights path.
const model = () => process.env.GEMINI_MODEL || ai.DEFAULT_MODEL;
const insightsModel = () => process.env.GEMINI_INSIGHTS_MODEL || ai.DEFAULT_PRO_MODEL;
const base = () => process.env.GEMINI_BASE_URL || ai.DEFAULT_BASE;
const opts = () => ({ key: key(), model: model(), insightsModel: insightsModel(), base: base(), onError: (w, e) => console.error(`[${w}]`, e.message) });

function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = { ai, key, model, insightsModel, base, opts, readJson, send };
