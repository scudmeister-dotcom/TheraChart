/* TheraChart browser smoke tests.

   Deliberately NOT a broad UI suite — five paths where a silent break would be
   worst, and which no server-side test can see:

     1. the app boots and a therapist's chart actually renders
     2. clinic isolation holds ON SCREEN, not just in the API response
     3. dictation pins the body map and files the measurement
     4. signing locks a note
     5. facility settings are per clinic

   Anything provable without a browser belongs in the Node suites instead —
   they run in seconds and never flake. */

const { test, expect } = require("@playwright/test");

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

/** The clinic name as shown in the dashboard subtitle (not the splash). */
const clinicSubtitle = (page) => page.locator(".sub").first();

/** The app's own store, for reading client state and setting up fixtures. */
const store = (page, fn, arg) => page.evaluate(fn, arg);

/* Assert against the SERVER, not the browser's copy.
   sync.js polls every 6s and calls adopt(), which replaces local state with
   the server's — so polling `window.TheraStore` after a UI action races that
   timer and makes tests flaky. Persistence is the real claim anyway: the
   change reached the clinic server, not just this tab. */
async function serverState(request, email) {
  // Same door as the browser takes: /api/demo-signin authorizes the caller
  // rather than trusting a shared secret, and answers with the scoped state.
  const boot = await (await request.get("/api/bootstrap")).json();
  const acct = (boot.testAccounts || []).find((a) => a.email.toLowerCase() === email.toLowerCase());
  if (!acct) throw new Error(`no demo account for ${email} — is THERACHART_DEMO_LOGINS=1 set for the e2e server?`);
  const res = await request.post("/api/demo-signin", { data: { userId: acct.id } });
  return (await res.json()).state;
}

