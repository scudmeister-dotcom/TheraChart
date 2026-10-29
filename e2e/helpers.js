/* Shared browser-test helpers. */

const { expect } = require("@playwright/test");

/** Sign in by PICKING the account, from a clean browser profile.

    Not by typing a password: the seeded demo accounts hold none — the server
    strips their credentials on every boot so a leaked "1234" opens nothing —
    and /api/login refuses them outright while the demo picker is available.
    Clicking a row is the only way in, and it is the way a demo visitor comes
    in too, which makes it the more faithful thing to test. */
async function signIn(page, email) {
  await page.goto("/");
  /* Sign the previous test's user out FIRST, through the app's own button.

     Clearing localStorage under a running app only looks like a clean slate:
     the old instance is still live, still holds the token in memory, and its
     6-second sync poll calls store.save() the moment the server's rev moves —
     writing the session straight back into the storage we just emptied. Then
     reload() restores it and the next sign-in never happens. Ending the session
     before clearing leaves nothing to write back. */
  const signOut = page.locator("#logoutBtn");
  if (await signOut.count()) {
    await signOut.click();
    await page.locator("#logoutBtn").waitFor({ state: "detached" });
  }
  // start from a blank slate: no cached session, no service worker serving
  // yesterday's bundle, no previous clinic's records in localStorage
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
  });
  // reload(), NOT goto("/") — when the previous test left us on a hash route
  // like /#/facility, goto("/") is a same-document navigation, so the app is
  // never re-created and stays signed in as the previous user.
  await page.reload();

  const entry = page.getByRole("button", { name: /^sign in/i }).first();
  await entry.waitFor({ state: "visible" });
  await entry.click();
  // The demo panel renders open, so the row is clickable straight away.
  await page.locator(".ta-row", { hasText: email }).click();

  // The branded splash covers the app briefly AND repeats the clinic name, so
  // any text assertion made too early matches twice. Let it clear first.
  await page.locator(".splash-sub").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  await expect(page.getByText(/Good day,/i)).toBeVisible();
}

module.exports = { signIn };
