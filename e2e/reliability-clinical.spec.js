/* Browser E2E tests for Phases 1–3:
   - Reliability & data safety (sync popover, idle screen-lock, zero native confirm)
   - Usability & polish (Light/Dark/System theme persistence, Quick Jump `/`,
     Patients quick-access cards, Getting started onboarding checklist)
   - Clinical features (HEP structured editor + print handout button,
     Daily Note "Copy from last visit" carry-forward, section quick-jump + Ask AI
     drawer, visual progress charts, full-text note search, Calendar Week view
     and appointment lifecycle statuses) */

const { test, expect } = require("@playwright/test");
const { signIn, waitForSync } = require("./helpers");

test.describe("Reliability, UX polish, and clinical workflows", () => {
  test("appearance toggle persists across reload and idle lock protects the screen", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(page, "maria@therachart.demo");

    // Open My Profile
    await page.goto("/#/profile");
    await expect(page.locator("[data-theme-pick='dark']")).toBeVisible();

    // Switch to Dark mode and verify <html data-theme="dark"> persists after reload
    await page.locator("[data-theme-pick='dark']").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Switch back to Light mode
    await page.locator("[data-theme-pick='light']").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Test manual idle lock -> overlay blocks view -> Resume session restores cleanly
    await page.locator("#lockNowBtn").click();
    await expect(page.locator(".idle-lock")).toBeVisible();
    await expect(page.locator(".idle-lock")).toContainText("Screen locked");
    await page.locator("#idleUnlockBtn").click();
    await expect(page.locator(".idle-lock")).toHaveCount(0);
    await expect(page.locator("#lockNowBtn")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("sync badge opens status popover and global / shortcut opens Quick Jump", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    // Interactive sync badge opens popover with Sync now button
    await page.locator("#syncBadge").click();
    await expect(page.locator(".sync-popover")).toBeVisible();
    await expect(page.locator(".sync-popover button", { hasText: /Sync now/i })).toBeVisible();
    await page.locator(".sync-popover button", { hasText: /Sync now/i }).click();
    await waitForSync(page);

    // Pressing `/` outside an input opens the Quick Jump palette
    await page.locator("h1").first().click();
    await page.keyboard.press("/");
    await expect(page.locator("#qjInput")).toBeVisible();

    // Search for a seeded patient and jump into their chart
    await page.locator("#qjInput").fill("Gonzales");
    const hit = page.locator("#qjList .qj-item").first();
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(/#\/patient\//);
  });

  test("patients screen shows quick-access cards without polluting search results, and new clinic shows Getting started", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    await page.goto("/#/patients");
    // Invariant from smoke.spec.js: #patResults stays empty until a search is typed
    await expect(page.locator("#patResults .pat-hit")).toHaveCount(0);
    // Quick-access block shows today's scheduled patients
    await expect(page.locator("#patQuick")).toContainText(/Scheduled today/i);
    await expect(page.locator("#patQuick .pat-hit").first()).toBeVisible();

    // Sign into the empty clinic -> Dashboard shows Getting started onboarding checklist
    await signIn(page, "fresh@therachart.demo");
    await expect(page.locator("#onboardCard")).toBeVisible();
    await expect(page.locator("#onboardCard")).toContainText(/Getting started/i);
  });

  test("daily note supports HEP exercises, Copy from last visit, section jumpbar, Ask AI drawer, and full-text search", async ({ page }) => {
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });

    await signIn(page, "maria@therachart.demo");

    // Open first scheduled patient from Patients quick-access
    await page.goto("/#/patients");
    await page.locator("#patQuick .pat-hit").first().click();
    await expect(page).toHaveURL(/#\/patient\//);

    // Overview should display visual progress charts when seeded visits have measurements
    await expect(page.locator(".trend-svg").first()).toBeVisible();

    // Switch to Documents tab and create a new Daily Note
    await page.locator("[data-ptab='documents']").click();
    await page.locator("[data-newdoc-type='daily']").click();
    // Pick the first option in the new-doc picker if a template/body-part picker opened
    const pickerOpt = page.locator(".newdoc-picker button").first();
    if (await pickerOpt.isVisible().catch(() => false)) {
      await pickerOpt.click();
    }
    await expect(page).toHaveURL(/#\/doc\//);

    // Section quick-jump bar is visible and Ask AI opens the slide-over drawer (not an inline card)
    await expect(page.locator(".doc-jumpbar")).toBeVisible();
    await expect(page.locator("#docAssistant")).toHaveCount(0);
    await page.locator("#assistantLaunchM").click();
    await expect(page.locator(".assistant-drawer.open")).toBeVisible();
    await page.locator("#asstClose").click();

    // Copy from last visit modal
    const carryBtn = page.locator("#carryForwardBtn");
    await expect(carryBtn).toBeVisible();
    await carryBtn.click();
    await expect(page.locator("#cfApply")).toBeVisible();
    await page.locator("#cfApply").click();
    await expect(page.locator(".carry-banner")).toBeVisible();

    // Open Plan & HEP section via jumpbar and add a structured HEP exercise
    await page.locator(".doc-jumpbar button", { hasText: /Plan & HEP/i }).click();
    await page.locator("#hepName").fill("Scapular wall slides");
    await page.locator("#hepSets").fill("3");
    await page.locator("#hepReps").fill("12");
    await page.locator("#hepFreq").fill("2x/day");
    await page.locator("#hepAddBtn").click();
    await expect(page.locator("#hepBox")).toContainText("Scapular wall slides");
    await expect(page.locator("#hepPrintBtn")).toBeVisible();

    // Wait for sync and verify full-text search finds the exercise in the Documents tab
    await waitForSync(page);
    await page.locator(".crumbs a", { hasText: /.+/ }).last().click();
    await expect(page).toHaveURL(/#\/patient\//);
    await page.locator("[data-ptab='documents']").click();
    await page.locator("#fQuery").fill("Scapular wall slides");
    await expect(page.locator(".doc-snip").first()).toContainText(/Scapular wall slides/i);

    // Zero native browser alert/confirm dialogs triggered anywhere
    expect(dialogs).toEqual([]);
  });

  test("calendar supports Week view and appointment lifecycle status updates", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");

    await page.goto("/#/calendar");
    // Switch to Week view -> renders 7 day columns
    await page.locator("[data-cal-mode='week']").click();
    await expect(page.locator(".cal-week")).toBeVisible();
    await expect(page.locator(".cal-wk-col")).toHaveCount(7);

    // Switch back to Day view and update a booked appointment's lifecycle status
    await page.locator("[data-cal-mode='day']").click();
    const appt = page.locator(".slot-appt").first();
    await expect(appt).toBeVisible();
    await appt.click();
    await expect(page.locator("[data-appt-st='arrived']")).toBeVisible();
    await page.locator("[data-appt-st='arrived']").click();

    // Status chip should update to "Checked in" and persist after reload
    await expect(page.locator(".slot-appt.st-arrived .appt-st-chip").first()).toContainText("Checked in");
    await waitForSync(page);
    await page.reload();
    await expect(page.locator(".slot-appt.st-arrived .appt-st-chip").first()).toContainText("Checked in");
  });
});
