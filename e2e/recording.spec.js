/* TheraChart recording tests — the flows a therapist meets when they press
   Record, and which no Node suite can see.

   The Node suite (test/dictation.test.js) asserts these properties against
   app.js as SOURCE: it can prove the code says a thing, not that the screen
   does it. Everything here needs a real microphone permission, a real audio
   graph and real DOM re-parenting, which is exactly the set of things that
   breaks silently.

   The e2e server runs with GEMINI_API_KEY and GCP_PROJECT blanked, so there is
   no AI here and nothing below asserts on AI output. That is deliberate: what
   is being protected is the part a therapist depends on whether or not the
   model answers — that the microphone is visible, that nothing is written to
   the note without them, and that leaving the page does not leave a mic open. */

const { test, expect } = require("@playwright/test");

/* The live dialog. A bare ".modal" also matches the bug-report form, which is
   static hidden markup in the page (app.js:1114) rather than something opened
   on demand — so every dialog assertion here scopes to #modalRoot. */

/* A synthetic microphone, installed before any page script runs.

   Chromium's own --use-fake-device-for-media-stream emits a tone the
   recorder's adaptive voice gate is entitled to read as room noise, which
   would make these tests measure the gate rather than the flow. A stream we
   build ourselves is loud, modulated, and unambiguous — the gate has
   something to lock onto, and a failure here means the FLOW broke. */
async function fakeMic(page) {
  await page.addInitScript(() => {
    const install = () => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.frequency.value = 180;
      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      // modulated so the gate sees contrast rather than a flat floor
      const lfo = ctx.createOscillator(); lfo.frequency.value = 3;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.2;
      lfo.connect(lfoGain); lfoGain.connect(gain.gain); lfo.start();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain); gain.connect(dest); osc.start();
      return dest.stream;
    };
    let stream = null;
    navigator.mediaDevices.getUserMedia = async () => {
      if (!stream) stream = install();
      return stream.clone();
    };
  });
}

async function signIn(page, email) {
  await page.goto("/");
  const signOut = page.locator("#logoutBtn");
  if (await signOut.count()) {
    await signOut.click();
    await page.locator("#logoutBtn").waitFor({ state: "detached" });
  }
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
  });
  await page.reload();
  const entry = page.getByRole("button", { name: /^sign in/i }).first();
  await entry.waitFor({ state: "visible" });
  await entry.click();
  await page.locator(".ta-row", { hasText: email }).click();
  await page.locator(".splash-sub").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await expect(page.getByText(/Good day,/i)).toBeVisible();
}

/** A fresh draft evaluation — the note type with every dictatable section. */
async function freshEval(page) {
  const docId = await page.evaluate(() => {
    const S = window.TheraStore;
    const r = S.createDoc(S.patients()[0].id, "eval", S.currentUser());
    return (r && r.id) || (r && r.doc && r.doc.id);
  });
  await page.goto(`/#/doc/${docId}`);
  await page.locator("#recBtn").waitFor({ state: "visible" });
  return docId;
}

const fieldOf = (page, id, field) => page.evaluate(
  ([i, f]) => (window.TheraStore.getDoc(i).data || {})[f] || "", [id, field]);

