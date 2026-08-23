/* Getting back OUT of the sign-in card.

   Someone who clicks "Sign in" from the landing page and then wants to read the
   pricing or the walkthrough has to be able to return. There is no browser
   Back to lean on — the landing/login split is one page swapping its own
   contents, not a navigation — so the card's own "← Back" is the ONLY way out.
   If its binding is ever dropped, the sign-in screen becomes a dead end and
   nothing server-side would notice. */

const { test, expect } = require("@playwright/test");

/* A pristine, signed-out page. Same reasoning as the smoke suite's helper: end
   the session through the app's own button before clearing storage, or the live
   instance writes its token straight back into the slate we just wiped. */
async function freshLanding(page) {
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
}

test("the sign-in card can get back to the landing page", async ({ page }) => {
  await freshLanding(page);

  // 1. We start on the marketing landing, not the login form.
  await expect(page.locator("#lpSignIn")).toBeVisible();
  await expect(page.locator("#emailInput")).toHaveCount(0);

  // 2. Into the sign-in card.
  await page.locator("#lpSignIn").click();
  await expect(page.locator("#emailInput")).toBeVisible();
  const back = page.locator("#backToLanding");
  await expect(back).toBeVisible();

  // 3. Back out again — the whole point.
  await back.click();
  await expect(page.locator("#lpSignIn")).toBeVisible();
  await expect(page.locator("#emailInput")).toHaveCount(0);

  // 4. And the info the visitor came back for is reachable.
  await expect(page.locator("#lpPricing")).toBeVisible();

  // 5. Round-trips, rather than working exactly once.
  await page.locator("#lpSignIn").click();
  await expect(page.locator("#emailInput")).toBeVisible();
  await page.locator("#backToLanding").click();
  await expect(page.locator("#lpSignIn")).toBeVisible();
});

/* The same trip, but on a browser that has signed in before.

   `knowsAnAccount()` (app.js) remembers that in localStorage and sends the
   visitor straight to the form on later visits — deliberately, because someone
   with an account wants the form, not the pitch. But that heuristic used to be
   evaluated AFTER the explicit choice, so it overrode it: "← Back" set
   showLogin = false, render() consulted knowsAnAccount(), and drew the login
   card straight back. The button looked broken to exactly the people who had
   used the app before — i.e. everyone real.

   The first test cannot catch this: it clears localStorage, which clears the
   flag. This one sets it on purpose. */
test("← Back still reaches the landing page on a returning browser", async ({ page }) => {
  await freshLanding(page);

  // Mark this browser as one that has signed in before, exactly as a real
  // returning visitor's would be, and reload so render() sees it from the top.
  await page.evaluate(() => localStorage.setItem("therachart-known-account", "1"));
  await page.reload();

  // A returning browser is shown the form directly — that part is intended.
  await expect(page.locator("#emailInput")).toBeVisible();

  // ...and asking for the landing must still work.
  await page.locator("#backToLanding").click();
  await expect(page.locator("#lpSignIn")).toBeVisible();
  await expect(page.locator("#emailInput")).toHaveCount(0);
  await expect(page.locator("#lpPricing")).toBeVisible();

  // The flag is a guess about what the visitor wants; it must not be destroyed
  // by them exercising the choice, or the next visit forgets them.
  expect(await page.evaluate(() => localStorage.getItem("therachart-known-account"))).toBe("1");
});

/* The BROWSER's Back button, which is the one a visitor reaches for first.

   Landing and login are one page swapping its own contents. Until the sign-in
   card got an address of its own (#/signin) nothing was pushed onto history, so
   Back from the sign-in screen did not return to the pitch — it left the site.
   Both back routes now run through the hash, so this pins the browser half. */
test("the browser's Back button returns from sign-in to the landing page", async ({ page }) => {
  await freshLanding(page);
  await expect(page.locator("#lpSignIn")).toBeVisible();

  await page.locator("#lpSignIn").click();
  await expect(page.locator("#emailInput")).toBeVisible();
  expect(page.url()).toContain("#/signin");   // a real history entry to go back to

  await page.goBack();
  await expect(page.locator("#lpSignIn")).toBeVisible();
  await expect(page.locator("#emailInput")).toHaveCount(0);

  // Forward again, so the two are genuinely navigable rather than one-way.
  await page.goForward();
  await expect(page.locator("#emailInput")).toBeVisible();
});

/* Same, on the returning browser that broke the in-app button. The remembered
   flag must not out-vote the hash either: Back moved the URL to #/, and
   render() has to follow it rather than re-drawing the form from memory. */
test("the browser's Back button works on a returning browser too", async ({ page }) => {
  await freshLanding(page);
  await page.evaluate(() => localStorage.setItem("therachart-known-account", "1"));
  await page.reload();
  await expect(page.locator("#emailInput")).toBeVisible();

  // Navigate to the form's own address, then back out of it.
  await page.locator("#backToLanding").click();
  await expect(page.locator("#lpSignIn")).toBeVisible();
  await page.locator("#lpSignIn").click();
  await expect(page.locator("#emailInput")).toBeVisible();

  await page.goBack();
  await expect(page.locator("#lpSignIn")).toBeVisible();
  await expect(page.locator("#emailInput")).toHaveCount(0);
});

/* Typing the address straight in has to work, or a bookmarked sign-in link
   opens the marketing page and looks broken. */
test("#/signin opens the form directly", async ({ page }) => {
  await freshLanding(page);
  await page.goto("/#/signin");
  await expect(page.locator("#emailInput")).toBeVisible();
  await expect(page.locator("#backToLanding")).toBeVisible();
});
