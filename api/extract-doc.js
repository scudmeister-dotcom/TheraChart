/* POST /api/extract-doc  { pdf: base64, mime } → structured visit records
   read out of a scanned/uploaded document by Gemini. There is no local
   fallback for reading documents, so this requires GEMINI_API_KEY.
   Note: Vercel serverless functions cap request bodies at ~4.5 MB, which
   limits PDFs to roughly 3 MB on this host (the clinic server allows 8 MB). */
const { ai, key, opts, readJson, send } = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  if (!key()) return send(res, 501, { error: "Reading scanned documents needs GEMINI_API_KEY configured." });
  const body = await readJson(req);
  if (!body.pdf || typeof body.pdf !== "string") return send(res, 400, { error: "No document received." });
  try {
    return send(res, 200, await ai.extractRecords(body.pdf, body.mime, opts()));
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
};