test.describe("recording a visit", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["microphone"]);
    await fakeMic(page);
  });

  /* The screen that makes a claim about what is and is not being written down
     while a patient is in the room. It has to appear BEFORE the microphone
     opens — both so the therapist can decline, and so the permission prompt
     hangs off a deliberate press. */
  test("pressing Record asks first, and says the note will not fill itself in", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await freshEval(page);

    await page.locator("#recBtn").click();
    const modal = page.locator("#modalRoot .modal");
    await expect(modal).toContainText("Record this visit");
    await expect(modal).toContainText("The note does not fill itself in while you speak");
    await expect(modal).toContainText("You can still type");

    // declining leaves the microphone shut and the button as it was
    await modal.getByRole("button", { name: "Not now" }).click();
    await expect(page.locator("#recStage")).toBeHidden();
    await expect(page.locator("#recDock")).toBeHidden();
    await expect(page.locator("#recBtnLabel")).toHaveText("Record the visit");
  });

  /* The change this whole branch exists for. The stage used to be a one-way
     door, so typing and recording were mutually exclusive. */
  test("the therapist can type into the note while the visit records", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshEval(page);

    await page.locator("#recBtn").click();
    await page.locator("#modalRoot .modal").getByRole("button", { name: /Start recording/ }).click();

    // the full-screen stage comes up, and only once the mic is genuinely open
    await expect(page.locator("#recStage")).toBeVisible();
    await expect(page.locator("#recBtnLabel")).toHaveText("Stop recording");

    // …and it is no longer a one-way door
    await page.locator("#recStageBack").click();
    await expect(page.locator("#recStage")).toBeHidden();
    await expect(page.locator("#recDock")).toBeVisible();

    /* The property that replaced "no way off the stage": a running recorder is
       never invisible. The dock holds the REAL record button — the same node,
       moved — so there is exactly one in the document. */
    await expect(page.locator("#recDock #recBtn")).toBeVisible();
    await expect(page.locator("#recBtn")).toHaveCount(1);
    await expect(page.locator("#recBtnLabel")).toHaveText("Stop recording");

    // and the note is genuinely typeable
    const subjective = page.locator('textarea[data-field="subjective"]');
    await subjective.fill("Right shoulder pain for two weeks, worse at night.");
    await expect.poll(() => fieldOf(page, docId, "subjective"))
      .toContain("Right shoulder pain for two weeks");

    // still recording, with the mic still on screen
    await expect(page.locator("#recDock")).toBeVisible();

    await page.locator("#recBtn").click();   // stop
    await expect(page.locator("#modalRoot .modal")).toContainText("Recording stopped");
  });

  /* Stopping used to end in a one-line status in a toolbar that a therapist
     looking at their patient never saw, so a captured visit sat unprocessed
     and looked exactly like a visit that was never recorded. */
  test("stopping says what was captured and keeps Record more available", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await freshEval(page);

    await page.locator("#recBtn").click();
    await page.locator("#modalRoot .modal").getByRole("button", { name: /Start recording/ }).click();
    await expect(page.locator("#recStage")).toBeVisible();
    /* Actually record something. The recorder buffers VOICED audio and flushes
       a chunk on stop; stopping the instant the stage appears captures nothing,
       and "Process" is then correctly withheld because there is nothing to
       process. The wait is the speech, not a settle. */
    await page.waitForTimeout(2500);
    await page.locator("#recBtn").click();

    const modal = page.locator("#modalRoot .modal");
    await expect(modal).toContainText("Recording stopped");
    await expect(modal).toContainText("a few seconds");
    await expect(modal.getByRole("button", { name: "Record more" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Process the visit" })).toBeVisible();

    // backing out leaves the audio in hand rather than processing it
    await modal.getByRole("button", { name: "Record more" }).click();
    await expect(page.locator("#recProcess")).toBeVisible();
  });

  /* The dock's own consequence. While the stage covered the screen the sidebar
     was unreachable, so navigating away mid-recording could not happen. It can
     now, and a hot microphone must not survive it. */
  test("leaving the note stops the recorder instead of leaving it open", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await freshEval(page);

    await page.locator("#recBtn").click();
    await page.locator("#modalRoot .modal").getByRole("button", { name: /Start recording/ }).click();
    await page.locator("#recStageBack").click();
    await expect(page.locator("#recDock")).toBeVisible();

    await page.goto("/#/patients");
    await expect(page.locator("#recDock")).toHaveCount(0);
    await expect(page.locator("#recStage")).toHaveCount(0);
    // the audio graph is released, not merely hidden
    expect(await page.evaluate(() => !!(window.__theraDict))).toBe(false);
  });
});

