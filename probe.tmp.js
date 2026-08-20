const { chromium } = require("@playwright/test");
const { startServer } = require("./test/helpers/server.js");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const s = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  await p.goto(s.base + "/#/");
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem("therachart-known-account","1"); });
  await p.reload({ waitUntil: "networkidle" });
  await p.click('.ta-row[data-ta-id="u-maria"]');
  await p.waitForSelector(".shell"); await sleep(1200);
  const id = await p.evaluate(() => window.TheraStore.createDoc("p-juan","daily",window.TheraStore.currentUser()).doc.id);
  await p.evaluate((h)=>{location.hash=h;}, "#/doc/"+id); await sleep(800);
  const lines = [
    "patient reports right shoulder pain seven out of ten, worse reaching overhead",
    "he says it wakes him at night when he rolls onto that side",
    "right shoulder abduction 90 degrees, external rotation 45, deltoid strength 4 out of 5",
    "performed scapular retraction and rotator cuff isometrics, reviewed home programme",
    "we did therapeutic exercise with the theraband and manual therapy to the posterior capsule",
    "treatment today was rotator cuff isometrics and scapular retraction, tolerated well",
    "patient tolerated treatment well and reported less pain afterwards",
  ];
  for (const l of lines) {
    await p.fill("#typedDictation", l);
    await p.press("#typedDictation", "Enter");
    await sleep(400);
  }
  await sleep(600);
  console.log(JSON.stringify(await p.evaluate((i) => {
    const d = window.TheraStore.getDoc(i);
    return { subjective: d.data.subjective, summary: d.data.summary, assessment: d.data.assessment, plan: d.data.plan,
             meas: (d.data.measurements||[]).map(m=>`${m.type} ${m.detail} ${m.value}`), map: (d.data.mapPoints||[]).length };
  }, id), null, 2));
  await b.close(); s.stop();
})();
