#!/usr/bin/env node
/* Recaptures every image in marketing-screenshots/ from the running app.

   These are photographs of the product, not mock-ups — that is the whole point
   of them, and it is why they go stale the moment the UI moves. Doing it by
   hand meant they drifted: before this script the walkthrough still showed a
   single-card note column, a "Listen" button and an "English" language picker,
   none of which the app has had for some time. A stale screenshot is a promise
   we can't keep, so the fix is to make recapturing cheap enough to do on every
   UI change:

     node tools/capture-screenshots.js            # everything
     node tools/capture-screenshots.js walkthrough
     node tools/capture-screenshots.js marketing
     node tools/capture-screenshots.js 05 06 08   # just these, by filename prefix

   It boots its own throwaway server on a free port with a fresh seed, so it
   never touches ./data and two runs can't disagree about what the demo clinic
   contains. Nothing is faked in the browser: the note in shots 05–07 is built
   by typing real sentences into the note's own dictation box, so what you see
   filed into the body map and the measurement table is what the parser
   actually did with them.

   OUTPUT (three sets, all derived from one 3200x2000 capture each)
     marketing-screenshots/*.png              3200x2000, dark, caption bar
     marketing-screenshots/email-size/*.png   1600x1000, same frames halved
     marketing-screenshots/walkthrough/*.jpg  1600x1000, light, no caption
                                              — these are the ones the app
                                              itself serves (landing page hero
                                              and the in-app walkthrough)

   Requires Playwright's chromium, which the repo already has for e2e:
     npx playwright install chromium
*/

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");
const { startServer } = require("../test/helpers/server.js");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "marketing-screenshots");
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "therachart-shots-"));

const W = 1600, H = 1000;              // the frame every image is composed in
const SCALE = 2;                       // captured at 2x -> 3200x2000
const JPEG_QUALITY = 80;

/* The caption bar on the marketing PNGs. Not part of the app — it is drawn
   over the top of the capture, which is why it lives here and not in
   styles.css. Same teal-to-green sweep as the product's own accent. */
const CAPTION_CSS = `
  #shot-caption {
    position: fixed; inset: 0 0 auto 0; z-index: 2147483647;
    height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 18px;
    background: linear-gradient(90deg, #0d5f63 0%, #12886d 55%, #17a463 100%);
    font: 600 14px/1 Figtree, ui-sans-serif, system-ui, sans-serif;
    color: #fff; letter-spacing: -0.01em;
  }
  #shot-caption b { font-weight: 800; font-size: 15px; }
  #shot-caption span { font-weight: 500; opacity: 0.92; }
`;

/* ---------------------------------------------------------------- *
 *  What each image is a picture of.
 *
 *  `act` drives the app to the state being photographed and returns
 *  once it has settled. Everything else is framing.
 * ---------------------------------------------------------------- */

// the note built for shots 05-07, shared so the parser only runs once
let builtDocId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sign in as a seeded demo account by clicking its row, exactly as a visitor
    would — the demo accounts hold no password and are opened by being picked. */