test.describe("recording into one section", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["microphone"]);
    await fakeMic(page);
  });

  /* A section mic RECORDS now; it does not file as you speak. Nothing may
     reach the section while the microphone is open — that is the property
     record-first exists for, and a section is not exempt from it. */
  test("a section mic records, and writes nothing while it is open", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshEval(page);

    await page.locator('[data-fieldmic="subjective"]').click();

    // the section says it is recording, and offers the way to stop
    const panel = page.locator('[data-fieldcheck="subjective"]');
    await expect(panel).toContainText("Recording into");
    await expect(panel).toContainText("nothing is written until you stop");
    await expect(panel.locator("[data-recstop]")).toBeVisible();

    // one microphone: every other section's button is unpressable meanwhile
    await expect(page.locator('[data-fieldmic="assessment"]')).toBeDisabled();
    await expect(page.locator('[data-fieldmic="plan"]')).toBeDisabled();

    // and the section itself stays empty
    expect(await fieldOf(page, docId, "subjective")).toBe("");
  });

  /* Without an AI there is nothing to write the section from. The honest
     answer is to say so and keep what was said — not to fail silently, and
     not to write something polite into a clinical record. */
  test("with no AI configured it says so rather than writing something", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshEval(page);

    await page.locator('[data-fieldmic="subjective"]').click();
    const panel = page.locator('[data-fieldcheck="subjective"]');
    await expect(panel.locator("[data-recstop]")).toBeVisible();
    await page.waitForTimeout(1500);            // a little speech to capture
    await panel.locator("[data-recstop]").click();

    /* The microphone shuts, and the panel stops claiming to be open. With no
       STT the run cannot get past transcription, so the processing screen
       stays up holding the failure and a way back — which is the honest
       outcome, and the one thing that must be true either way is that nothing
       was written into the section. */
    await expect(panel).not.toContainText("Recording into", { timeout: 30_000 });
    await expect(page.locator("#procStage")).toBeVisible();
    await expect(page.locator("#procStage")).toContainText("Transcribing what was said");
    await expect(page.locator("#procActions")).toContainText("Back to the note");
    expect(await fieldOf(page, docId, "subjective")).toBe("");

    // and the way back leaves the note as it was
    await page.locator("#procClose").click();
    await expect(page.locator("#procStage")).toBeHidden();
    expect(await fieldOf(page, docId, "subjective")).toBe("");
  });
});

/* The review's reconciliation, which is what a therapist who typed while the
   visit recorded actually has to work through.

   The AI is stubbed at the sync boundary — `refineTranscript` and `blendNote`
   — rather than called. Everything downstream of that is the real thing: the
   section rows, the sentence marking, the three buttons and the apply. What is
   being protected is not the model's wording but the rule around it, which is
   that NOTHING reaches the note until the therapist ticks a row and presses
   Approve. */
