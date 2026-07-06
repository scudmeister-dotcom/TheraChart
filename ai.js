/* TheraChart AI core — the single source of truth for Gemini-backed features,
   shared by the clinic server (server.js) and the Vercel serverless functions
   (api/*.js). Each entry point runs Gemini when a key is supplied, otherwise
   the local heuristic fallback, and always returns the same shape.

   opts = { key, model, base } — key null → local fallback. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./parser.js"), require("./insights.js"));
  else root.TheraAI = factory(root.TheraParser, root.TheraInsights);
})(typeof self !== "undefined" ? self : this, function (parser, insights) {
  "use strict";

  const DEFAULT_MODEL = "gemini-2.0-flash";
  const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

  /* ---------------- transcript refinement ---------------- */

  const REFINE_SCHEMA = {
    type: "object",
    properties: {
      dialogue: { type: "array", items: { type: "object", properties: {
        speaker: { type: "string", enum: ["patient", "clinician"] }, text: { type: "string" },
      }, required: ["speaker", "text"] } },
      findings: { type: "array", items: { type: "object", properties: {
        bodyPart: { type: "string" }, side: { type: "string", enum: ["left", "right", "none"] },
        summary: { type: "string" }, sourceQuote: { type: "string" },
      }, required: ["bodyPart", "summary"] } },
      subjective: { type: "string" },
      treatment: { type: "string" },
    },
    required: ["dialogue", "findings"],
  };

  function refineSystem() {
    return [
      "You are an experienced physical therapist writing up a treatment session,",
      "acting as a meticulous clinical documentation specialist. You receive a raw,",
      "unpunctuated voice transcript that may contain BOTH the therapist and the",
      "patient speaking, in English, Tagalog, or Cebuano (Taglish code-switching is",
      "common and normal). Think the way a PT thinks in SOAP terms.",
      "",
      "Do the following:",
      "",
      "1) SPEAKER SEPARATION. Split the transcript into dialogue turns and label",
      "   each 'patient' or 'clinician'. The CLINICIAN asks questions ('where does",
      "   it hurt?', 'on a scale of ten?'), gives cues/instructions ('push against",
      "   my hand', 'relax'), and reads out objective measures ('flexion is 120",
      "   degrees'). The PATIENT reports how they feel, when, and what makes it",
      "   worse or better. When unsure, prefer 'patient' only if it is a symptom",
      "   report; otherwise 'clinician'.",
      "",
      "2) CLEAN, DON'T REWRITE. Fix obvious speech-to-text errors and add sensible",
      "   punctuation, but do NOT change clinical meaning, invent details, or",
      "   translate — keep each speaker's original language.",
      "",
      "3) SUBJECTIVE (patient's words). Write a concise clinician-style Subjective",
      "   paragraph in English drawn ONLY from what the patient reported: chief",
      "   complaint, location and laterality, pain rating (0-10), quality (sharp,",
      "   dull, burning…), onset/duration, and aggravating/easing factors. Do not",
      "   include the therapist's commentary.",
      "",
      "4) FINDINGS. List discrete musculoskeletal findings from the PATIENT's",
      "   report: bodyPart, side (left/right/none), and a short clinical summary",
      "   (symptom + severity + rating + duration + trigger). One entry per",
      "   distinct region/side. A denial ('no pain in the right knee') is a finding",
      "   phrased as a denial, not omitted.",
      "",
      "5) TREATMENT. If the therapist described interventions performed this visit",
      "   (therapeutic exercise, manual therapy, modalities, gait/balance training,",
      "   HEP, education), summarize them in a brief Treatment paragraph; else ''.",
      "",
      "Be faithful and conservative: if something was not said, do not add it.",
      "Return ONLY JSON matching the provided schema.",
    ].join("\n");
  }

  const refinePrompt = (utterances) =>
    refineSystem() + "\n\nTRANSCRIPT LINES:\n" + utterances.map((u, i) => `${i + 1}. ${u}`).join("\n");

  // Attach map coordinates + turn indices + measurements — same shape as local.
  function normalizeRefinement(parsed, utterances, source) {
    const dialogue = Array.isArray(parsed.dialogue) && parsed.dialogue.length
      ? parsed.dialogue.map((d) => ({ speaker: d.speaker === "clinician" ? "clinician" : "patient", text: String(d.text || "").trim() })).filter((d) => d.text)
      : utterances.map((u) => ({ speaker: parser.guessSpeaker(u), text: String(u).trim() }));

    const findings = (parsed.findings || []).map((f) => {
      const side = f.side === "left" || f.side === "right" ? f.side : null;
      const c = parser.coordForName(f.bodyPart, side);
      const quote = f.sourceQuote || "";
      const turns = [];
      dialogue.forEach((d, i) => { if (quote && d.text.toLowerCase().includes(quote.toLowerCase().slice(0, 24))) turns.push(i); });
      return { key: `${c.part}|${c.side || ""}`, part: c.part, side: c.side, view: c.view, x: c.x, y: c.y, summary: String(f.summary || "").trim(), quote, turns };
    }).filter((f) => f.summary);

    return {
      dialogue, findings, source,
      measurements: parser.aggregateMeasurements(dialogue.map((d) => d.text)),
      subjective: String(parsed.subjective || "").trim(),
      treatment: String(parsed.treatment || "").trim(),
    };
  }

  /* ---------------- generic Gemini JSON ---------------- */

  async function geminiJson(prompt, schema, opts) {
    const model = opts.model || DEFAULT_MODEL;
    const base = opts.base || DEFAULT_BASE;
    const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(opts.key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: opts.temperature ?? 0.2 },
      }),
      signal: AbortSignal.timeout(opts.timeout || 40000),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    return JSON.parse(text);
  }

  /* ---------------- public entry points ---------------- */

  async function refine(utterances, opts) {
    opts = opts || {};
    if (opts.key) {
      try {
        const parsed = await geminiJson(refinePrompt(utterances), REFINE_SCHEMA, opts);
        return normalizeRefinement(parsed, utterances, "gemini");
      } catch (e) { if (opts.onError) opts.onError("refine", e); }
    }
    const local = parser.refineTranscript(utterances);
    return { ...local, source: opts.key ? "local (gemini failed)" : "local" };
  }

  async function insightsRun(ctx, opts) {
    opts = opts || {};
    if (opts.key) {
      try {
        const parsed = await geminiJson(insights.insightsPrompt(ctx), insights.INSIGHTS_SCHEMA, { ...opts, temperature: 0.3 });
        return { connections: parsed.connections || [], redFlags: parsed.redFlags || [], recommendations: parsed.recommendations || [], source: "gemini" };
      } catch (e) { if (opts.onError) opts.onError("insights", e); }
    }
    const local = insights.buildInsights(ctx);
    return { ...local, source: opts.key ? "local (gemini failed)" : "local" };
  }

  return { refine, insightsRun, refineSystem, refinePrompt, REFINE_SCHEMA, normalizeRefinement, geminiJson, DEFAULT_MODEL, DEFAULT_BASE };
});
