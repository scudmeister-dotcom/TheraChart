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
