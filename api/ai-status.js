/* GET /api/ai-status → tells the client whether Gemini is configured. */
const { key, model, send } = require("./_lib.js");

module.exports = (req, res) => {
  const mode = key() ? "gemini" : "local";
  send(res, 200, { refine: mode, insights: mode, model: model(), host: "vercel" });
};
