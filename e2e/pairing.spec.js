/* TheraChart dictation-pairing tests — what a therapist actually sees when the
   device is set to the wrong language.

   Dictation sends ONE language code per recording, chosen from a <select> in
   the note's dictation bar and stored per device. A tablet left on English &
   Tagalog in a Bisaya-speaking clinic degrades every Cebuano utterance, and
   until now nothing on screen said so. The Node suite (test/pairing.test.js)
   measures the detector against real Chirp 2 output and pins the wiring in
   source; it cannot prove the banner renders, that the button moves the
   control, or that a device with nothing stored opens on the clinic's pairing.
   That is all here.

   No AI and no Google credentials on this server, which suits these tests: the
   transcript is written straight into the note through the store, exactly as a
   finished transcription would leave it, and everything asserted below is the
   app reacting to the words rather than to a recogniser. */

const { test, expect } = require("@playwright/test");

/* Real Chirp 2 output, not an invented Cebuano string — this is the `heard`
   text of lang/cebuano-only in test/voice/baseline.json, a scripted Cebuano
   visit actually spoken through Google's recogniser (16% word error and all).
   Using the genuine article means this test fails if the detector stops
   surviving what the recogniser really returns. */
const CEBUANO_VISIT = "maayong hapon unsa may imong gibati karon sakit ang wala nga siko na ako "
  + "mga tulo ka semana na pila ka sakit gikan sa usa hangtod napulo mga unom sa napulo sakit "
  + "kaayo kung magbitbit ko ug bug-at naabay pamanhid sa imong kamot o mga tudlo wala wala "
  + "gyuy pamanhid sa sikura gyud";

/* …and the Tagalog counterpart, lang/tagalog-only, for the mirror case. */
const TAGALOG_VISIT = "magandang hapon po ano po ang nararamdaman ninyo ngayon masakit po ang "
  + "kaliwang siko ko mga tatlong linggo na lalo na po kapag may binubuhat ako gaano po kasakit "
  + "kung isa hanggang 10 mga anim po kumikirot po kapag itinutuwid ko may pamamanhid po ba sa "
  + "kamay o sa mga daliri wala po walang pamamanhid sa siko lang po talaga";

/* An English visit. Neither pairing is wrong for it — English rides on both
   codes — so nothing should ever be raised about it. */
const ENGLISH_VISIT = "good afternoon what brings you in today my left elbow has been sore for "
  + "about three weeks it is worse when i lift anything heavy about six out of 10 it is sharp "
  + "when i straighten it any numbness or tingling in the hand or fingers no not at all";

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

/** A draft note whose transcript already holds `said`, opened on screen. */
async function noteSaying(page, said) {
  const docId = await page.evaluate((text) => {
    const S = window.TheraStore;
    const r = S.createDoc(S.patients()[0].id, "eval", S.currentUser());
    const doc = r.doc || r;
    doc.data.transcript = text
      ? text.split(/(?<=[.!?])\s+|(?<=\s)(?=(?:[^ ]+ ){12})/).filter(Boolean)
        .map((t) => ({ time: "10:00", text: t.trim() }))
      : [];
    S.updateDocData(doc.id, doc.data, S.currentUser());
    return doc.id;
  }, said);
  await page.goto(`/#/doc/${docId}`);
  await page.locator("#langSel").waitFor({ state: "visible" });
  return docId;
}

const banner = (page) => page.locator("#langMismatch");

