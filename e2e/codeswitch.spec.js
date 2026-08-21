/* A whole visit, dictated the way one is actually spoken in a Philippine
   clinic — Taglish and Bisaya-English, switching mid-sentence, with the
   numbers said in Spanish because that is how a great many patients count.

   The Node suites cover the parser on its own, line by line. This covers the
   thing they cannot: the same speech going in through the real dictation seam
   and coming out the other side as what a therapist signs. Every case here is
   one that failed before 2026-08-21 — a resolved symptom charted as a live
   one, a rating dropped for saying "over" instead of "out of", a joint named
   in two languages in one table. */

const { test, expect } = require("@playwright/test");

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

/** Say one line the way the microphone would deliver it. */
async function say(page, line) {
  await page.locator("#typedDictation").fill(line);
  await page.locator("#typedDictationAdd").click();
}

async function freshDaily(page) {
  const docId = await page.evaluate(() => {
    const S = window.TheraStore;
    const p = S.patients()[0];
    const r = S.createDoc(p.id, "daily", S.currentUser());
    return (r && r.id) || (r && r.doc && r.doc.id);
  });
  await page.goto(`/#/doc/${docId}`);
  return docId;
}

/* A pin as "Part|side|what was said about it". The wording lives in the pin's
   NOTES, not on the pin — a pin is a place on the body and can accumulate
   several statements about itself over one visit. */
const pinsOf = (page, id) => page.evaluate((docId) => {
  const d = window.TheraStore.getDoc(docId).data || {};
  return (d.mapPoints || []).map((p) =>
    `${p.part}|${p.side || ""}|${(p.notes || []).map((n) => n.summary).join(" · ")}`);
}, id);

test.describe("code-switched dictation", () => {

  test("a Taglish visit files the rating, the side and the patient's words", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshDaily(page);

    // Spanish numeral, Tagalog side word, English clinical noun — one sentence.
    await say(page, "doc masakit yung kanang balikat ko, mga otso out of ten kapag umaabot ako");

    const meas = page.locator("#measTable");
    await expect(meas).toContainText("Pain");
    await expect(meas).toContainText("8/10");            // "otso" is eight
    expect((await pinsOf(page, docId)).some((p) => p.startsWith("Shoulder|right|"))).toBe(true);

    // the patient's own wording survives into the transcript
    await expect(page.locator("body")).toContainText("umaabot ako");
  });

  test('Cebuano "wala nay sakit" charts a resolved symptom, not a live one', async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshDaily(page);

    await say(page, "wala nay sakit ang akong abaga karon");

    /* The shipped bug: this charted an ACTIVE painful shoulder for a patient
       who had just said the pain was gone. A finding nobody stated is worse
       than a missing one — it is the sentence the note gets wrong. */
    const pins = await pinsOf(page, docId);
    const shoulder = pins.find((p) => p.startsWith("Shoulder|"));
    expect(shoulder, `no shoulder pin at all: ${JSON.stringify(pins)}`).toBeTruthy();
    expect(shoulder.toLowerCase()).toContain("denies");
  });

  test('Cebuano "wala" as a SIDE still means left', async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshDaily(page);

    // the same word, the other meaning — a painful LEFT knee
    await say(page, "sakit kaayo ang wala nga tuhod nako");

    const pins = await pinsOf(page, docId);
    expect(pins.some((p) => p.startsWith("Knee|left|") && !/denies/i.test(p)),
      `expected a live left knee, got ${JSON.stringify(pins)}`).toBe(true);
  });

  test("measurements dictated in Taglish read in one language in the table", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await freshDaily(page);

    await say(page, "ang kanang balikat, abduction 110 degrees, external rotation 45");
    await say(page, "positive ang Neer test sa kanang balikat");

    const meas = page.locator("#measTable");
    // the joint is named in English even though it was spoken in Tagalog, so
    // it aggregates with the same joint measured in English on another visit
    await expect(meas).toContainText("right shoulder abduction");
    await expect(meas).toContainText("110");
    await expect(meas).toContainText("right shoulder external rotation");
    // and the test name carries no Tagalog article
    await expect(meas).toContainText("Neer test");
    await expect(meas).not.toContainText("Ang Neer");
    await expect(meas).not.toContainText("balikat");
  });

  test("clinic small talk stays out of the note", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshDaily(page);

    await say(page, "Magandang umaga po, kumusta na kayo?");
    await say(page, "Grabe po ang traffic kanina sa EDSA, dalawang oras ako sa daan.");
    await say(page, "Magkano po ang bayad ngayon, sa front desk ba?");

    // nothing clinical was said, so nothing clinical was charted
    expect(await pinsOf(page, docId)).toEqual([]);
  });

  test("a relative's complaint is not charted on this patient", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await freshDaily(page);

    // "asawa ko" is my spouse; "likod niya" is THEIR back, not the patient's
    await say(page, "Yung asawa ko po, masakit din ang likod niya.");

    const pins = await pinsOf(page, docId);
    expect(pins.some((p) => p.startsWith("Back")), `charted the spouse's back: ${JSON.stringify(pins)}`).toBe(false);
  });
});
