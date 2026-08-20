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

  // One model everywhere: 3.6 Flash with thinking on. Flash is fast + cheap and
  // handles the high-volume, schema-bound work (transcript cleanup, document
  // reading); thinking is what buys back the depth the old Pro tier gave the
  // reasoning-heavy paths, so the tiering now lives in the thinking level
  // rather than in two different models.
  //
  // Levels are measured, not guessed (verified live against Vertex):
  //   "low"/"minimal" spend ZERO thinking tokens — thinking is effectively off.
  //   "medium" is the floor at which thinking actually engages (~2.3k thinking
  //   tokens on a 73-line transcript); "high" roughly doubles tokens and latency
  //   again (up to ~7k / ~36s), so it is not free on the high-volume path.
  // Thinking is on everywhere; only the depth varies.
  //   refine sees ONE session's transcript and nothing else — no chart, no
  //     prior visits (see refinePrompt) — so it does not need DEEP. It does
  //     need thinking though: on test/eval's refine cases over 3 runs, STANDARD
  //     scores 95.5% vs 92.5% with thinking off, and the whole gap is the
  //     safety-critical "every finding is traceable to the transcript" check on
  //     code-switched Taglish dictation, which is flaky-to-failing without it.
  //     Hallucinated findings in a clinical note are the thing we least tolerate,
  //     so this path pays the ~2.3k thinking tokens.
  //   insights + the assistant reason ACROSS visits (history + historyDigest),
  //     and extraction reasons across a whole document, so they get DEEP.
  //     Insights especially — it replaced the Pro tier and its output (red
  //     flags, referrals) is clinically consequential.
  //   Levels below STANDARD ("low"/"minimal") spend ZERO thinking tokens, i.e.
  //     thinking off. Don't set them here without re-running the eval.
  /* Gemini 3.7 Flash (released 2026-08-14), at the SAME introductory rate as
     3.6 — $0.75/$3.75 per 1M in/out through 2026-12-31, then $1.50/$7.50. So
     this costs nothing to take.

     Measured before switching: test/eval/run.js --runs 2 against Vertex scores
     98.0% (200/204) on BOTH models, with the same single miss
     (insights/declining-rom). No regression, and no gain on these cases either.
     The reason to move is the published document-processing benchmark, which is
     the scanned-record import path this eval does not cover (GDP.pdf 34.0% vs
     22.0%) — an improvement we have NOT independently verified here.

     If anything looks wrong in the field, revert without a deploy:
       gcloud run services update therachart --region us-central1 \
         --update-env-vars GEMINI_MODEL=gemini-3.6-flash,GEMINI_INSIGHTS_MODEL=gemini-3.6-flash */
  const DEFAULT_MODEL = "gemini-3.7-flash";
  const DEFAULT_INSIGHTS_MODEL = "gemini-3.7-flash";
  const THINKING_STANDARD = "medium";
  const THINKING_DEEP = "high";
  const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

  /* ---------------- transcript refinement ---------------- */

  const REFINE_SCHEMA = {
    type: "object",
    properties: {
      dialogue: { type: "array", items: { type: "object", properties: {
        speaker: { type: "string", enum: ["patient", "clinician"] }, text: { type: "string" },
        keep: { type: "boolean" }, dropReason: { type: "string" },
      }, required: ["speaker", "text"] } },
      findings: { type: "array", items: { type: "object", properties: {
        bodyPart: { type: "string" }, side: { type: "string", enum: ["left", "right", "none"] },
        summary: { type: "string" }, sourceQuote: { type: "string" },
      }, required: ["bodyPart", "summary"] } },
      /* Things the live pass pinned that should come back off the chart.
         One channel, four reasons — the therapist sees the same review row
         whichever way the live pass went wrong. */
      corrections: { type: "array", items: { type: "object", properties: {
        bodyPart: { type: "string" }, side: { type: "string", enum: ["left", "right", "none"] },
        kind: { type: "string", enum: ["corrected", "hypothetical", "not-the-patient", "misheard"] },
        reason: { type: "string" }, supersededBy: { type: "string" }, sourceQuote: { type: "string" },
      }, required: ["bodyPart", "kind", "reason"] } },
      subjective: { type: "string" },
      treatment: { type: "string" },
      /* The other sections live dictation files into. Reviewing only the
         Subjective left five sections holding the raw live pass's guesses,
         next to one that had been cleaned. */
      reason: { type: "string" },
      precautions: { type: "string" },
      pmh: { type: "string" },
      objective: { type: "string" },
      assessment: { type: "string" },
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
      "4) FINDINGS — PATIENT-REPORTED SYMPTOMS ONLY. List discrete musculoskeletal",
      "   findings drawn ONLY from what the PATIENT said: bodyPart, side",
      "   (left/right/none), and a short clinical summary (symptom + severity +",
      "   rating + duration + trigger). One entry per distinct region/side. A",
      "   denial ('no pain in the right knee') IS a finding, phrased as a denial,",
      "   not omitted.",
      "   Never create a finding out of something the CLINICIAN measured or",
      "   tested. Strength grades ('quad strength is four out of five'), range-of-",
      "   motion degrees ('flexion is 95 degrees') and special-test results ('Neer",
      "   is positive') are objective data, not the patient's report — they are",
      "   already captured separately as measurements, so repeating them here",
      "   double-counts them and mis-attributes the clinician's words to the",
      "   patient. If the patient reported no symptoms of their own, return an",
      "   EMPTY findings array; that is a correct and expected answer, not a",
      "   failure to find something.",
      "",
      "5) TREATMENT. If the therapist described interventions performed this visit",
      "   (therapeutic exercise, manual therapy, modalities, gait/balance training,",
      "   HEP, education), summarize them in a brief Treatment paragraph; else ''.",
      "",
      "5b) THE REST OF THE NOTE. Live dictation files into these sections too, and",
      "   they are just as likely to be holding small talk as the Subjective was.",
      "   Draft each one from the SAME conversation. Return '' — not a guess, and",
      "   not a repeat of another section — for any the visit did not mention.",
      "",
      "     reason       why the patient was referred, and by whom: 'Dr. Santos",
      "                  referred for right shoulder pain'.",
      "     precautions  restrictions and contraindications the patient or",
      "                  surgeon stated: 'no lifting over 5 kg for six weeks',",
      "                  weight-bearing status, 'bawal', 'iwasan'.",
      "     pmh          relevant past history: prior surgeries, injuries, and",
      "                  comorbidities the patient reported ('diagnosed with",
      "                  diabetes ten years ago'). Somebody ELSE's history is",
      "                  not history — 'my daughter had knee surgery' belongs",
      "                  in no section at all.",
      "",
      "   WHOSE BODY IS BEING TALKED ABOUT. Tagalog and Cebuano mark possession",
      "   AFTER the noun, the opposite way round from English, and getting this",
      "   backwards puts a relative's complaint on this patient's chart:",
      "     'asawa ko', 'anak ko', 'akong bana'  — MY spouse/child/husband. The",
      "       possessive attaches to the PERSON, not to any body part nearby.",
      "     'likod niya', 'iyang abaga', 'braso nila' — THEIR back/shoulder/arm.",
      "     'likod ko', 'akong abaga', 'ang ulo ko' — the patient's own.",
      "   So 'yung asawa ko po, masakit ang likod niya' reports NOTHING about",
      "   the patient. But note that 'niya' alone means only his/her: a",
      "   therapist dictating 'namamaga ang kanang kamay niya' is describing the",
      "   patient in front of them. It is somebody else only when somebody else",
      "   was actually named.",
      "     objective    what the CLINICIAN observed out loud: posture, gait,",
      "                  palpation, asymmetry, swelling on inspection. Do NOT",
      "                  repeat range-of-motion degrees, strength grades or",
      "                  special-test results here — those are already filed as",
      "                  measurements, and a second copy drifts from the first.",
      "     assessment   the clinical impression IF the therapist stated one",
      "                  ('consistent with rotator cuff impingement'). Never",
      "                  infer a diagnosis that was not said out loud.",
      "",
      "   Every sentence belongs to exactly ONE section. A referral is the reason",
      "   for referral and is not also a line of Subjective; a precaution is a",
      "   precaution and not also history. Do not write the Plan — frequency,",
      "   duration and progressions are the therapist's decision, not the",
      "   transcript's.",
      "",
      "6) CORRECTIONS — WHAT SHOULD COME BACK OFF THE CHART. Live dictation pins",
      "   a body region the instant it hears one, mid-sentence, with no idea how",
      "   the sentence ends or who is speaking. Your job is to catch what it got",
      "   wrong. Read the transcript as one conversation, not line by line.",
      "   Every region an earlier line would have put on the chart and a later",
      "   reading takes off it goes in 'corrections', with a plain-words reason",
      "   a therapist can read, the quote it came from, and one of four kinds:",
      "",
      "     'corrected'       the patient revised it — 'chest pain' becomes",
      "                       'sorry, I meant my arm', 'the left knee' becomes",
      "                       'no, the right one', 'hindi pala', 'dili diay'.",
      "                       A later statement WINS. Name what replaced it in",
      "                       supersededBy.",
      "     'hypothetical'    it was an EXAMPLE, not a report — 'you could say,",
      "                       oh, my right arm is in a lot of pain', 'for",
      "                       instance', 'kunwari', 'halimbawa', or the",
      "                       therapist demonstrating the app to someone. Nobody",
      "                       is complaining of that region.",
      "     'not-the-patient' the words are the clinician's, or another person's",
      "                       ('my daughter broke her arm'), or commentary about",
      "                       the software ('so it highlights that', 'it went to",
      "                       the shoulder') rather than about the body.",
      "     'misheard'        speech-to-text plainly garbled it and the region is",
      "                       not one the patient could have named here.",
      "",
      "   Do NOT also list a corrected region in 'findings' — the corrected",
      "   version belongs there instead. A correction is not a denial: 'no pain",
      "   in the right knee' is a finding phrased as a denial, not a correction.",
      "",
      "6b) PUT THE FINDING IN THE RIGHT PLACE. The live pass matches words, not",
      "   anatomy, so it files posterior complaints on the front of the body and",
      "   loses laterality inside a phrase. When the patient's own words locate",
      "   something more precisely than the region name does — 'the back of my",
      "   left leg' is the left hamstring, not a generic leg; 'likod ng kaliwang",
      "   binti' is the left calf; 'the left side of my butt' is the left",
      "   gluteal region — name the precise region in 'findings' and put the",
      "   loose one in 'corrections' as 'corrected', so the chart ends up with",
      "   one accurate pin instead of two vague ones.",
      "",
      "   Name the region by its POSTERIOR name when the complaint is posterior.",
      "   The body map has a front figure and a back one and picks between them",
      "   from the name alone, so 'thigh' puts a pin on the front of the leg",
      "   however clearly the summary says otherwise. Use: hamstring for the",
      "   back of the thigh or upper leg, calf for the back of the lower leg,",
      "   buttock for the gluteal region, shoulder blade for the scapula,",
      "   lower back for the lumbar region, and Achilles or heel behind the",
      "   ankle.",
      "",
      "7) TRIM THE TRANSCRIPT. Set keep=false on any line that adds nothing to",
      "   the record: backchannel ('okay', 'mm-hmm', 'sige'), greetings, small",
      "   talk, logistics (parking, payment, rescheduling), commentary about the",
      "   app itself, worked examples, and lines that name a body part but say",
      "   nothing about it ('and my knee' followed by nothing). Give a short",
      "   dropReason for each. Set keep=true on everything else, and ALWAYS",
      "   keep: anything with a symptom, rating, duration or trigger in it; a",
      "   clinician question or cue that gives its answer meaning; and any line",
      "   that corrects an earlier statement. When a line is HALF commentary and",
      "   half report ('so it highlights that and then my neck is maybe a 3 out",
      "   of 10'), keep the line and clean the commentary out of its text —",
      "   never drop a line that still carries a finding. When in doubt, keep.",
      "   This is a medical record.",
      "",
      "8) READ THROUGH THE DISFLUENCY. Dictation transcribes stammers and filler",
      "   exactly as spoken: 'my my neck', 'so it's like, um, sore'. Collapse",
      "   repeated words and drop filler in the dialogue text — but never drop a",
      "   word that carries meaning. In Tagalog and Cebuano especially: 'kanang'",
      "   is hesitation in Cebuano AND 'right (side)' in Tagalog, and 'yung'",
      "   carries grammar. If a word could be laterality, KEEP it.",
      "",
      "Be faithful and conservative: if something was not said, do not add it.",
      "Return ONLY JSON matching the provided schema.",
    ].join("\n");
  }

  const refinePrompt = (utterances) =>
    refineSystem() + "\n\nTRANSCRIPT LINES:\n" + utterances.map((u, i) => `${i + 1}. ${u}`).join("\n");

  // Attach map coordinates + turn indices + measurements — same shape as local.
  function normalizeRefinement(parsed, utterances, source) {
    /* keep/dropReason are optional in the schema: a model that omits them
       must not silently trim the whole transcript, so an absent flag falls
       back to the local heuristic, which defaults to keeping the line. */
    const withKeep = (d, text) => {
      if (typeof d.keep === "boolean") return { keep: d.keep, dropReason: d.keep ? "" : String(d.dropReason || "").trim() };
      const s = parser.turnSubstance(text);
      return { keep: s.keep, dropReason: s.reason };
    };
    const dialogue = Array.isArray(parsed.dialogue) && parsed.dialogue.length
      ? parsed.dialogue.map((d) => {
        const text = String(d.text || "").trim();
        return { speaker: d.speaker === "clinician" ? "clinician" : "patient", text, ...withKeep(d, text) };
      }).filter((d) => d.text)
      : utterances.map((u) => {
        const text = String(u).trim();
        return { speaker: parser.guessSpeaker(u), text, ...withKeep({}, text) };
      });

    /* The model names the region in words; the parser owns the anatomy. When
       the words are a front-of-body limb ("thigh", "leg") but the quote they
       came from plainly locates the complaint behind it ("the back of my left
       leg", "likod ng binti", "luyo sa"), the parser's reading of what was
       actually said is the better evidence of WHERE — and the difference is a
       pin on the wrong figure. Deliberately narrow: only a limb is allowed to
       move, and only onto its own posterior counterpart, so a summary that
       merely contains the word "back" ("worse when I lie on my back") can
       never relocate a knee to the lumbar spine. */
    const FRONT_LIMB = new Set(["Leg", "Thigh", "Arm", "Upper arm"]);
    const POSTERIOR = new Set(["Hamstring", "Calf", "Buttock"]);
    const locate = (bodyPart, side, quote, summary) => {
      const c = parser.coordForName(bodyPart, side);
      if (c.view !== "front" || !FRONT_LIMB.has(c.part)) return c;
      const said = `${summary || ""} ${quote || ""}`;
      if (!/\b(?:back|behind|posterior|likod|luyo)\b/i.test(said)) return c;
      const m = parser.parseUtterance(said).mentions.find((x) => POSTERIOR.has(x.partName));
      return m ? parser.coordForName(m.partName, side || m.side) : c;
    };

    const findings = (parsed.findings || []).map((f) => {
      const side = f.side === "left" || f.side === "right" ? f.side : null;
      const c = locate(f.bodyPart, side, f.sourceQuote, f.summary);
      const quote = f.sourceQuote || "";
      const turns = [];
      dialogue.forEach((d, i) => { if (quote && d.text.toLowerCase().includes(quote.toLowerCase().slice(0, 24))) turns.push(i); });
      return { key: `${c.part}|${c.side || ""}`, part: c.part, side: c.side, view: c.view, x: c.x, y: c.y, summary: String(f.summary || "").trim(), quote, turns, bare: parser.isBareMention(f.summary) };
    }).filter((f) => f.summary);

    const KINDS = ["corrected", "hypothetical", "not-the-patient", "misheard"];
    const corrections = (parsed.corrections || []).map((t) => {
      const side = t.side === "left" || t.side === "right" ? t.side : null;
      const c = parser.coordForName(t.bodyPart, side);
      return {
        key: `${c.part}|${c.side || ""}`, part: c.part, side: c.side,
        kind: KINDS.includes(t.kind) ? t.kind : "corrected",
        reason: String(t.reason || "").trim() || "The clean-up pass took this off the chart",
        supersededBy: String(t.supersededBy || "").trim(),
        quote: String(t.sourceQuote || "").trim(),
      };
    }).filter((t) => t.part);
    const corrected = new Set(corrections.map((t) => t.key));
    findings.forEach((f) => { f.corrected = corrected.has(f.key); });

    return {
      dialogue, findings, corrections, source,
      measurements: parser.aggregateMeasurements(dialogue.filter((d) => d.keep !== false).map((d) => d.text)),
      subjective: String(parsed.subjective || "").trim(),
      treatment: String(parsed.treatment || "").trim(),
      /* Optional in the schema, so a model that returns none of them must
         not blank five sections of the note. The local drafter reads the
         same cleaned dialogue and answers the same question, so it is the
         right thing to fall back to per-section rather than all-or-nothing. */
      ...(() => {
        const local = parser.sectionDrafts(dialogue);
        const pick = (k) => {
          const given = parsed[k];
          return typeof given === "string" ? given.trim() : (local[k] || "");
        };
        return {
          reason: pick("reason"),
          precautions: pick("precautions"),
          pmh: pick("pmh"),
          objective: pick("objective"),
          assessment: pick("assessment"),
        };
      })(),
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
  // Thinking is always on (thinkingConfig.thinkingLevel); callers raise it to
  // THINKING_DEEP for the reasoning-heavy paths. includeThoughts stays off —
  // we only want the JSON answer, not the model's scratchpad.
  /* Which failures are worth trying again.

     Vertex serves 3.x models from DYNAMIC SHARED QUOTA — capacity pooled
     across customers rather than reserved per project. Our own project limits
     are nowhere near binding (50M input tokens/minute for this model, and no
     per-project request cap at all), so a 429 here does not mean "you have
     used your allowance": it means the shared pool was busy for a moment.
     Google's documented handling for it is to back off and retry.

     We did neither. One 429 threw straight through to the caller, which
     answered with the local heuristic — measured at 1.0 seconds, so the
     clinician got the offline reviewer faster than the real one would ever
     have returned, with nothing but a chip to tell them apart.

     5xx and a timed-out socket get the same treatment for the same reason:
     none of them says the request was wrong, only that this attempt failed. A
     4xx that is NOT 429 does say the request was wrong — a bad model name, a
     malformed schema, an expired token — and retrying it just spends the same
     money to be told the same thing. */
  const RETRYABLE = (e) => {
    const m = String((e && e.message) || e);
    if (/^Gemini (?:429|500|502|503|504)\b/.test(m)) return true;
    // AbortSignal.timeout() surfaces as a TimeoutError / "aborted"
    return /\b(?:timeout|timed out|aborted|abort)\b/i.test(m) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(m);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Exponential, with jitter. The jitter is not decoration: every therapist in
     a clinic finishes their notes at roughly the same times of day, so a fixed
     backoff would line their retries up and re-create the burst that caused
     the throttle. */
  async function withRetry(fn, opts) {
    const tries = Math.max(1, opts.retries == null ? 3 : opts.retries);
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(i); } catch (e) {
        last = e;
        if (i === tries - 1 || !RETRYABLE(e)) throw e;
        const backoff = Math.min(8000, 600 * Math.pow(2, i));
        const wait = backoff / 2 + Math.random() * (backoff / 2);
        if (opts.onRetry) opts.onRetry(i + 1, tries, wait, e);
        await sleep(wait);
      }
    }
    throw last;
  }

  async function geminiJson(prompt, schema, opts) {
    return withRetry(() => geminiJsonOnce(prompt, schema, opts), opts);
  }

  async function geminiJsonOnce(prompt, schema, opts) {
    const model = opts.model || DEFAULT_MODEL;
    const parts = typeof prompt === "string" ? [{ text: prompt }] : prompt;
    const { url, headers } = await geminiTarget(model, opts);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: opts.temperature ?? 0.2,
          thinkingConfig: { thinkingLevel: opts.thinkingLevel || THINKING_STANDARD },
        },
      }),
      signal: AbortSignal.timeout(opts.timeout || 40000),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();

    /* Report what the call actually cost.

       Everything we believed about AI spend was derived from reading code and
       applying list prices — no number had ever been reconciled against a bill,
       which meant a runaway tenant was invisible and a usage-based price was
       unsellable. Gemini returns the real counts; we were throwing them away.

       Thinking is recorded SEPARATELY from the answer even though both bill as
       output, because thinking is the dominant cost and the lever we tune
       (thinkingLevel). A meter that folds it into `out` cannot explain a bill
       or show the effect of changing the level. */
    const u = data.usageMetadata || {};
    if (typeof opts.onUsage === "function") {
      const thoughts = Number(u.thoughtsTokenCount || 0);
      try {
        opts.onUsage({
          model: model,
          purpose: opts.purpose || "unknown",
          thinkingLevel: opts.thinkingLevel || THINKING_STANDARD,
          in: Number(u.promptTokenCount || 0),
          out: Math.max(0, Number(u.candidatesTokenCount || 0) - thoughts),
          thinking: thoughts,
          total: Number(u.totalTokenCount || 0),
        });
      } catch (e) { /* metering must never break a clinical call */ }
    }

    // Skip any thought parts — only the answer parts are the JSON payload.
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .filter((p) => !p.thought).map((p) => p.text || "").join("") || "{}";
    return JSON.parse(text);
  }

  /* ---------------- scanned-document extraction ----------------
     Reads a PDF (scan or digital) of past therapy records and pulls out one
     structured entry per visit, so years of paper charts can be onboarded.
     No local fallback exists for reading documents — without a key this
     feature reports itself unavailable rather than guessing. */

  // Every narrative field is REQUIRED, and the properties are explicitly
  // ordered. Both matter, and were measured live rather than guessed:
  // with the narrative fields optional, the model regularly emitted a single
  // visit carrying nothing but `treatment` — the whole note, subjective and
  // objective and assessment alike, crammed into that one string — and then
  // stopped, dropping every later visit. Requiring the fields (and emitting
  // the narrative BEFORE the measurement arrays) took a 2-page 4-visit scan
  // from 1-of-3 runs correct to 9-of-9 across both thinking levels.
  // An absent section is an empty string; see extractSystem().
  const EXTRACT_SCHEMA = {
    type: "object",
    propertyOrdering: ["patientName", "docDescription", "visits"],
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
        /* Side, which the schema simply had no room for. ROM carried one and
           strength did not, so "MMT R shoulder abduction 3+/5" imported as a
           grade belonging to neither arm — and a left/right difference is most
           of why the grade is in the record. Live dictation reads a trailing
           side now; the import had no way to report one at all. */
        mmt: { type: "array", items: { type: "object", properties: {
          side: { type: "string", enum: ["left", "right", "none"] },
          context: { type: "string" }, grade: { type: "string" },
        }, required: ["grade"] } },
        pain: { type: "array", items: { type: "object", properties: {
          side: { type: "string", enum: ["left", "right", "none"] },
          location: { type: "string" }, score: { type: "number" },
        }, required: ["score"] } },
        special: { type: "array", items: { type: "object", properties: {
          name: { type: "string" }, result: { type: "string", enum: ["positive", "negative"] },
        }, required: ["name", "result"] } },
      }, propertyOrdering: ["date", "type", "therapist", "subjective", "objective", "assessment",
           "treatment", "findings", "rom", "mmt", "pain", "special"],
         required: ["date", "type", "subjective", "objective", "assessment", "treatment"] } },
    },
    required: ["visits", "patientName", "docDescription"],
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
      "  special orthopedic tests positive/negative). Put the side on EACH one",
      "  it was recorded for — a grade or an angle that loses its side stops",
      "  showing the left/right difference it was measured to show.",
      "",
      "WHICH SIDE. Charts abbreviate laterality and rarely spell it out. Read",
      "all of these as the side: R / L, (R) / (L), Rt / Lt, B or (B) or B/L for",
      "bilateral, ® for right, a circled or underlined R/L, and the Filipino",
      "words a Philippine clinic writes in — kanan/kanang and tuo/tuong for the",
      "RIGHT, kaliwa/kaliwang and wala/walang for the LEFT, magkabila and",
      "pareho for both. A bilateral entry becomes one entry per side.",
      "  Careful with two of them. Cebuano `wala` is the LEFT side, but Tagalog",
      "  `wala`/`walang` means NONE — 'walang sakit sa tuhod' is no knee pain,",
      "  not left knee pain. And `kanang` is the Tagalog word for right AND a",
      "  Cebuano hesitation noise. Use the language of the surrounding sentence",
      "  to decide, and leave the side out when the document does not settle it.",
      "",
      "FINDINGS ARE THE PATIENT'S REPORT, NOT THE CLINICIAN'S EXAM. Take them",
      "from the S line — what the patient said hurts, and where. Never turn a",
      "measured value into a finding: strength grades, range-of-motion degrees",
      "and special-test results are the clinician's objective data and are",
      "already captured in rom/mmt/special, so repeating them as findings both",
      "double-counts them and files the clinician's words as the patient's. A",
      "documented denial ('denies numbness', 'walang pamamanhid') IS a finding,",
      "written as a denial. A visit whose record shows no patient complaint has",
      "an EMPTY findings array — that is a correct answer, not a failure.",
      "",
      "WHOSE BODY. Records carry family history, and Tagalog and Cebuano mark",
      "possession AFTER the noun, the opposite way round from English: 'asawa",
      "ko' is MY spouse, 'likod niya' is THEIR back, 'akong bana' is my",
      "husband. Somebody else's condition — 'mother with RA', 'father had a",
      "stroke', 'nanay may diabetes' — is family history and belongs in the",
      "narrative if the document has a place for it. It is never a finding on",
      "THIS patient's body.",
      "",
      "Every one of subjective/objective/assessment/treatment must be present on",
      "every visit. When a visit genuinely has no such section, return an EMPTY",
      "STRING for it — never a placeholder like 'not documented', and never the",
      "text of a different section. Each section's text belongs in its own field:",
      "do not merge a whole note into one field.",
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
        mmt: (v.mmt || []).map((r) => ({ side: side(r.side), context: String(r.context || "").trim() || null, grade: String(r.grade || "").trim() }))
          .filter((r) => r.grade),
        pain: (v.pain || []).map((r) => ({ side: side(r.side), location: String(r.location || "").trim() || null, score: clamp(r.score, 0, 10) })),
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
    const parsed = await geminiJson(parts, EXTRACT_SCHEMA, { ...opts, thinkingLevel: opts.thinkingLevel || THINKING_DEEP, timeout: opts.timeout || 120000 });
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
    const parsed = await geminiJson(assistantPrompt(chart, question, history), ASSISTANT_SCHEMA, { ...opts, thinkingLevel: opts.thinkingLevel || THINKING_DEEP, temperature: 0.1 });
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
        /* Thinking costs wall-clock and it grows with the length of the visit.
           Measured against Vertex: ~26s for a two-minute visit, ~33s for a
           ten-minute one, ~53s at the recorder's twenty-minute ceiling. 180s
           is not sized for those medians — it is sized for the tail, which has
           been seen to exceed 90s on a SEVENTEEN line transcript. Length is
           not what runs this clock out; a slow draw is, and the longest visits
           have the least room left when they get one. */
        const parsed = await geminiJson(refinePrompt(utterances), REFINE_SCHEMA,
          { ...opts, timeout: opts.timeout || 180000 });
        // explicit on every path, so a caller never has to read `undefined`
        // as "fine" — the flag is the contract, not the absence of one
        return { ...normalizeRefinement(parsed, utterances, "gemini"), aiFailed: false };
      } catch (e) {
        if (opts.onError) opts.onError("refine", e);
        /* Nothing is returned in place of the review.

           An earlier version ran the heuristic here and flagged it, on the
           reasoning that the caller might want something to show. But a
           payload that contains a plausible-looking review is one an edit,
           a refactor or a second caller can start using by accident, and the
           whole point is that this content must never reach a chart. The
           refusal is the answer; there is no runner-up. */
        if (opts.allowLocalFallback) {
          return { ...parser.refineTranscript(utterances), source: "local (ai failed)", aiFailed: true, error: String((e && e.message) || e) };
        }
        return {
          dialogue: [], findings: [], corrections: [],
          measurements: { rom: [], mmt: [], special: [], pain: [] },
          subjective: "", treatment: "", reason: "", precautions: "", pmh: "", objective: "", assessment: "",
          source: "failed", aiFailed: true, unavailable: false,
          error: String((e && e.message) || e),
        };
      }
    }
    /* No AI configured. This used to answer with the local heuristic and
       call it the engine, which was a reasonable thing to believe until you
       ask what the clinician is being handed. Reviewing a visit is not a
       keyword-matching job that the model happens to do better — splitting who
       spoke, reading a correction three sentences later, telling a screening
       question from a symptom — none of that survives without the model, and a
       note that quietly did without it is not a lesser review, it is a
       different and worse artifact wearing the same name.

       So there is no substitute on offer. The caller is told the review cannot
       run and why, and the clinician writes the note themselves — which they
       are qualified to do, and which is honest about what happened.

       `allowLocalFallback` exists for the offline eval and the parser's own
       tests, which score the heuristic deliberately. Nothing in the product
       sets it. */
    if (opts.allowLocalFallback) {
      return { ...parser.refineTranscript(utterances), source: "local", aiFailed: false };
    }
    return {
      dialogue: [], findings: [], corrections: [],
      measurements: { rom: [], mmt: [], special: [], pain: [] },
      subjective: "", treatment: "", reason: "", precautions: "", pmh: "", objective: "", assessment: "",
      source: "unavailable", aiFailed: true, unavailable: true,
      error: "AI review is not configured on this server.",
    };
  }

  async function insightsRun(ctx, opts) {
    opts = opts || {};
    if (aiReady(opts)) {
      try {
        // Insights is the reasoning-heavy path: same Flash model, thinking high.
        const model = opts.insightsModel || DEFAULT_INSIGHTS_MODEL;
        const parsed = await geminiJson(insights.insightsPrompt(ctx), insights.INSIGHTS_SCHEMA,
          { ...opts, model, thinkingLevel: opts.thinkingLevel || THINKING_DEEP, temperature: 0.3 });
        return { connections: parsed.connections || [], redFlags: parsed.redFlags || [], recommendations: parsed.recommendations || [], source: "gemini" };
      } catch (e) { if (opts.onError) opts.onError("insights", e); }
    }
    /* Same rule as refine, and for the same reason: a chart review that reads
       across visits is the model's work, and the heuristic's version of it
       shown under an "AI" label would be a claim rather than a result. */
    if (opts.allowLocalFallback) {
      return { ...insights.buildInsights(ctx), source: aiReady(opts) ? "local (ai failed)" : "local", aiFailed: aiReady(opts) };
    }
    return {
      connections: [], redFlags: [], recommendations: [],
      source: aiReady(opts) ? "unavailable (ai failed)" : "unavailable",
      aiFailed: true, unavailable: !aiReady(opts),
      error: aiReady(opts) ? "The AI could not review this chart." : "AI insights are not configured on this server.",
    };
  }

  return { refine, insightsRun, extractRecords, patientAssistant, refineSystem, refinePrompt, extractSystem,
    assistantSystem, assistantPrompt, assistantChartText, ASSISTANT_SCHEMA,
    REFINE_SCHEMA, EXTRACT_SCHEMA, normalizeRefinement, normalizeExtraction, geminiJson, geminiTarget, aiReady,
    DEFAULT_MODEL, DEFAULT_INSIGHTS_MODEL, THINKING_STANDARD, THINKING_DEEP, DEFAULT_BASE };
});
