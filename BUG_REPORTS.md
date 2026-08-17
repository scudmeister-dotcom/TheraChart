# Bug reports from testers

Testers press **Report a bug** (bottom-right, on every screen once signed in).
The report is **always stored on the server**; emailing it is a separate,
optional step you turn on with a webhook.

That split is deliberate: if the mail path breaks, you lose a notification, not
the report. Reports survive at `/api/bug-reports` (admin only) either way.

---

## What a report contains

Written by the tester:

- **What happened** (required)
- **What they expected instead**
- **What they were doing just before**
- **How much it gets in their way** — blocks me / annoying / looks wrong / idea
- **An optional picture** — captured from the screen, or attached from a file

Collected automatically, so the tester doesn't have to describe it:

- the screen they were on (`#/doc/d-abc123`), their window size, their browser
- who they are and their role
- the app revision and the AI model in use, so a report can be tied to a build

> **A screenshot of an open chart contains patient information.** The form says
> so, above the capture button. During a demo the data is seeded and fake. On a
> clinic's real instance it is not, and emailing it offsite would be a Data
> Privacy Act problem. Keep screenshots to demo data, or blank out real details
> first.

---

## Getting them into your inbox

`BUG_REPORT_WEBHOOK` is a URL the server POSTs each report to as JSON. Anything
that accepts a POST works — Zapier, Make, n8n, your own function. The cheapest
option uses your own Google account, costs nothing, and needs no API key:

### Google Apps Script (about two minutes)

1. Go to **script.google.com** → **New project**.
2. Replace everything in the editor with this:

```javascript
// Emails each TheraChart bug report to you, with the screenshot attached.
const TO = "amador.moriles@gmail.com";

function doPost(e) {
  const r = JSON.parse(e.postData.contents);
  const c = r.context || {};
  const who = (r.reporter || {}).name || "someone";

  const body = [
    r.summary,
    "",
    r.expected ? "EXPECTED: " + r.expected : "",
    r.steps ? "DOING JUST BEFORE: " + r.steps : "",
    "",
    "Severity : " + r.severity,
    "Reporter : " + who + " (" + ((r.reporter || {}).role || "?") + ")",
    "Screen   : " + (c.route || "?") + "  " + (c.screen || ""),
    "Browser  : " + (c.browser || "?"),
    "App rev  : " + (c.appRev || "?") + "   model: " + (c.model || "?"),
    "Report id: " + r.id,
    "Filed    : " + r.at,
  ].filter(String).join("\n");

  const opts = { name: "TheraChart testing" };
  if (r.screenshot) {
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(r.screenshot);
    if (m) {
      opts.attachments = [
        Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], r.id + ".jpg"),
      ];
    }
  }

  MailApp.sendEmail(TO, "[TheraChart " + r.severity + "] " + r.summary.slice(0, 70), body, opts);
  return ContentService.createTextOutput("ok");
}
```

3. **Deploy** → **New deployment** → type **Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**  ← required; the server calls it without a login
4. Copy the deployment URL (`https://script.google.com/macros/s/…/exec`).
5. Point the server at it:

```bash
gcloud run services update therachart --region us-central1 \
  --update-env-vars BUG_REPORT_WEBHOOK=https://script.google.com/macros/s/YOUR_ID/exec
```

Locally, export the same variable before `./start.sh`.

**Check it works** by filing a test report from the app. The server logs one
line per report either way:

```
[bug] bug-4f2a1c from Maria Santos, PT (annoying) — stored=true delivered=true: the measurement table...
```

`delivered=false` means the webhook is missing or failed — the report is still
stored, and `gcloud run services logs read therachart --region us-central1`
will say why.

---

## Reading them without email

Any admin can pull the stored reports:

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  https://therachart-cmcoe52aaa-uc.a.run.app/api/bug-reports | python3 -m json.tool
```

Newest first, capped at the most recent 200. Screenshots are stripped from the
list — it is for triage, not for viewing images.