test.describe("the dictation language pairing", () => {
  /* ---------------------------------------------------------------- *
   *  The warning
   * ---------------------------------------------------------------- */

  test("a Cebuano visit on a Tagalog device says so, and quotes the words", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, CEBUANO_VISIT);

    // the device is on the untouched default
    await expect(page.locator("#langSel")).toHaveValue("fil-PH");

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText("sent as English & Tagalog");
    await expect(banner(page)).toContainText("sounds like Cebuano");

    /* The evidence, on screen. A warning a therapist cannot check is one they
       can only obey or ignore, and obeying it wrongly costs every later visit. */
    await expect(banner(page)).toContainText(/“(unsa|imong|gibati|karon|kaayo)”/);

    // and it is honest about what switching does not do
    await expect(banner(page)).toContainText("not sent again");
  });

  test("a Tagalog visit on a Cebuano device raises the mirror warning", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await page.evaluate(() => localStorage.setItem("therachart-lang", "ceb-PH"));
    await noteSaying(page, TAGALOG_VISIT);

    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText("sent as English & Cebuano");
    await expect(banner(page)).toContainText("sounds like Tagalog");
  });

  /* An English visit is not evidence against either code. A banner here would
     be telling a clinic to change a setting the visit said nothing about. */
  test("an English visit raises nothing on either pairing", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, ENGLISH_VISIT);
    await expect(banner(page)).toBeHidden();

    await page.locator("#langSel").selectOption("ceb-PH");
    await expect(banner(page)).toBeHidden();
  });

  test("a note with nothing said yet raises nothing", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, "");
    await expect(banner(page)).toBeHidden();
  });

  /* ---------------------------------------------------------------- *
   *  Correcting it
   * ---------------------------------------------------------------- */

  test("one press switches the pairing, stores it, and clears the warning", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, CEBUANO_VISIT);

    await banner(page).getByRole("button", { name: /Switch to English & Cebuano/ }).click();

    // the control the recorder actually reads has moved
    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");
    // …the device remembers, so the next note opens correct
    expect(await page.evaluate(() => localStorage.getItem("therachart-lang"))).toBe("ceb-PH");
    // …and the disagreement is settled, so the warning goes
    await expect(banner(page)).toBeHidden();
  });

  test("the switch survives to the next note on that device", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, CEBUANO_VISIT);
    await banner(page).getByRole("button", { name: /Switch to English & Cebuano/ }).click();
    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");

    await noteSaying(page, "");
    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");
  });

  /* Changing the <select> by hand has to settle the warning too — a therapist
     who fixes the cause and is still told about it learns to ignore the box. */
  test("fixing it at the select clears the warning as well", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, CEBUANO_VISIT);
    await expect(banner(page)).toBeVisible();

    await page.locator("#langSel").selectOption("ceb-PH");
    await expect(banner(page)).toBeHidden();
  });

  /* A genuinely bilingual clinic must be able to put it away. A notice that
     cannot be dismissed is the one that stops being read — and then so is the
     next one. */
  test("a clinic that means it can keep its pairing and dismiss the warning", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await noteSaying(page, CEBUANO_VISIT);

    await banner(page).getByRole("button", { name: /Keep English & Tagalog/ }).click();
    await expect(banner(page)).toBeHidden();
    await expect(page.locator("#langSel")).toHaveValue("fil-PH");   // nothing changed behind them
  });

  /* ---------------------------------------------------------------- *
   *  The clinic's default — the door a warning cannot close
   * ---------------------------------------------------------------- */

  test("a device with nothing stored opens on the clinic's pairing, not Tagalog", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");
    await page.evaluate(() => {
      const S = window.TheraStore;
      S.updateSettings({ dictationLang: "ceb-PH" }, S.currentUser());
    });

    /* Exactly the state a new tablet, a cleared browser or a second staff
       profile arrives in. Before the clinic setting existed this landed on
       fil-PH regardless of where the clinic was, which is how a Bisaya clinic
       could revert with nobody touching the control. */
    await page.evaluate(() => localStorage.removeItem("therachart-lang"));
    await noteSaying(page, "");
    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");
  });

  /* The legacy value the comment at the bind site is about. It is not one of
     the two codes, so it must fall through to the clinic rather than being
     sent to a recogniser that would refuse it. */
  test("a stored en-US from the old three-option bar falls back to the clinic", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");
    await page.evaluate(() => {
      const S = window.TheraStore;
      S.updateSettings({ dictationLang: "ceb-PH" }, S.currentUser());
      localStorage.setItem("therachart-lang", "en-US");
    });
    await noteSaying(page, "");
    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");
  });

  /* A therapist's own choice is theirs. The clinic default decides only what
     an unset device starts on; it must never overrule somebody who has chosen. */
  test("the clinic default does not overrule a therapist who has chosen", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");
    await page.evaluate(() => {
      const S = window.TheraStore;
      S.updateSettings({ dictationLang: "ceb-PH" }, S.currentUser());
      localStorage.setItem("therachart-lang", "fil-PH");
    });
    await noteSaying(page, "");
    await expect(page.locator("#langSel")).toHaveValue("fil-PH");
  });

  test("an admin can set the clinic's pairing from the facility screen", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");
    await page.goto("/#/facility");
    const sel = page.locator("#st-lang");
    await sel.waitFor({ state: "visible" });
    await expect(sel).toHaveValue("fil-PH");

    await sel.selectOption("ceb-PH");
    await page.locator("#stSave").click();

    await expect.poll(() => page.evaluate(() => window.TheraStore.settings().dictationLang))
      .toBe("ceb-PH");

    // and it is what an unset device then opens on
    await page.evaluate(() => localStorage.removeItem("therachart-lang"));
    await noteSaying(page, "");
    await expect(page.locator("#langSel")).toHaveValue("ceb-PH");
  });
});