async function signInAs(page, base, userId) {
  await page.goto(base + "/#/", { waitUntil: "networkidle" });
  /* A first-time visitor gets the marketing landing page, not the form. The
     flag is what the app itself sets once an account has signed in on this
     device, so setting it here lands on sign-in without clicking through. */
  await page.evaluate(() => {
    try { localStorage.clear(); localStorage.setItem("therachart-known-account", "1"); } catch { }
  });
  // reload(), not goto(): navigating to the identical URL is a same-document
  // fragment navigation, so the app never re-reads the flag we just set
  await page.reload({ waitUntil: "networkidle" });
  const row = page.locator(`.ta-row[data-ta-id="${userId}"]`);
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.click();
  // the sign-in splash holds for a beat before the app appears
  await page.waitForSelector(".shell", { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector(".splash"), null, { timeout: 15000 }).catch(() => { });
  await sleep(400);
}

const toTop = async (page) => { await page.evaluate(() => window.scrollTo(0, 0)); await sleep(250); };

/** Frame the note column on one workflow group by name.

    "top" puts the group's header just under the fold — right for a group whose
    content is the subject. "bottom" lands the group's END near the bottom of
    the frame, which is what a LAST group needs: anchoring it to the top instead
    scrolled the whole note off and left half the picture empty above the cards
    that follow the note. Anchored to the group, not to a pixel offset, so a
    copy change doesn't slide the subject out of frame. */
async function frameGroup(page, name, align = "top") {
  await page.evaluate(({ name, align }) => {
    const g = [...document.querySelectorAll("details.doc-group")]
      .find((x) => new RegExp(name, "i").test(x.querySelector(".doc-group-title").textContent));
    if (!g) return;
    const r = g.getBoundingClientRect();
    const top = r.top + window.scrollY;
    window.scrollTo(0, Math.max(0, align === "bottom"
      ? top + r.height - window.innerHeight + 78
      : top - 90));
  }, { name, align });
  await sleep(400);
}

async function goHash(page, hash) {
  await page.evaluate((h) => { location.hash = "#/dashboard"; }, hash);
  await sleep(120);
  await page.evaluate((h) => { location.hash = h; }, hash);
  await sleep(500);
}

/** Click one of the patient chart's sub-tabs by its label. */
async function patientTab(page, label) {
  await page.evaluate((l) => {
    const t = [...document.querySelectorAll(".ptab")].find((b) => new RegExp(l, "i").test(b.textContent));
    if (t) t.click();
  }, label);
  await sleep(400);
}

/* Build the note that shots 05-07 photograph, by typing into the note's own
   "type it out" box. That runs the same routing the microphone does, so the
   pinned body-map point and the four measurements in the picture are the
   parser's real output rather than a fixture posed to look like one. */
async function buildDictatedNote(page, base) {
  const id = await page.evaluate(() => {
    const S = window.TheraStore;
    const r = S.createDoc("p-juan", "daily", S.currentUser());
    return r.doc.id;
  });
  builtDocId = id;
  await goHash(page, `#/doc/${id}`);
  /* Ordered the way a visit is actually spoken, and chosen because the parser
     files all four somewhere visible: the complaint pins the body map and fills
     Subjective, the measurement run splits into three rows, the treatment
     sentence fills Treatment summary and the last line drafts the Assessment.
     Sentences that file nowhere make a picture of an empty form. */
  const lines = [
    "patient reports right shoulder pain seven out of ten, worse reaching overhead",
    "right shoulder abduction 90 degrees, external rotation 45, deltoid strength 4 out of 5",
    "we did therapeutic exercise with the theraband and manual therapy to the posterior capsule",
    "patient tolerated treatment well and reported less pain afterwards",
  ];
  for (const line of lines) {
    await page.fill("#typedDictation", line);
    await page.press("#typedDictation", "Enter");
    await sleep(350);
  }
  // typing scrolls the box into view; the shot wants the top of the note
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  return id;
}

const SHOTS = [
  /* ---- walkthrough set: plain light-theme captures, served by the app ---- */
  {
    file: "walkthrough/00-landing.jpg", theme: "light", loggedOut: true,
    async act(page, base) {
      await page.goto(base + "/#/", { waitUntil: "networkidle" });
      await page.evaluate(() => { try { localStorage.clear(); } catch { } });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".landing, .login-box", { timeout: 15000 });
      await sleep(600);
    },
  },
  {
    file: "walkthrough/01-dashboard.jpg", theme: "light", as: "u-maria",
    marketing: { file: "2-dashboard-clinic-overview.png",
      title: "Clinic dashboard", sub: "Today's schedule, unsigned drafts and progress reports due — at a glance" },
    async act(page) { await goHash(page, "#/dashboard"); },
  },
  {
    file: "walkthrough/02-patient-overview.jpg", theme: "light", as: "u-maria",
    async act(page) { await goHash(page, "#/patient/p-juan"); await patientTab(page, "Overview"); await toTop(page); },
  },
  {
    file: "walkthrough/03-documents.jpg", theme: "light", as: "u-maria",
    marketing: { file: "3-patient-chart-documents.png",
      title: "Patient chart — colour-coded PT documents", sub: "Evaluation / daily / progress / discharge · signed notes lock · deleted drafts recoverable" },
    async act(page) { await goHash(page, "#/patient/p-juan"); await patientTab(page, "Documents"); },
  },
  {
    file: "walkthrough/04-patient-info.jpg", theme: "light", as: "u-maria",
    async act(page) { await goHash(page, "#/patient/p-juan"); await patientTab(page, "Info"); },
  },
  {
    file: "walkthrough/05-dictation-body-map.jpg", theme: "light", as: "u-maria",
    marketing: { file: "4-dictation-and-body-map.png",
      title: "Dictate the visit — it writes the note", sub: "English & Tagalog or English & Cebuano · findings pin themselves to the body map" },
    async act(page, base) { await buildDictatedNote(page, base); },
  },
  {
    /* The measurement table lives inside the numbered "Objective" group, so the
       frame is anchored on that group's header rather than on a pixel offset
       that any copy change would slide out from under. */
    file: "walkthrough/06-measurements-filed.jpg", theme: "light", as: "u-maria",
    async act(page, base) {
      if (!builtDocId) await buildDictatedNote(page, base);
      else await goHash(page, `#/doc/${builtDocId}`);
      await frameGroup(page, "Objective");
    },
  },
  {
    file: "walkthrough/07-ai-review.jpg", theme: "light", as: "u-maria",
    async act(page, base) {
      if (!builtDocId) await buildDictatedNote(page, base);
      else await goHash(page, `#/doc/${builtDocId}`);
      await page.click("#refineBtn");
      /* Wait for the REVIEW modal specifically. `.modal` alone matches the bug
         reporter, which is always in the DOM (hidden), and the progress modal
         that runRefine shows first — so the wait passed before there was
         anything to photograph. `.rev-section` is a row of the approval list,
         which only the finished review has. */
      await page.waitForFunction(
        () => !!document.querySelector("#modalRoot .rev-section"), null, { timeout: 30000 });
      await sleep(1200);
    },
  },
  {
    /* The units are the point, and the signature under them is what makes them
       a claim — so this is the note built above, charged from its own treatment
       summary and then actually signed. A seeded note would have been less work
       and a worse picture: those carry no transcript, so half the frame was an
       empty left column. */
    file: "walkthrough/08-billing.jpg", theme: "light", as: "u-maria",
    async act(page, base) {
      if (!builtDocId) await buildDictatedNote(page, base);
      else await goHash(page, `#/doc/${builtDocId}`);

      /* The charge sheet a therapist would have typed for what was dictated —
         therapeutic exercise and manual therapy. 97110 is deliberately left
         claiming one unit against 23 minutes: the claim this slide makes is
         that the app works out what the units SHOULD be and flags the
         disagreement, and a sheet that already adds up demonstrates nothing. */
      await page.evaluate((id) => {
        const S = window.TheraStore;
        const d = S.getDoc(id);
        d.data.charges = [
          { code: "97110", desc: "Therapeutic exercise", minutes: 23, units: 1 },
          { code: "97140", desc: "Manual therapy", minutes: 15, units: 1 },
        ];
        S.updateDocData(id, d.data, S.currentUser());
      }, builtDocId);
      await goHash(page, `#/doc/${builtDocId}`);

      // e-sign. A demo account holds no password, so the modal re-auths on the
      // typed name alone — see store.signDoc.
      await page.click("#signBtn");
      await page.waitForSelector("#sigName", { timeout: 10000 });
      await page.fill("#sigName", "Maria Santos, PT");
      await page.click("#sigOk");
      await page.waitForFunction(() => !!document.querySelector(".lock-banner"), null, { timeout: 10000 });
      await sleep(500);

      /* Collapse the steps that aren't the subject. This is a real action a
         real therapist takes — the groups exist to be shut — and it is what
         makes the picture: the charge sheet and the signature sit high in the
         column beside the body map, instead of a screenful below it with half
         the frame left empty. */
      await page.evaluate(() => {
        document.querySelectorAll("details.doc-group").forEach((g) => {
          if (!/Billing/i.test(g.querySelector(".doc-group-title").textContent)) g.open = false;
        });
      });
      await sleep(400);
      await toTop(page);
    },
  },
  {
    file: "walkthrough/09-calendar.jpg", theme: "light", as: "u-maria",
    async act(page) { await goHash(page, "#/calendar"); await sleep(400); },
  },
  {
    /* Posed mid-error on purpose: the claim is that intake catches mistakes
       before a chart exists, and an empty form does not show that. The name is
       a patient the clinic already has and the phone is too short — a warning
       and a hard error, so the picture shows the app telling the two apart. */
    file: "walkthrough/10-intake-guardrails.jpg", theme: "light", as: "u-maria",
    async act(page) {
      await goHash(page, "#/intake");
      await page.fill("#in-first", "Mark Anthony");
      await page.fill("#in-last", "Bautista");
      await page.fill("#in-dob", "1988-04-12");
      await page.fill("#in-phone", "0917555");
      await page.click("#intakeSave");
      await sleep(700);
    },
  },
  {
    file: "walkthrough/11-privacy.jpg", theme: "light", as: "u-grace",
    marketing: { file: "5-privacy-and-phi-protection.png",
      title: "Privacy & security", sub: "Who saw what, in plain language · where the data lives · export or erase, any time" },
    async act(page) {
      await goHash(page, "#/privacy");
      await page.evaluate(() => { const d = document.querySelector(".info-acc-item"); if (d) d.open = true; });
      await sleep(400);
    },
  },

  /* ---- marketing-only frames (no walkthrough equivalent) ---- */
  {
    file: null, theme: "dark", loggedOut: true,
    marketing: { file: "1-secure-login.png",
      title: "Secure sign-in", sub: "Every employee has their own login and role-based access" },
    async act(page, base) {
      await page.goto(base + "/#/", { waitUntil: "networkidle" });
      await page.evaluate(() => { try { localStorage.setItem("therachart-known-account", "1"); } catch { } });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".login-box", { timeout: 15000 });
      // the demo roster is a sales-box feature, not part of the product picture
      await page.evaluate(() => { const d = document.getElementById("demoAccounts"); if (d) d.remove(); });
      await sleep(500);
    },
  },
  {
    file: null, theme: "dark", as: "u-grace",
    marketing: { file: "6-staff-management-and-consent.png",
      title: "Staff, licences and the clinic's plan", sub: "Expired licences block signing automatically · usage and allowance in one place" },
    async act(page) { await goHash(page, "#/facility"); await sleep(500); },
  },
];

