/* TheraChart bug-report checker.

   Testers are the best defect-finding tool this product has, so the report path
   has to be the most reliable thing in the app: it must never lose a report, it
   must not need a working webhook to accept one, and it must not let the whole
   clinic read each other's complaints.

   Run: node test/bugreport.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const r = reporter("bug-report checker");
  const s = await startServer({ THERACHART_DEMO_LOGINS: "1" });

  try {
    const therapist = (await s.demoSignIn("u-maria")).data.token;
    const frontdesk = (await s.demoSignIn("u-ana")).data.token;
    const admin = (await s.demoSignIn("u-grace")).data.token;

    /* ---------------- filing a report ---------------- */

    const filed = await s.call("/api/bug-report", {
      method: "POST", token: therapist,
      body: {
        summary: "Measurement table stayed empty after dictating knee angles",
        expected: "120 degrees of knee flexion listed",
        steps: "Opened a patient, started a daily note, pressed Listen",
        severity: "blocks-me",
        screenshot: PNG_1PX,
        context: { route: "#/doc/d-1", screen: "390x844", browser: "test", online: true },
      },
    });
    r.check("a therapist can file a report", filed.status === 200 && filed.data.ok,
      `status ${filed.status} ${JSON.stringify(filed.data).slice(0, 140)}`);
    r.check("…and gets an id back to quote", /^bug-/.test((filed.data || {}).id || ""), JSON.stringify(filed.data));

    /* No webhook is configured in tests, so this also proves the important
       property: an undelivered report is still a STORED report. */
    r.check("a report is accepted even with no webhook configured",
      filed.status === 200 && filed.data.delivered === false,
      `delivered=${JSON.stringify((filed.data || {}).delivered)}`);

    /* ---------------- what a report must carry ---------------- */

    const listed = await s.call("/api/bug-reports", { token: admin });
    r.check("an admin can read the reports", listed.status === 200, `status ${listed.status}`);
    const rep = ((listed.data || {}).reports || [])[0];
    r.check("the report was stored", !!rep, JSON.stringify(listed.data).slice(0, 160));
    if (rep) {
      r.check("…with who reported it", rep.reporter && rep.reporter.id === "u-maria", JSON.stringify(rep.reporter));
      r.check("…with the severity they chose", rep.severity === "blocks-me", rep.severity);
      r.check("…with the screen they were on", rep.context && rep.context.route === "#/doc/d-1", JSON.stringify(rep.context));
      r.check("…with the app revision, so it can be tied to a build",
        rep.context && typeof rep.context.appRev === "number", JSON.stringify(rep.context));
      r.check("…and a note that a screenshot came with it", rep.hasScreenshot === true, JSON.stringify(rep.hasScreenshot));
      /* The list view must not carry the images: a hundred screenshots would
         make the admin page multi-megabyte for no benefit. */
      r.check("the list view does not inline the screenshots",
        rep.screenshot === undefined, "screenshots must be fetched deliberately, not in bulk");
    }

    /* ---------------- who may read them ---------------- */

    const asFront = await s.call("/api/bug-reports", { token: frontdesk });
    r.check("front desk cannot read the reports", asFront.status === 403, `status ${asFront.status}`);
    const asNobody = await s.call("/api/bug-reports");
    r.check("an unauthenticated caller cannot read them", asNobody.status === 401, `status ${asNobody.status}`);
    const fileAsNobody = await s.call("/api/bug-report", { method: "POST", body: { summary: "x" } });
    r.check("an unauthenticated caller cannot file one either", fileAsNobody.status === 401, `status ${fileAsNobody.status}`);

    /* ---------------- input the server must refuse ---------------- */

    const empty = await s.call("/api/bug-report", { method: "POST", token: therapist, body: { summary: "   " } });
    r.check("a report with no description is refused", empty.status === 400, `status ${empty.status}`);

    const huge = await s.call("/api/bug-report", {
      method: "POST", token: therapist,
      body: { summary: "big shot", screenshot: "data:image/png;base64," + "A".repeat(5 * 1024 * 1024) },
    });
    r.check("an oversized screenshot is refused, not stored", huge.status === 400, `status ${huge.status}`);

    const notAnImage = await s.call("/api/bug-report", {
      method: "POST", token: therapist,
      body: { summary: "sneaky", screenshot: "data:text/html;base64,PHNjcmlwdD4=" },
    });
    r.check("a non-image masquerading as a screenshot is refused",
      notAnImage.status === 400, `status ${notAnImage.status}`);

    const weirdSeverity = await s.call("/api/bug-report", {
      method: "POST", token: therapist, body: { summary: "odd severity", severity: "catastrophic" },
    });
    r.check("an unknown severity falls back rather than being stored raw",
      weirdSeverity.status === 200, `status ${weirdSeverity.status}`);
    const after = await s.call("/api/bug-reports", { token: admin });
    const odd = ((after.data || {}).reports || []).find((x) => x.summary === "odd severity");
    r.check("…to a known value", odd && ["blocks-me", "annoying", "cosmetic", "idea"].includes(odd.severity),
      odd ? odd.severity : "report not found");
  } finally { s.stop(); }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
