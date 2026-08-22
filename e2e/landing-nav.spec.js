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