/* ---------------------------------------------------------------- *
 *  Capture
 * ---------------------------------------------------------------- */

async function capture(page, base, shot, session) {
  // sign in / out only when the shot needs a different session than the last
  const want = shot.loggedOut ? null : (shot.as || null);
  if (want !== session.who) {
    if (want) await signInAs(page, base, want);
    else {
      await page.goto(base + "/#/", { waitUntil: "networkidle" });
      await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { } });
    }
    session.who = want;
    if (want) builtDocId = null; // documents belong to a session's clinic
  }

  await page.emulateMedia({ colorScheme: shot.theme === "dark" ? "dark" : "light" });
  await page.addStyleTag({ content: CAPTION_CSS }).catch(() => { });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), shot.theme);

  await shot.act(page, base);

  // re-assert after the act: a full re-render can replace <html>'s attributes
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), shot.theme);

  /* The demo banner is honest and must stay in the app — but these captures
     are pictures of the product a clinic buys, and that clinic never sees it.
     Leaving it in would put "nothing you do is saved to a real chart" across
     the top of our own marketing. Removed from the frame, not from the app. */
  await page.evaluate(() => document.querySelector(".demo-banner")?.remove());
  await sleep(150);

  const raw = path.join(TMP, `raw-${Math.random().toString(36).slice(2)}.png`);

  // 1. the walkthrough frame — the app's own screen, nothing added
  if (shot.file) {
    await page.evaluate(() => { const c = document.getElementById("shot-caption"); if (c) c.remove(); });
    await sleep(120);
    await page.screenshot({ path: raw });
    const dest = path.join(OUT, shot.file);
    toJpeg(raw, dest, W, H);
    console.log(`  ✓ ${shot.file}`);
  }

  // 2. the marketing frame — same screen, dark, with the caption bar over it
  if (shot.marketing) {
    await page.evaluate(({ title, sub, css }) => {
      document.getElementById("shot-caption")?.remove();
      if (!document.getElementById("shot-caption-css")) {
        const s = document.createElement("style");
        s.id = "shot-caption-css"; s.textContent = css;
        document.head.appendChild(s);
      }
      const el = document.createElement("div");
      el.id = "shot-caption";
      el.innerHTML = `<b></b><span></span>`;
      el.querySelector("b").textContent = title;
      el.querySelector("span").textContent = sub;
      document.body.appendChild(el);
    }, { title: shot.marketing.title, sub: shot.marketing.sub, css: CAPTION_CSS });

    // the marketing set is dark even where the walkthrough frame is light
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await sleep(350);

    await page.screenshot({ path: raw });
    const full = path.join(OUT, shot.marketing.file);
    fs.copyFileSync(raw, full);                                  // 3200x2000
    resizePng(full, path.join(OUT, "email-size", shot.marketing.file), W, H);
    console.log(`  ✓ ${shot.marketing.file}  (+ email-size)`);

    await page.evaluate(() => document.getElementById("shot-caption")?.remove());
  }

  fs.rmSync(raw, { force: true });
}

