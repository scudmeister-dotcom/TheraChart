/* TheraChart bootstrap checker — what an UNAUTHENTICATED visitor can learn.

   /api/bootstrap is the one endpoint served before anyone signs in, so whatever
   it returns is public. It used to return the seeded demo accounts — including
   an admin — together with their shared password, on every deployment that had
   run the seed. Convenient for a sales demo; not something that should be the
   default for a clinic holding real patient records.

   These checks pin the two properties that matter:
     - the demo panel is OFF unless THERACHART_DEMO_LOGINS=1 is set
     - even when it is ON, only the accounts store.js seed() created are listed
   The second is the subtle one. store.ensureEmails() mints an @therachart.demo
   address for any account saved without one — which includes a real therapist
   added through Calendar → "+ Add PT" — so a filter on the email domain alone
   would, after a restart, publish real staff names and emails on the public
   sign-in screen under the heading "Test accounts · password 1234".

   Run: node test/bootstrap.test.js */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const r = reporter("bootstrap checker");

  /* ---------------------------------------------------------------- *
   *  Default: no demo logins published
   * ---------------------------------------------------------------- */

  {
    const s = await startServer();
    try {
      const { status, data } = await s.call("/api/bootstrap");
      r.check("bootstrap is reachable unauthenticated", status === 200, `status ${status}`);
      r.check("testAccounts is present but empty by default",
        Array.isArray(data.testAccounts) && data.testAccounts.length === 0,
        JSON.stringify(data.testAccounts));
      r.check("no demo email is published by default",
        !JSON.stringify(data).match(/therachart\.demo/i),
        JSON.stringify(data).slice(0, 300));
      r.check("no password is published by default",
        !JSON.stringify(data).includes("1234"), JSON.stringify(data).slice(0, 300));
      r.check("the staff roster is still not exposed",
        data.users === undefined && data.staff === undefined,
        JSON.stringify(Object.keys(data)));

      /* Hiding the panel must not disable the accounts — the demo still needs
         to be able to sign in, it just isn't advertised. */
      const login = await s.login("grace@therachart.demo", "1234");
      r.check("a seeded account can still sign in when the panel is hidden",
        login.status === 200 && !!login.data.token, `status ${login.status}`);
    } finally { s.stop(); }
  }

  /* ---------------------------------------------------------------- *
   *  Opt-in: the demo box
   * ---------------------------------------------------------------- */

  {
    const s = await startServer({ THERACHART_DEMO_LOGINS: "1" });
    try {
      const { data } = await s.call("/api/bootstrap");
      const emails = (data.testAccounts || []).map((a) => a.email);
      r.check("the panel populates when explicitly enabled",
        (data.testAccounts || []).length > 0, JSON.stringify(emails));
      r.check("every listed account is a seeded demo account",
        emails.every((e) => /@therachart\.demo$/i.test(e)), JSON.stringify(emails));
      r.check("the listed accounts carry the shared demo password",
        (data.testAccounts || []).every((a) => a.password === "1234"));

    } finally { s.stop(); }
  }

  /* ---------------------------------------------------------------- *
   *  Only SEEDED accounts are ever published
   *
   *  The published list is keyed on store.SEEDED_DEMO_USER_IDS rather than on
   *  the @therachart.demo domain, because ensureEmails() hands that domain to
   *  any account saved without an email — a real therapist included.
   *
   *  Worth recording what a push CANNOT do, since it bounds the risk: a device
   *  push cannot invent a user at all. graftPushedState drops accounts the push
   *  invented ("/api/users is the only way in", server.js), so a therapist added
   *  through Calendar → "+ Add PT" never reaches the server roster this way.
   *  The id filter is therefore belt-and-braces on the server, and the load-
   *  bearing one in local (serverless) mode, where app.js builds the same panel
   *  from the on-device roster.
   * ---------------------------------------------------------------- */

  {
    const env = { THERACHART_DEMO_LOGINS: "1" };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-boot-"));
    const first = await startServer(env, { dataDir });
    try {
      const admin = await first.login("grace@therachart.demo", "1234");
      const state = await first.call("/api/state", { token: admin.data.token });
      const blob = state.data && state.data.state;
      blob.users.push({
        id: "u-realpt", name: "Dr. Elena Bautista, PT", email: "",
        role: "therapist", active: true, clinicId: blob.users[0].clinicId,
      });
      const put = await first.call("/api/state", {
        method: "PUT", token: admin.data.token, body: { state: blob, baseRev: state.data.rev },
      });
      r.check("a state push is accepted", put.status === 200, `status ${put.status}`);

      const after = await first.call("/api/state", { token: admin.data.token });
      const invented = ((after.data.state || {}).users || []).find((u) => u.id === "u-realpt");
      r.check("a device push cannot invent a user account", !invented,
        invented ? JSON.stringify(invented) : "");
    } finally { first.stop(); }

    // Restart against the same directory: ensureEmails() runs at boot, and this
    // is the point at which a domain-only filter would start leaking.
    const second = await startServer(env, { dataDir });
    try {
      const { data } = await second.call("/api/bootstrap");
      const listed = data.testAccounts || [];

      /* Compare against the seed itself, unscoped. /api/state is clinic-scoped
         and u-fresh deliberately lives in its own empty clinic, so the roster a
         signed-in admin sees is the wrong yardstick here — the sign-in panel is
         pre-auth and spans every clinic on the server. */
      const store = require("../store.js");
      store.resetAll();
      const seeded = new Set(store.SEEDED_DEMO_USER_IDS);
      const seededEmails = new Set(
        store.users().filter((u) => seeded.has(u.id)).map((u) => (u.email || "").toLowerCase()));

      r.check("store exports the seeded demo ids", seeded.size > 0);
      r.check("the seed still contains those accounts",
        seededEmails.size === seeded.size, `${seededEmails.size} of ${seeded.size} resolved`);
      r.check("every published account is a seeded one",
        listed.every((a) => seededEmails.has(String(a.email).toLowerCase())),
        JSON.stringify(listed.map((a) => a.email).filter((e) => !seededEmails.has(String(e).toLowerCase()))));
    } finally { second.stop(); }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
