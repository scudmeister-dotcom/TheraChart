/* POST /api/insights  { patient, referral, pmh, current, history } →
   possible connections, red flags, and recommendations (decision support).
   Uses Gemini when GEMINI_API_KEY is set on Vercel, else the local heuristic. */
const { ai, opts, readJson, send } = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const ctx = await readJson(req);
  try {
    return send(res, 200, await ai.insightsRun(ctx || {}, opts()));
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
};