test.describe("reconciling the AI's draft with what the therapist typed", () => {
  const TYPED = "Right shoulder pain for two weeks, worse at night.";
  const DRAFTED = "Right shoulder pain for two weeks, worse at night. "
    + "Denies numbness or tingling in the hand. Reports difficulty reaching overhead.";

  /** A draft eval with a transcript, hand-typed Subjective, and a stubbed AI. */
  async function reviewable(page) {
    await signIn(page, "maria@therachart.demo");
    const docId = await page.evaluate(() => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "eval", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.evaluate(([id, typed, drafted]) => {
      const S = window.TheraStore, sync = window.TheraSync;
      const doc = S.getDoc(id);
      doc.data.transcript = [
        { time: "9:15 AM", text: "My right shoulder has been painful for about two weeks." },
        { time: "9:15 AM", text: "It is worse at night." },
        { time: "9:16 AM", text: "I don't have any numbness or tingling in the hand." },
      ];
      /* Typed by hand, which is what makes the row start UNticked — the flag
         the review reads is cleared by the textarea's own input listener, so
         it is set the way typing sets it. */
      doc.data.subjective = typed;
      doc.data.aiFilled = { ...(doc.data.aiFilled || {}), subjective: false };
      S.updateDocData(id, doc.data, S.currentUser());

      sync.refine = "gemini";                    // so the Review button renders enabled
      sync.refineTranscript = async () => ({
        aiFailed: false, source: "gemini",
        dialogue: doc.data.transcript.map((t) => ({ speaker: "patient", text: t.text, keep: true })),
        findings: [], corrections: [],
        measurements: { rom: [], mmt: [], special: [], pain: [] },
        subjective: drafted,
        treatment: "", reason: "", precautions: "", pmh: "", objective: "", assessment: "",
      });
      sync.blendNote = async ({ mine, ai }) => ({ text: `${mine} ${ai}` });
    }, [docId, TYPED, DRAFTED]);
    await page.goto(`/#/doc/${docId}`);
    await page.locator("#refineBtn").click();
    const sections = page.locator("#modalRoot .modal .rev-tab", { hasText: "Note sections" });
    await sections.waitFor({ state: "visible", timeout: 30_000 });
    await sections.click();
    return docId;
  }

  const subjectiveRow = (page) =>
    page.locator("#modalRoot .rev-section").filter({ hasText: "Subjective" }).first();

  test("a section the therapist typed is not pre-ticked, and says why", async ({ page }) => {
    await reviewable(page);
    const row = subjectiveRow(page);
    await expect(row).toContainText("you typed this — ticking replaces it");
    await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();
    await expect(row).toContainText(TYPED.slice(0, 30));   // their own words, quoted back
  });

  /* The reason the strip exists: the therapist has to see which sentences say
     something their own note does not. */
  test("the AI's draft is marked sentence by sentence against what was typed", async ({ page }) => {
    await reviewable(page);
    const row = subjectiveRow(page);
    await expect(row.locator(".rev-cmp-head")).toContainText("2 of 3 sentences");
    await expect(row.locator(".rev-cmp-body .cmp-seen")).toContainText("Right shoulder pain for two weeks");
    const fresh = row.locator(".rev-cmp-body .cmp-new");
    await expect(fresh).toHaveCount(2);
    await expect(fresh.first()).toContainText("Denies numbness");
  });

  /* All three buttons edit the box and stop there. This is the property the
     whole screen is built on. */
  test("keep mine / use the AI's / blend all edit the box, never the note", async ({ page }) => {
    const docId = await reviewable(page);
    const row = subjectiveRow(page);
    const box = row.locator("textarea.rev-text");
    const noteNow = () => page.evaluate((id) => window.TheraStore.getDoc(id).data.subjective, docId);

    await row.getByRole("button", { name: "Keep mine" }).click();
    await expect(box).toHaveValue(TYPED);
    /* The review says this its own way — "in your own words" — where the
       section panel says "{label} already says all of this". Two surfaces, two
       contexts: one is about the whole note, the other about one box. */
    await expect(row.locator(".rev-cmp-head")).toContainText("already in your own words");

    await row.getByRole("button", { name: "Use the AI's" }).click();
    await expect(box).toHaveValue(DRAFTED);          // the AI's ORIGINAL words

    await row.getByRole("button", { name: "Blend both" }).click();
    await expect(box).toHaveValue(`${TYPED} ${DRAFTED}`);

    // through all of that the note is untouched, and the row is still unticked
    expect(await noteNow()).toBe(TYPED);
    await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();
  });

  /* …and an untouched row stays untouched through the apply, which is the
     other half of the same promise. */
  test("approving writes only the rows that were ticked", async ({ page }) => {
    const docId = await reviewable(page);
    const row = subjectiveRow(page);

    await row.getByRole("button", { name: "Use the AI's" }).click();
    await page.locator("#revApply").click();
    await expect(page.locator("#modalRoot .modal")).toHaveCount(0);
    expect(await page.evaluate((id) => window.TheraStore.getDoc(id).data.subjective, docId)).toBe(TYPED);
  });

  test("…and does write the row once it is ticked", async ({ page }) => {
    const docId = await reviewable(page);
    const row = subjectiveRow(page);

    await row.getByRole("button", { name: "Use the AI's" }).click();
    await row.locator('input[type="checkbox"]').check();
    await page.locator("#revApply").click();
    await expect(page.locator("#modalRoot .modal")).toHaveCount(0);
    await expect.poll(() => page.evaluate((id) => window.TheraStore.getDoc(id).data.subjective, docId))
      .toBe(DRAFTED);
  });
});

/* The OTHER reconciliation screen — the one a server with no AI gets.

   With the model available, a processed recording goes to the refine review.
   Without it there is no whole-visit read, so the parser files the transcript
   line by line and openCompare() puts what the therapist typed beside what the
   routing produced. The e2e server has the AI blanked, which is exactly the
   condition this screen exists for — so it needs no stubbing beyond the
   transcription itself. */
test.describe("comparing your own note with the recording, without an AI", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["microphone"]);
    await fakeMic(page);
  });

  const TYPED = "Left knee pain going down stairs.";
  const HEARD = "The left knee is swollen and it hurts going down stairs.";

  async function processedWithoutAi(page) {
    await signIn(page, "maria@therachart.demo");
    const docId = await page.evaluate(() => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "eval", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);
    await page.locator("#recBtn").waitFor({ state: "visible" });

    // the therapist's own words, typed before the recording is processed
    await page.locator('textarea[data-field="subjective"]').fill(TYPED);

    // Google stands in; everything else on this path is the real thing
    await page.route("**/api/stt*", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ text: HEARD, billedSeconds: 12 }),
    }));

    await page.locator("#recBtn").click();
    await page.locator("#modalRoot .modal").getByRole("button", { name: /Start recording/ }).click();
    await page.waitForTimeout(2500);
    await page.locator("#recBtn").click();
    await page.locator("#modalRoot .modal").getByRole("button", { name: "Process the visit" }).click();

    await page.locator("#modalRoot .modal", { hasText: "Check the AI against your own notes" })
      .waitFor({ state: "visible", timeout: 30_000 });
    return docId;
  }

  const row = (page) => page.locator(".cmp-row").filter({ hasText: "Subjective" }).first();

  test("it opens with the therapist's words beside the recording's", async ({ page }) => {
    await processedWithoutAi(page);
    const r = row(page);
    await expect(r.locator(".cmp-mine")).toHaveValue(TYPED);
    // the routed text is what the parser filed, which appends rather than replaces
    await expect(r.locator(".cmp-ai")).toContainText("stairs");
    await expect(page.locator("#modalRoot .modal"))
      .toContainText("Nothing changes in the note until you press Apply");
  });

  test("keep mine copies across, and Apply writes what is on the right", async ({ page }) => {
    const docId = await processedWithoutAi(page);
    const r = row(page);
    await r.getByRole("button", { name: "Keep mine" }).click();
    await expect(r.locator(".cmp-ai")).toHaveValue(TYPED);

    await page.locator("#cmpApply").click();
    /* Apply closes the comparison and raises a Notice in its place —
       alertBanner() is itself a modal — so "the screen is done" is the
       comparison being gone, not the modal root being empty. */
    await expect(page.locator("#modalRoot .modal")).not.toContainText("Check the AI against your own notes");
    await expect(page.locator("#modalRoot .modal")).toContainText("read it once more before signing");
    await expect.poll(() => page.evaluate((id) => window.TheraStore.getDoc(id).data.subjective, docId))
      .toBe(TYPED);
  });

  test("leaving it alone changes nothing", async ({ page }) => {
    const docId = await processedWithoutAi(page);
    const before = await page.evaluate((id) => window.TheraStore.getDoc(id).data.subjective, docId);
    await page.locator("#cmpCancel").click();
    await expect(page.locator("#modalRoot .modal")).toHaveCount(0);
    expect(await page.evaluate((id) => window.TheraStore.getDoc(id).data.subjective, docId)).toBe(before);
  });

  /* Blend cannot work HERE, and this pins that rather than pretending.

     openCompare is only ever reached when sync.refine is not "gemini", which
     is the same condition that makes /api/blend-note answer 503 — so the one
     screen offering the button is the one screen where the service behind it
     is guaranteed to be off. It degrades with a message rather than failing
     silently, which is why this is a finding and not an outage. */
  test("blend is offered on the one screen where it cannot work", async ({ page }) => {
    await processedWithoutAi(page);
    const r = row(page);
    await expect(r.getByRole("button", { name: "Blend both" })).toBeVisible();
    await r.getByRole("button", { name: "Blend both" }).click();
    await expect(r.locator(".cmp-state")).toContainText("couldn't blend", { timeout: 15_000 });
  });
});
