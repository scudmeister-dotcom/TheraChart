/* POST /api/refine  { transcript: string[] } → cleaned dialogue + findings +
   sections. Uses Gemini when GEMINI_API_KEY is set on Vercel, else the local
   heuristic reviewer. */
const { ai, opts, readJson, send } = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const body = await readJson(req);
  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  if (!transcript.length) return send(res, 400, { error: "No transcript to refine." });
  const clean = transcript.map((t) => String(t || "").slice(0, 2000)).slice(0, 500);
  try {
    return send(res, 200, await ai.refine(clean, opts()));
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
};
