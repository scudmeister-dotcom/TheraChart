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

  // Two tiers. Flash is fast + cheap and handles the high-volume, schema-bound
  // extraction work (transcript cleanup, document reading). Pro is the stronger
  // reasoner reserved for Clinical Insights, where reading between the lines
  // across a patient's history matters more than speed or cost.
  //   NOTE: as of writing there is no "gemini-3.5-pro" — the newest Pro is
  //   gemini-3.1-pro-preview. Bump DEFAULT_PRO_MODEL (or set GEMINI_INSIGHTS_MODEL)
  //   to "gemini-3.5-pro" the moment it ships.
  const DEFAULT_MODEL = "gemini-3.5-flash";
  const DEFAULT_PRO_MODEL = "gemini-3.1-pro-preview";
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

  // True when opts can reach Gemini: either a consumer API key, or Vertex AI
  // (OAuth token + project) for PHI under a Google Cloud BAA.
  const aiReady = (opts) => !!(opts && (opts.key || opts.vertex));

  // Build the request target + auth headers for either backend.
  //   Consumer API: GET-key on ...generativelanguage.../models/M:generateContent?key=
  //   Vertex AI:    Bearer token on {loc}-aiplatform.../publishers/google/models/M:generateContent
  // The request BODY is identical for both — same contents + generationConfig.
  async function geminiTarget(model, opts) {
    if (opts.vertex) {
      const loc = opts.location || "global"; // 3.x models live on the global endpoint
      const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
      const token = typeof opts.getToken === "function" ? await opts.getToken() : opts.token;
      if (!token) throw new Error("Vertex AI is enabled but no OAuth token was available.");
      if (!opts.project) throw new Error("Vertex AI is enabled but GCP project is not set.");
      return {
        url: `https://${host}/v1/projects/${opts.project}/locations/${loc}/publishers/google/models/${model}:generateContent`,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      };
    }
    const base = opts.base || DEFAULT_BASE;
    return {
      url: `${base}/models/${model}:generateContent?key=${encodeURIComponent(opts.key)}`,
      headers: { "content-type": "application/json" },
    };
  }

  // prompt: a string (single text part) or a parts array — e.g. an inline PDF
  // part plus an instruction part for document extraction.
  async function geminiJson(prompt, schema, opts) {
    const model = opts.model || DEFAULT_MODEL;
    const parts = typeof prompt === "string" ? [{ text: prompt }] : prompt;
    const { url, headers } = await geminiTarget(model, opts);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: opts.temperature ?? 0.2 },
      }),
      signal: AbortSignal.timeout(opts.timeout || 40000),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
    return JSON.parse(text);
  }

  /* ---------------- scanned-document extraction ----------------
     Reads a PDF (scan or digital) of past therapy records and pulls out one
     structured entry per visit, so years of paper charts can be onboarded.
     No local fallback exists for reading documents — without a key this
     feature reports itself unavailable rather than guessing. */

  const EXTRACT_SCHEMA = {
    type: "object",
    properties: {
      patientName: { type: "string" },
      docDescription: { type: "string" },
      visits: { type: "array", items: { type: "object", properties: {
        date: { type: "string" },
        type: { type: "string", enum: ["eval", "daily", "progress", "discharge"] },
        therapist: { type: "string" },
        subjective: { type: "string" },
        objective: { type: "string" },
        assessment: { type: "string" },
        treatment: { type: "string" },
        findings: { type: "array", items: { type: "object", properties: {
          bodyPart: { type: "string" }, side: { type: "string", enum: ["left", "right", "none"] }, summary: { type: "string" },
        }, required: ["bodyPart", "summary"] } },
        rom: { type: "array", items: { type: "object", properties: {
          side: { type: "string", enum: ["left", "right", "none"] }, joint: { type: "string" },
          motion: { type: "string" }, degrees: { type: "number" },
        }, required: ["joint", "motion", "degrees"] } },
        mmt: { type: "array", items: { type: "object", properties: {
          context: { type: "string" }, grade: { type: "string" },
        }, required: ["grade"] } },
        pain: { type: "array", items: { type: "object", properties: {
          location: { type: "string" }, score: { type: "number" },
        }, required: ["score"] } },
        special: { type: "array", items: { type: "object", properties: {
          name: { type: "string" }, result: { type: "string", enum: ["positive", "negative"] },
        }, required: ["name", "result"] } },
      }, required: ["type"] } },
    },
    required: ["visits"],
  };

  function extractSystem() {
    return [
      "You are a meticulous clinical-records abstractor for a physical-therapy",
      "EMR. You receive a document — often a SCAN of past therapy records, which",
      "may be typed, handwritten, faxed, multi-page, or partly illegible, in",
      "English, Tagalog, or Cebuano.",
      "",
      "Extract EXACTLY ONE entry per distinct patient visit found in the",
      "document — never repeat or duplicate a visit:",
      "",
      "- date: the visit date as YYYY-MM-DD. If you cannot read a date, leave it",
      "  an empty string — never guess a date.",
      "- type: 'eval' (initial evaluation/assessment), 'daily' (treatment/session",
      "  note), 'progress' (progress/re-evaluation report), or 'discharge'.",
      "  Default to 'daily' when unclear.",
      "- therapist: the treating clinician's name as written, if shown.",
      "- subjective: what the patient reported (complaints, pain, function).",
      "- objective: observations and narrative objective findings.",
      "- assessment: the clinician's assessment/impression.",
      "- treatment: interventions performed or planned (exercises, modalities,",
      "  manual therapy, HEP, plan of care).",
      "- findings: one entry per distinct symptomatic body region the PATIENT",
      "  reported: bodyPart, side (left/right/none), and a short clinical summary.",
      "- rom / mmt / pain / special: objective measurements exactly as recorded",
      "  (range of motion in degrees, muscle grades like 4-/5, pain 0-10 ratings,",
      "  special orthopedic tests positive/negative).",
      "",
      "Be conservative and faithful: extract only what the document actually",
      "says; NEVER invent values, dates, or findings; keep the original language",
      "of quoted text. Also return patientName as written on the document (for a",
      "mismatch check) and docDescription, a one-line description of what this",
      "document is. If the document contains no therapy visit records, return an",
      "empty visits array and explain what it is in docDescription.",
      "",
      "Return ONLY JSON matching the schema.",
    ].join("\n");
  }

  function normalizeExtraction(parsed) {
    const isoDate = (s) => {
      const t = String(s || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
      const d = new Date(t);
      if (t && !isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      return "";
    };
    const side = (s) => (s === "left" || s === "right" ? s : null);
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

    const visits = (Array.isArray(parsed.visits) ? parsed.visits : []).map((v) => {
      const type = ["eval", "daily", "progress", "discharge"].includes(v.type) ? v.type : "daily";
      const findings = (v.findings || []).map((f) => {
        const c = parser.coordForName(f.bodyPart, side(f.side));
        return { key: `${c.part}|${c.side || ""}`, part: c.part, side: c.side, view: c.view, x: c.x, y: c.y,
          summary: String(f.summary || "").trim() };
      }).filter((f) => f.summary);
      return {
        date: isoDate(v.date),
        type,
        therapist: String(v.therapist || "").trim(),
        subjective: String(v.subjective || "").trim(),
        objective: String(v.objective || "").trim(),
        assessment: String(v.assessment || "").trim(),
        treatment: String(v.treatment || "").trim(),
        findings,
        rom: (v.rom || []).map((r) => ({ side: side(r.side), joint: String(r.joint || "").toLowerCase().trim(),
          motion: String(r.motion || "").toLowerCase().trim(), degrees: clamp(r.degrees, 0, 360) }))
          .filter((r) => r.joint && r.motion),
        mmt: (v.mmt || []).map((r) => ({ context: String(r.context || "").trim() || null, grade: String(r.grade || "").trim() }))
          .filter((r) => r.grade),
        pain: (v.pain || []).map((r) => ({ location: String(r.location || "").trim() || null, score: clamp(r.score, 0, 10) })),
        special: (v.special || []).map((r) => ({ name: String(r.name || "").trim(), result: r.result === "negative" ? "negative" : "positive" }))
          .filter((r) => r.name),
      };
    }).filter((v) => v.subjective || v.objective || v.assessment || v.treatment || v.findings.length ||
      v.rom.length || v.mmt.length || v.pain.length || v.special.length);

    // drop exact duplicates (models occasionally emit a visit twice)
    const seen = new Set();
    const unique = visits.filter((v) => {
      const sig = JSON.stringify(v);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });

    // chronological order; undated visits sink to the end
    unique.sort((a, b) => ((a.date || "9999") < (b.date || "9999") ? -1 : 1));

    return {
      visits: unique,
      patientName: String(parsed.patientName || "").trim(),
      docDescription: String(parsed.docDescription || "").trim(),
    };
  }

  async function extractRecords(fileBase64, mime, opts) {
    opts = opts || {};
    if (!aiReady(opts)) {
      const e = new Error("Reading scanned documents needs Gemini configured (set a key or enable Vertex AI on the server).");
      e.code = 501;
      throw e;
    }
    const parts = [
      { inline_data: { mime_type: mime || "application/pdf", data: fileBase64 } },
      { text: extractSystem() },
    ];
    const parsed = await geminiJson(parts, EXTRACT_SCHEMA, { ...opts, timeout: opts.timeout || 120000 });
    return { ...normalizeExtraction(parsed), source: "gemini" };
  }

  /* ---------------- patient assistant (grounded Q&A) ----------------
     A NotebookLM-style assistant scoped to ONE patient's chart. It answers a
     clinician's question using ONLY the supplied chart corpus — never outside
     medical knowledge about this specific patient, and never another patient's
     data (the caller assembles the corpus for a single patient). When the
     answer isn't in the chart it says so (answered:false) instead of guessing.
     There is no local fallback: freeform Q&A needs the model, so without a key
     this reports itself unavailable. */

  const ASSISTANT_SCHEMA = {
    type: "object",
    properties: {
      answer: { type: "string" },
      answered: { type: "boolean" },
      citations: { type: "array", items: { type: "object", properties: {
        source: { type: "string" }, quote: { type: "string" },
      }, required: ["source"] } },
    },
    required: ["answer", "answered"],
  };

  function assistantSystem() {
    return [
      "You are a clinical chart assistant helping a licensed physical therapist",
      "understand ONE patient. You answer questions about that patient using",
      "ONLY the CHART CONTEXT provided below — the patient's own evaluations,",
      "daily notes, progress reports, discharge notes, and imported past records.",
      "",
      "Hard rules:",
      "1) Use ONLY facts found in the CHART CONTEXT. Do NOT use outside medical",
      "   knowledge to state anything about THIS patient, and do NOT invent",
      "   dates, values, diagnoses, or history that are not written in the chart.",
      "2) If the chart does not contain the answer, set answered=false and say",
      "   plainly that it is not in this patient's records — never guess or fill",
      "   the gap. It is correct and expected to say 'that isn't documented'.",
      "3) When you do answer, set answered=true and CITE your sources: for each",
      "   fact, add a citation whose 'source' is the visit it came from (e.g.",
      "   \"Evaluation 2026-03-12\" or \"Daily note 2026-04-02\") and, when useful,",
      "   a short 'quote' of the exact chart text.",
      "4) You may summarize, compare across visits, and surface trends already",
      "   present in the chart, but stay faithful to what is written. This is",
      "   decision support for a licensed clinician — not a diagnosis.",
      "5) Be concise and clinical. Answer the question that was asked.",
      "",
      "Return ONLY JSON matching the schema.",
    ].join("\n");
  }

  // Flatten a single patient's chart corpus into grounded text. Mirrors the
  // shape insights uses (see insights.insightsPrompt) plus a plan field.
  function assistantChartText(chart) {
    const c = chart || {};
    const lines = ["CHART CONTEXT", "============="];
    if (c.patient) lines.push(`Patient: ${c.patient.age || "?"}y ${c.patient.sex || ""}`.trim());
    if (c.referral) lines.push(`Referral / reason: ${c.referral}`);
    if (c.pmh) lines.push(`Past medical history: ${c.pmh}`);
    const fmtMeas = (m) => {
      if (!m) return "";
      const parts = [];
      (m.rom || []).forEach((r) => parts.push(`ROM ${r.side || ""} ${r.joint} ${r.motion} ${r.degrees}°`));
      (m.mmt || []).forEach((r) => parts.push(`MMT ${r.context || ""} ${r.grade}`));
      (m.special || []).forEach((r) => parts.push(`${r.name}: ${r.result}`));
      (m.pain || []).forEach((r) => parts.push(`Pain ${r.location || ""} ${r.score}/10`));
      return parts.join("; ");
    };
    lines.push("", "VISITS (most recent first)", "--------------------------");
    (c.docs || []).forEach((d, i) => {
      lines.push(`[${i + 1}] ${d.date || "(undated)"} — ${d.type || "note"}`);
      if (d.subjective) lines.push(`  Subjective: ${d.subjective}`);
      if (d.objective) lines.push(`  Objective: ${d.objective}`);
      (d.findings || []).forEach((f) => lines.push(`  Finding: ${(f.side ? f.side + " " : "")}${f.part} — ${f.summary || ""}`));
      const m = fmtMeas(d.measurements);
      if (m) lines.push(`  Measurements: ${m}`);
      if (d.assessment) lines.push(`  Assessment: ${d.assessment}`);
      if (d.plan) lines.push(`  Plan: ${d.plan}`);
    });
    if (!(c.docs || []).length) lines.push("(no documents on file for this patient)");
    const dg = c.historyDigest;
    if (dg) {
      lines.push("", `EARLIER HISTORY — DIGEST of ${dg.visits} older visit${dg.visits === 1 ? "" : "s"} (${dg.from || "?"} → ${dg.to || "?"})`, "-".repeat(40));
      (dg.regions || []).forEach((r) => lines.push(`Recurring region: ${r.region} (×${r.count})${r.lastSummary ? ` — last noted: ${r.lastSummary}` : ""}`));
      (dg.romTrends || []).forEach((t) => lines.push(`ROM over that period: ${t.key} ${t.first}° → ${t.last}° (${t.n} measurements)`));
      if (dg.pain) lines.push(`Pain over that period: ${dg.pain.first}/10 → ${dg.pain.last}/10 (${dg.pain.n} ratings)`);
      (dg.assessments || []).forEach((a) => lines.push(`Assessment ${a.date || ""}: ${a.text}`));
    }
    return lines.join("\n");
  }

  function assistantPrompt(chart, question, history) {
    const lines = [assistantSystem(), "", assistantChartText(chart)];
    const turns = (history || []).slice(-8); // keep the recent conversation bounded
    if (turns.length) {
      lines.push("", "CONVERSATION SO FAR", "-------------------");
      turns.forEach((t) => lines.push(`${t.role === "assistant" ? "Assistant" : "Clinician"}: ${t.text}`));
    }
    lines.push("", "CLINICIAN'S QUESTION", "--------------------", String(question || "").trim());
    return lines.join("\n");
  }

  async function patientAssistant(chart, question, history, opts) {
    opts = opts || {};
    if (!aiReady(opts)) {
      const e = new Error("The patient assistant needs Gemini configured (set a key or enable Vertex AI on the server).");
      e.code = 501;
      throw e;
    }
    const parsed = await geminiJson(assistantPrompt(chart, question, history), ASSISTANT_SCHEMA, { ...opts, temperature: 0.1 });
    return {
      answer: String(parsed.answer || "").trim(),
      answered: parsed.answered !== false,
      citations: (parsed.citations || []).map((c) => ({ source: String(c.source || "").trim(), quote: String(c.quote || "").trim() })).filter((c) => c.source),
      source: "gemini",
    };
  }

  /* ---------------- public entry points ---------------- */

  async function refine(utterances, opts) {
    opts = opts || {};
    if (aiReady(opts)) {
      try {
        const parsed = await geminiJson(refinePrompt(utterances), REFINE_SCHEMA, opts);
        return normalizeRefinement(parsed, utterances, "gemini");
      } catch (e) { if (opts.onError) opts.onError("refine", e); }
    }
    const local = parser.refineTranscript(utterances);
    return { ...local, source: aiReady(opts) ? "local (gemini failed)" : "local" };
  }

  async function insightsRun(ctx, opts) {
    opts = opts || {};
    if (aiReady(opts)) {
      try {
        // Insights runs on the Pro tier — the reasoning-heavy path.
        const proModel = opts.insightsModel || DEFAULT_PRO_MODEL;
        const parsed = await geminiJson(insights.insightsPrompt(ctx), insights.INSIGHTS_SCHEMA, { ...opts, model: proModel, temperature: 0.3 });
        return { connections: parsed.connections || [], redFlags: parsed.redFlags || [], recommendations: parsed.recommendations || [], source: "gemini" };
      } catch (e) { if (opts.onError) opts.onError("insights", e); }
    }
    const local = insights.buildInsights(ctx);
    return { ...local, source: aiReady(opts) ? "local (gemini failed)" : "local" };
  }

  return { refine, insightsRun, extractRecords, patientAssistant, refineSystem, refinePrompt, extractSystem,
    assistantSystem, assistantPrompt, assistantChartText, ASSISTANT_SCHEMA,
    REFINE_SCHEMA, EXTRACT_SCHEMA, normalizeRefinement, normalizeExtraction, geminiJson, geminiTarget, aiReady, DEFAULT_MODEL, DEFAULT_PRO_MODEL, DEFAULT_BASE };
});
