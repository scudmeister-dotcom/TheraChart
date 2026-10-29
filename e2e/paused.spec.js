/* TheraChart with dictation paused — what the default build looks like.

   Dictation is off unless the server is started with THERACHART_DICTATION=1
   (see DICTATION_ENABLED in server.js). The server side is pinned by
   test/dictationpause.test.js; this proves the page agrees: no microphone,
   recorder or language picker anywhere a therapist can reach, typed findings
   as the way in, and a dashboard that leads with outstanding work and search.

   Runs in the "paused" project, against a server started WITHOUT the flag. */

const { test, expect } = require("@playwright/test");
const { signIn, waitForSync } = require("./helpers.js");

const MIC_CONTROLS = "#micBtn, #recBtn, #recBar, #langSel, [data-fieldmic], #interim, #audioReview";

test.describe("dictation paused", () => {
  // saves reach the server in the background; let each test's last one land
  // before its page closes, or the next test inherits a stale server state
  test.afterEach(async ({ page }) => { await waitForSync(page).catch(() => {}); });

  test("a note has no microphone controls, and typed findings pin the body map", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    const docId = await page.evaluate(() => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);

    await expect(page.getByRole("heading", { name: "Findings & body map" })).toBeVisible();
    await expect(page.locator(MIC_CONTROLS)).toHaveCount(0);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/dictat|Record the visit|Listen|Hearing/i);

    // the AI is offered as an optional extra, not a step in charting
    await expect(page.locator("#refineBtn")).toContainText("Polish wording with AI");
    await expect(page.locator("#refineBtn")).toContainText("optional");

    await page.locator("#typedDictation").fill("sharp pain in the left knee, 6/10, worse on stairs");
    await page.locator("#typedDictationAdd").click();
    await expect(page.locator("#measTable")).toContainText("left knee");
    await expect(page.locator("#measTable")).toContainText("6/10");
    await expect(page.locator("#mapNotes")).toContainText(/knee/i);
  });

  test("findings go in one per row, and Enter starts the next row", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await page.evaluate(() => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);

    const rows = page.locator(".frow-input");
    await rows.first().click();
    await page.keyboard.type("sharp pain in the left knee, 6/10");
    await page.keyboard.press("Enter");          // next row, nothing filed yet
    await page.keyboard.type("left knee flexion 110 degrees");
    await page.keyboard.press("Enter");
    await page.keyboard.type("right shoulder stiff in the morning");
    await expect(rows).toHaveCount(3);
    await expect(page.locator(".utt")).toHaveCount(0);
    await expect(page.locator("#typedDictationAdd")).toContainText("Add 3 findings");

    await page.locator("#typedDictationAdd").click();
    // each row became its own entry, and the box is ready for the next batch
    await expect(page.locator(".utt")).toHaveCount(3);
    await expect(page.locator(".frow-input").first()).toHaveValue("");
    // every entry is the therapist's — no patient/clinician relabelling
    await expect(page.locator(".spk-toggle")).toHaveCount(0);
  });

  test("deleting an entry takes back the pin, reading and text it added", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await page.evaluate(() => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);

    await page.locator("#typedDictation").fill("sharp pain in the left knee, 6/10, worse on stairs");
    await page.locator("#typedDictationAdd").click();
    await expect(page.locator("#measTable")).toContainText("6/10");
    await expect(page.locator("#mapNotes")).toContainText(/knee/i);

    await page.locator(".utt").first().hover();
    await page.locator("[data-delutt]").first().click();
    await expect(page.locator(".utt")).toHaveCount(0);
    await expect(page.locator("#measTable")).not.toContainText("6/10");
    await expect(page.locator("#mapNotes")).not.toContainText(/knee/i);
    await expect(page.locator('textarea[data-field="subjective"]')).toHaveValue("");

    // and Undo puts all of it back
    await page.locator("#undoDelEntry").click();
    await expect(page.locator(".utt")).toHaveCount(1);
    await expect(page.locator("#measTable")).toContainText("6/10");
    await expect(page.locator("#mapNotes")).toContainText(/knee/i);
  });

  test("facility settings show no dictation options, and saving keeps them", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");
    await page.goto("/#/facility");
    await expect(page.locator("#st-lang, #st-audio, #st-fairuse, #st-maxdict")).toHaveCount(0);

    // saving with the fields absent must not reset what was stored for them
    const before = await page.evaluate(() => window.TheraStore.settings().dictationLang);
    await page.locator("#stSave").click();
    const after = await page.evaluate(() => window.TheraStore.settings().dictationLang);
    expect(after).toBe(before);
  });

  test("the dashboard searches patients and therapists from one box", async ({ page }) => {
    await signIn(page, "grace@therachart.demo");

    await expect(page.locator(".work-queue")).toBeVisible();
    const search = page.locator("#dashSearch");

    await search.fill("Villanueva");
    await expect(page.locator("#dashResults")).toContainText("Patients");
    await expect(page.locator("#dashResults")).toContainText("Villanueva, Mateo");

    // picking a therapist shows their workload rather than leaving the page
    await search.fill("Maria");
    await expect(page.locator("#dashResults")).toContainText("Therapists & staff");
    await search.press("Enter");
    await expect(page.locator(".scope-person")).toContainText("Maria Santos");
    await expect(page.locator(".dash-summary")).toContainText("Maria Santos");
  });

  test("each list has its own Filter: sort, kind and patient, and items drag into the person's own order", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const drafts = page.locator("#q-drafts .q-item .q-main b");
    const pop = page.locator('[data-qpop="drafts"]');
    const followCount = await page.locator("#q-follow .q-item").count();
    // default: the most overdue note first, no filter on
    await expect(page.locator("#q-drafts .q-item").first().locator(".chip")).toContainText("overdue");
    await expect(page.locator("#q-drafts .q-active")).toHaveCount(0);

    // the Filter button opens a panel for this list only; choices apply at once
    await page.locator('[data-qfilter="drafts"]').click();
    await expect(pop).toBeVisible();
    await expect(pop.locator('[data-qsort="overdue"]')).toHaveClass(/\bon\b/);
    await pop.locator('[data-qkind="eval"]').click();
    await expect(pop).toBeVisible();
    for (const tag of await page.locator("#q-drafts .doc-tag").allTextContents()) expect(tag).toBe("EVAL");
    await expect(page.locator("#q-drafts .q-active")).toContainText("Evals");
    await expect(page.locator("#q-follow .q-item")).toHaveCount(followCount); // other lists untouched
    await pop.locator('[data-qkind="all"]').click();

    // one patient, then by name; Done closes and the header says what's on
    const pick = pop.locator('[data-qpatient="drafts"] option').nth(1);
    const pname = await pick.textContent();
    await pop.locator('[data-qpatient="drafts"]').selectOption(await pick.getAttribute("value"));
    for (const n of await drafts.allTextContents()) expect(n).toBe(pname);
    await pop.locator('[data-qsort="name"]').click();
    await pop.getByRole("button", { name: "Done" }).click();
    await expect(pop).toHaveCount(0);
    await expect(page.locator("#q-drafts .q-active")).toContainText(pname);
    await page.locator("#q-drafts .q-active-x").click();
    await expect(page.locator("#q-drafts .q-active")).toHaveCount(0);

    // Escape closes the panel too
    await page.locator('[data-qfilter="follow"]').click();
    await expect(page.locator('[data-qpop="follow"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-qpop]")).toHaveCount(0);

    // drag the second note above the first
    const before = await drafts.allTextContents();
    const second = await page.locator("#q-drafts .q-item").nth(1).locator(".q-main").textContent();
    await page.locator("#q-drafts [data-qgrip]").nth(1).hover();
    await page.mouse.down();
    const first = await page.locator("#q-drafts .q-item").first().boundingBox();
    const grip = await page.locator("#q-drafts [data-qgrip]").nth(1).boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, first.y + 4, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator("#q-drafts .q-item").first().locator(".q-main")).toHaveText(second);
    await expect(page.locator("#q-drafts .q-active")).toContainText("Custom order");

    // kept across a reload; arrow keys move a focused grip; Reset goes back
    await page.reload();
    await expect(page.locator("#q-drafts .q-item").first().locator(".q-main")).toHaveText(second);
    await page.locator("#q-drafts [data-qgrip]").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#q-drafts .q-item").nth(1).locator(".q-main")).toHaveText(second);
    await page.locator('[data-qfilter="drafts"]').click();
    await expect(pop).toContainText("Custom order");
    await expect(pop.locator('[data-qsort="overdue"]')).toHaveText("Default order");
    await pop.getByRole("button", { name: "Reset to default order" }).click();
    await expect(drafts).toHaveText(before);
    await expect(pop.locator('[data-qsort="overdue"]')).toHaveClass(/\bon\b/);
  });

  test("a tile opens its section and brings it into view", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await page.locator('[data-qjump="follow"]').last().click();
    await expect(page.locator("#q-follow")).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('[data-qjump="drafts"]').click();
    await expect(page.locator("#q-drafts")).toBeInViewport();
    // the whole list is shown, nothing held back behind "Show all"
    await expect(page.locator("#q-drafts .q-more", { hasText: "Show all" })).toHaveCount(0);
  });

  test("a long list is grouped, items move and pin from their menu, and it all follows the account", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    // enough unsigned notes, of different ages, to pass the grouping threshold
    await page.evaluate(() => {
      const S = window.TheraStore, me = S.currentUser(), pid = S.patients()[0].id;
      for (let i = 0; i < 14; i++) {
        const r = S.createDoc(pid, "daily", me);
        const d = (r && r.doc) || r;
        const when = new Date(); when.setDate(when.getDate() - i * 4); d.createdAt = when.toISOString();
      }
      S.save();
    });
    await waitForSync(page);
    await page.reload();
    const heads = page.locator("#q-drafts [data-qgroup]");
    await expect(heads.first()).toContainText("Over 30 days old");
    await expect(heads.first()).toHaveAttribute("aria-expanded", "true");
    await expect(heads.nth(1)).toHaveAttribute("aria-expanded", "false");
    await heads.nth(1).click();
    await expect(page.locator("#q-drafts [data-qgroup]").nth(1)).toHaveAttribute("aria-expanded", "true");

    // pin the second item: it moves into a Pinned group at the top
    const second = page.locator("#q-drafts .q-item").nth(1);
    const key = await second.getAttribute("data-qkey");
    await second.locator("[data-qmenu]").click();
    await page.locator(".q-menu").getByRole("menuitem", { name: /Pin to top/ }).click();
    await expect(page.locator(`#q-drafts [data-qpinned] [data-qkey="${key}"]`)).toHaveCount(1);

    // move the first unpinned item to the bottom: the list becomes Custom order
    const first = page.locator("#q-drafts .q-group:not(.q-pinned) .q-item").first();
    const fkey = await first.getAttribute("data-qkey");
    await first.locator("[data-qmenu]").click();
    await page.locator(".q-menu").getByRole("menuitem", { name: /Move to bottom/ }).click();
    await expect(page.locator("#q-drafts .q-active")).toContainText("Custom order");
    await page.locator("#q-drafts [data-qmore]").click();
    await expect(page.locator("#q-drafts .q-list:not([data-qpinned]) > .q-item").last()).toHaveAttribute("data-qkey", fkey);

    // a fresh browser (signIn clears storage): the pin and the order come back from the account
    await waitForSync(page);
    await signIn(page, "maria@therachart.demo");
    await expect(page.locator(`#q-drafts [data-qpinned] [data-qkey="${key}"]`)).toHaveCount(1);
    await expect(page.locator("#q-drafts .q-active")).toContainText("Custom order");

    // tidy up for the tests after this one
    await page.locator(`#q-drafts [data-qpinned] [data-qkey="${key}"] [data-qmenu]`).click();
    await page.locator(".q-menu").getByRole("menuitem", { name: /Unpin/ }).click();
    await page.locator("#q-drafts .q-active-x").click();
    await expect(page.locator("#q-drafts [data-qpinned]")).toHaveCount(0);
  });

  test("Back from a chart opened on the dashboard returns to the dashboard", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await page.locator("#dashSearch").fill("Villanueva");
    await page.locator(".dr-item[data-href]").first().click();
    await expect(page).toHaveURL(/#\/patient\//);
    await expect(page.locator(".crumbs")).toContainText("Dashboard");
    await page.locator("#crumbBack").click();
    await expect(page).toHaveURL(/#\/dashboard$/);

    // a draft opened straight from the queue also goes back to the dashboard
    await page.locator("#q-drafts .q-row").first().click();
    await expect(page).toHaveURL(/#\/doc\//);
    await page.locator("#crumbBack").click();
    await expect(page).toHaveURL(/#\/dashboard$/);

    // opened from the Patients list, Back still returns to the list
    await page.goto("/#/patients");
    await page.locator("#patTable").getByText("Villanueva, Mateo").click();
    await expect(page).toHaveURL(/#\/patient\//);
    await expect(page.locator(".crumbs")).toContainText("Patients");
    await page.locator("#crumbBack").click();
    await expect(page).toHaveURL(/#\/patients$/);
  });

  test("a therapist asks for a schedule change, and the front desk books it", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    await page.goto("/#/calendar");
    // the board is view-only for a therapist: no booking, a request instead
    await expect(page.locator("#calRequest")).toBeVisible();
    await page.locator("#calNext").click(); // tomorrow: nothing seeded in the way
    for (let i = 0; i < 6 && !(await page.locator(".slot-free").count()); i++) await page.locator("#calNext").click();
    await expect(page.locator(".slot-free:not(.ask)")).toHaveCount(0);

    const slot = page.locator('.slot-free.ask[data-ther="u-maria"]').nth(2);
    await slot.click();
    await expect(page.locator("#rqKind")).toHaveValue("book");
    await expect(page.locator("#rqTher")).toHaveValue("u-maria");
    await page.locator("#rqNote").fill("Patient asked for this slot");
    await page.locator("#rqSend").click();
    await expect(page.locator("#calRequests")).toContainText("pending");
    await expect(page.locator("#calRequests")).toContainText("Patient asked for this slot");

    // the front desk sees it on the dashboard and answers it on the calendar
    await signIn(page, "ana@therachart.demo");
    await expect(page.locator("#q-follow")).toContainText("Asks to book");
    await page.goto("/#/calendar");
    const row = page.locator(".rq-row", { hasText: "Patient asked for this slot" });
    await row.getByRole("button", { name: "Book it" }).click();
    // it leaves the waiting list and shows as answered
    await expect(page.locator("#calRequests > .rq-row", { hasText: "Patient asked for this slot" })).toHaveCount(0);
    await expect(page.locator("#calRequests details")).toContainText("approved");
  });

  test("an open note keeps its completeness in view while scrolling", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    const docId = await page.evaluate(() => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);
    const pin = page.locator("#notePin");
    await expect(pin).toBeVisible();
    const before = await pin.locator(".np-count").textContent();
    await page.mouse.wheel(0, 3000);
    await expect(pin).toBeInViewport();
    await page.locator('textarea[data-field="assessment"]').fill("Tolerated treatment well.");
    await expect(pin.locator(".np-count")).not.toHaveText(before);
    // and it leaves with the note
    await page.goto("/#/dashboard");
    await expect(pin).toBeHidden();
  });

  test("each work-queue section is its own block with a count", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");
    for (const id of ["drafts", "today", "follow"]) {
      await expect(page.locator(`#q-${id} .q-head .q-count`)).toBeVisible();
    }
    const gap = await page.evaluate(() => {
      const a = document.getElementById("q-drafts").getBoundingClientRect();
      const b = document.getElementById("q-today").getBoundingClientRect();
      return b.top - a.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(12);
  });

  test("on a phone the patient list is one card per patient, name on one line", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, "maria@therachart.demo");
    await page.goto("/#/patients");
    await expect(page.locator("#patTable thead")).toBeHidden();
    await expect(page.locator("#patTable .pt-name").first()).toBeVisible();
    // every name, including the longest seeded one, renders as a single line box
    const lines = await page.locator("#patTable .pt-name b").evaluateAll((els) => els.map((b) => [b.textContent, b.getClientRects().length]));
    for (const [n, count] of lines) expect(count, n).toBe(1);
    await expect(page.locator("#patTable .pt-phone").first()).toBeVisible();
  });

  test("the landing page makes no dictation promises", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("heading", { name: /Chart it once/i })).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/Chart by voice|Listen & dictate|dictation minute/i);
  });
});