/* sips ships with macOS, so the resize/encode step needs no extra dependency. */
const sips = (args) => execFileSync("sips", args, { stdio: ["ignore", "ignore", "pipe"] });

function resizePng(src, dest, w, h) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  sips(["-z", String(h), String(w), src, "--out", dest]);
}

function toJpeg(src, dest, w, h) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const scaled = path.join(TMP, "scaled.png");
  sips(["-z", String(h), String(w), src, "--out", scaled]);
  sips(["-s", "format", "jpeg", "-s", "formatOptions", String(JPEG_QUALITY), scaled, "--out", dest]);
  fs.rmSync(scaled, { force: true });
}

/* ---------------------------------------------------------------- */

(async () => {
  const args = process.argv.slice(2);
  const wanted = (shot) => {
    if (!args.length) return true;
    const names = [shot.file, shot.marketing && shot.marketing.file].filter(Boolean).join(" ");
    return args.some((a) =>
      (a === "walkthrough" && shot.file) ||
      (a === "marketing" && shot.marketing) ||
      names.includes(a));
  };
  const todo = SHOTS.filter(wanted);
  if (!todo.length) { console.error("Nothing matched. Try: walkthrough | marketing | 05 06"); process.exit(1); }

  console.log(`Recapturing ${todo.length} frame(s) at ${W}x${H} @${SCALE}x…\n`);

  // The demo logins are what lets this script pick a role without a password;
  // AI/cloud credentials stay blanked by the helper so no capture bills a call.
  const server = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
    // captures must not depend on the machine's clock or locale
    locale: "en-GB",
    timezoneId: "Asia/Manila",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`    ! page error: ${e.message}`));

  const session = { who: undefined };
  let failed = 0;
  try {
    for (const shot of todo) {
      try {
        await capture(page, server.base, shot, session);
      } catch (e) {
        failed += 1;
        console.error(`  ✗ ${shot.file || shot.marketing.file}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
    server.stop();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} frame(s) failed.` : "\nAll frames captured.");
  process.exit(failed ? 1 : 0);
})();
