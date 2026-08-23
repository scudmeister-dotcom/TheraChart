/* TheraChart public-legal-pages checker.

   Google's OAuth consent screen links to /privacy and /terms. Those links are
   quoted to Google once and then read by every person who signs in, so the two
   pages have to be reachable by ANYONE — signed out, no app boot, no hash
   router — and they have to stay reachable. If they 404, sign-in reverts to the
   "Google hasn't verified this app" warning for everybody.

   The dangerous half is the near-miss: the app ALSO has an in-app "#/privacy"
   screen, and that one is the clinic's activity log — staff names and the
   charts they opened. Serving that publicly would be a data breach dressed up
   as a policy page. These checks pin the split.

   Run: node test/legalpages.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const r = reporter("legal pages");
  const s = await startServer();
  try {
    const get = async (p) => {
      const res = await fetch(s.base + p, { redirect: "manual" });
      return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
    };

    for (const [path, title] of [["/privacy", "Privacy Policy"], ["/terms", "Terms of Service"]]) {
      const res = await get(path);
      r.check(`${path} is served to a signed-out visitor`, res.status === 200,
        `got ${res.status} — the consent screen link would be dead`);
      r.check(`${path} is HTML`, res.type.includes("text/html"), res.type);
      r.check(`${path} is the ${title}`, res.body.includes(`<title>${title} — TheraChart</title>`));
      /* No script, so the page renders under the app's own CSP (which forbids
         inline script) and still works for a crawler or a text browser. */
      r.check(`${path} carries no script`, !/<script/i.test(res.body));
      // Each points at the other, so a reader can reach both from either.
      const other = path === "/privacy" ? "/terms" : "/privacy";
      r.check(`${path} links to ${other}`, res.body.includes(`href="${other}"`));
    }

    /* The whole point of the split: the PUBLIC privacy page is the policy, and
       must not carry the clinic's activity feed. */
    const priv = await get("/privacy");
    for (const leak of ["activityFeed", "logSearch", "auditRangeSeg", "Activity log"]) {
      r.check(`the public policy page does not expose the activity log (${leak})`,
        !priv.body.includes(leak),
        "that markup belongs to the in-app #/privacy screen, which names staff and charts");
    }
    r.check("the public policy page states the no-cookies claim the product actually keeps",
      /no cookies/i.test(priv.body));

    // The allowlist still has to refuse everything that is not the web app.
    r.check("server source is still not downloadable", (await get("/server.js")).status === 404);
    r.check("the legal directory itself is not listable", (await get("/legal/")).status === 404);
    r.check("a made-up legal page 404s rather than falling through",
      (await get("/legal/secrets.html")).status === 404);
  } finally { s.stop(); }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