test.describe("TheraChart", () => {
  test("a therapist signs in and their clinic's chart renders", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    await expect(clinicSubtitle(page)).toContainText("Physical Therapy Center");
    await page.getByRole("link", { name: /^patients$/i }).first().click();

    // the three seeded demo patients, by name, on screen
    await expect(page.getByText("Bautista, Mark Anthony")).toBeVisible();
    await expect(page.getByText("Gonzales, Marilou")).toBeVisible();
    await expect(page.getByText("Villanueva, Mateo")).toBeVisible();

    // and the app is talking to the server, not silently in on-device mode
    await expect(page.getByText(/Synced with clinic server/i)).toBeVisible();
  });

  test("another clinic sees an empty EMR, with no trace of the first", async ({ page }) => {
    await signIn(page, "fresh@therachart.demo");

    await expect(clinicSubtitle(page)).toContainText("New Clinic");
    await page.getByRole("link", { name: /^patients$/i }).first().click();
    await expect(page.getByText(/No patients found/i)).toBeVisible();

    // The API test proves the payload is scoped. This proves nothing leaked
    // into the rendered page or the device's own storage either.
    const html = await page.content();
    for (const name of ["Bautista", "Gonzales", "Villanueva"]) {
      expect(html, `"${name}" must not appear anywhere in another clinic's page`).not.toContain(name);
    }
    const cached = await page.evaluate(() => localStorage.getItem("therachart-emr-v1") || "");
    for (const name of ["Bautista", "Gonzales", "Villanueva"]) {
      expect(cached, `"${name}" must not sit in another clinic's localStorage`).not.toContain(name);
    }
  });

  test("dictation pins the body map and files the measurement", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    // open a fresh daily note on the first patient
    const docId = await store(page, () => {
      const S = window.TheraStore;
      const p = S.patients()[0];
      const r = S.createDoc(p.id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);

    await page.locator("#typedDictation").fill(
      "my right shoulder is really painful, about eight out of ten when I reach overhead"
    );
    await page.locator("#typedDictationAdd").click();

    // the pain rating is filed into the objective measurements table…
    const meas = page.locator("#measTable");
    await expect(meas).toContainText("Pain");
    await expect(meas).toContainText("right shoulder");
    await expect(meas).toContainText("8/10");

    // …and the body map carries a pin for the right shoulder
    const pins = await store(page, (id) => {
      const d = window.TheraStore.getDoc(id).data || {};
      return (d.mapPoints || []).map((p) => `${p.part}|${p.side || ""}`);
    }, docId);
    expect(pins).toContain("Shoulder|right");

    // the patient's own words are kept verbatim
    await expect(page.locator("body")).toContainText("reach overhead");

    /* …and the Objective step's fill count notices. The count is the only
       thing telling a therapist that a COLLAPSED group filled itself, and it
       was counting `data.measurements` — a key dictation never writes, since
       it sorts them into rom / mmt / special / pain. So the group read 0 with
       measurements sitting under it. */
    const objective = page.locator("details.doc-group", { hasText: "Objective" }).first();
    await expect(objective.locator(".doc-group-count")).toHaveText(/^1\/\d+$/);
  });

  /* A therapist reads measurements out in a run — the joint once, then the
     motions, with the unit dropped after the first. This filed only the first
     number and lost the side off the muscle grade entirely, which a live
     dictation against Vertex surfaced: three measurements spoken, one stored,
     and no error to say the rest had gone. */
  test("a run of dictated measurements is filed in full, with sides", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    const docId = await store(page, () => {
      const S = window.TheraStore;
      const p = S.patients()[0];
      const r = S.createDoc(p.id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);

    await page.locator("#typedDictation").fill(
      "right shoulder abduction 90 degrees, external rotation 45, deltoid strength 4 over 5"
    );
    await page.locator("#typedDictationAdd").click();

    const meas = page.locator("#measTable");
    // both angles, not just the first
    await expect(meas).toContainText("90°");
    await expect(meas).toContainText("45°");
    await expect(meas).toContainText("abduction");
    await expect(meas).toContainText("external rotation");
    // the muscle grade, carrying the side it was measured on
    await expect(meas).toContainText("4/5");
    await expect(meas).toContainText("deltoid");

    const filed = await store(page, (id) => {
      const d = window.TheraStore.getDoc(id).data || {};
      return {
        rom: (d.rom || []).map((r) => `${r.side}|${r.joint}|${r.motion}|${r.degrees}`),
        mmt: (d.mmt || []).map((r) => `${r.side}|${r.context}|${r.grade}`),
      };
    }, docId);

    expect(filed.rom).toContain("right|shoulder|abduction|90");
    expect(filed.rom).toContain("right|shoulder|external rotation|45");
    expect(filed.mmt.join(",")).toContain("right|deltoid|4/5");
  });

  /* The delete dialog quotes what a draft has already spent. It used to name
     both halves unconditionally — "0 min of dictation and 1 AI pass" — which
     says a microphone was open when none ever was, in the one dialog whose
     whole job is to be believed about a bill. */
  test("the delete dialog names only what was actually spent", async ({ page }) => {
    await signIn(page, "maria@therachart.demo");

    const docId = await store(page, () => {
      const S = window.TheraStore;
      const r = S.createDoc(S.patients()[0].id, "daily", S.currentUser());
      const id = (r && r.id) || (r && r.doc && r.doc.id);
      // an AI pass and no dictation at all — the case that produced "0 min"
      S.updateDocData(id, { subjective: "x", _aiCalls: 1 }, S.currentUser());
      return id;
    });
    await page.goto(`/#/doc/${docId}`);

    await page.locator("button", { hasText: "Delete draft" }).first().click();
    const dialog = page.locator("#modalRoot .modal");
    await expect(dialog).toContainText("1 AI pass");
    await expect(dialog).not.toContainText("0 min");
    await expect(dialog).not.toContainText("dictation");
    // one thing spent, so the follow-on is singular
    await expect(dialog).toContainText("That was charged");

    // and with both, it names both and goes plural again
    await page.locator("#modalRoot button", { hasText: "Keep it" }).click();
    await store(page, (id) => {
      const S = window.TheraStore;
      S.updateDocData(id, { _dictationSeconds: 240 }, S.currentUser());
    }, docId);
    await page.reload();
    await page.locator("button", { hasText: "Delete draft" }).first().click();
    await expect(dialog).toContainText("of dictation");
    await expect(dialog).toContainText("1 AI pass");
    await expect(dialog).toContainText("Both were charged");
  });

  test("signing a note locks it", async ({ page, request }) => {
    await signIn(page, "maria@therachart.demo");

    const docId = await store(page, () => {
      const S = window.TheraStore;
      const p = S.patients()[0];
      const r = S.createDoc(p.id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });
    await page.goto(`/#/doc/${docId}`);
    await page.locator("#typedDictation").fill("left knee is sore after walking");
    await page.locator("#typedDictationAdd").click();

    await expect(page.locator("#signBtn")).toBeVisible();
    await page.locator("#signBtn").click();

    // e-signing re-authenticates: the therapist types their full registered
    // name and password, exactly as a real signature would be attested
    const fullName = await store(page, () => window.TheraStore.currentUser().name);
    await page.locator("#sigName").fill(fullName);
    /* No password field: this account holds no password, so the typed name
       above IS the signature (see hasNoPassword in app.js). */
    await expect(page.locator("#sigPin")).toHaveCount(0);
    await page.locator("#sigOk").click();

    await expect
      .poll(async () => {
        const st = await serverState(request, "maria@therachart.demo");
        return (st.documents.find((d) => d.id === docId) || {}).status;
      }, { message: "the note should reach the server signed", timeout: 10_000 })
      .toBe("signed");

    // a locked note must no longer offer free-text dictation
    await page.reload();
    await expect(page.locator("#typedDictation")).toHaveCount(0);
  });

  test("an account with no license on file can still be given one", async ({ page }) => {
    // Google accounts are created with license: null. The staff row used to
    // render the license inputs only `if (u.license)`, so those accounts had
    // no way to add one — and canDocument() then blocks every clinical note.
    // A sole admin hit this as a hard deadlock: no fields, nobody else to ask.
    await signIn(page, "grace@therachart.demo");

    await store(page, () => {
      const S = window.TheraStore;
      const me = S.currentUser();
      const raw = S.getUser(me.id);
      raw.license = null;          // exactly the shape a Google sign-in produces
      S.save();
    });

    await page.goto("/#/facility");
    const uid = await store(page, () => window.TheraStore.currentUser().id);

    // the fields must be there even with nothing on file
    const num = page.locator(`[data-lic-num="${uid}"]`);
    const exp = page.locator(`[data-lic-exp="${uid}"]`);
    await expect(num).toBeVisible();
    await expect(exp).toBeVisible();
    await expect(num).toHaveValue("");

    await num.fill("PT-0012345");
    await exp.fill("2099-01-01");
    await page.locator(`[data-save-user="${uid}"]`).click();

    await expect
      .poll(async () => store(page, (id) => {
        const l = (window.TheraStore.getUser(id) || {}).license;
        return l && l.number;
      }, uid), { message: "the license should save", timeout: 10_000 })
      .toBe("PT-0012345");

    // and the account can document again
    const canDoc = await store(page, () => window.TheraStore.canDocument(window.TheraStore.currentUser()));
    expect(canDoc, "a licensed admin should be able to create clinical documents").toBe(true);
  });

  test("a Google account is asked to confirm with Google, not for a password", async ({ page }) => {
    // A Google account has no password at all, so the e-sign dialog's password
    // field could never be satisfied — the account could write a note and then
    // never sign it. The dialog must offer Google re-confirmation instead.
    await signIn(page, "maria@therachart.demo");

    const docId = await store(page, () => {
      const S = window.TheraStore;
      const p = S.patients()[0];
      const r = S.createDoc(p.id, "daily", S.currentUser());
      return (r && r.id) || (r && r.doc && r.doc.id);
    });

    // turn this account into exactly the shape a Google sign-in produces
    await store(page, () => {
      const S = window.TheraStore;
      const raw = S.getUser(S.currentUser().id);
      raw.authProvider = "google";
      delete raw.passwordHash;
      delete raw.pin;
      S.save();
    });

    await page.goto(`/#/doc/${docId}`);
    await page.locator("#typedDictation").fill("left knee is sore after walking");
    await page.locator("#typedDictationAdd").click();
    await page.locator("#signBtn").click();

    // no password box, a Google confirmation area instead, and signing is
    // disabled until that confirmation succeeds
    await expect(page.locator("#sigPin")).toHaveCount(0);
    await expect(page.locator("#sigGoogle")).toBeVisible();
    await expect(page.locator("#sigOk")).toBeDisabled();
    /* :visible matters now — the bug reporter keeps its own hidden dialog in
       the DOM on every screen, so "the first .modal" is no longer "the modal
       that just opened". */
    await expect(page.locator(".modal:visible").first()).toContainText(/confirm with google/i);

    // and the note is still a draft — nothing was signed without confirmation
    const status = await store(page, (id) => (window.TheraStore.getDoc(id) || {}).status, docId);
    expect(status).toBe("draft");
  });

  test("facility settings belong to one clinic only", async ({ page, request }) => {
    await signIn(page, "grace@therachart.demo"); // clinic-demo admin
    await page.goto("/#/facility");

    await expect(page.locator("#st-name")).toBeVisible();
    await page.locator("#st-name").fill("Bayanihan PT Center");
    await page.locator("#st-slot").fill("30");
    await page.locator("#st-prog").fill("8");
    await page.locator("#st-audio").check();
    await page.locator("#stSave").click();

    await expect
      .poll(async () => (await serverState(request, "grace@therachart.demo")).settings.slotMinutes,
        { message: "the setting should persist to the clinic server", timeout: 10_000 })
      .toBe(30);

    // the other clinic must be completely unaffected — audioReview especially,
    // since it governs whether patient dictation audio is retained at all
    const theirs = (await serverState(request, "fresh@therachart.demo")).settings;
    expect({ name: theirs.facilityName, slot: theirs.slotMinutes, prog: theirs.progressEvery, audio: theirs.audioReview })
      .toEqual({ name: "New Clinic", slot: 45, prog: 5, audio: false });

    // and it still reads as their own clinic on screen
    await signIn(page, "fresh@therachart.demo");
    await expect(clinicSubtitle(page)).toContainText("New Clinic");
  });
});
