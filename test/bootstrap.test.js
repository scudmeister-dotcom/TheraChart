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

      /* Each row carries its clinic name so the sign-in dropdown can group by
         clinic. u-fresh deliberately sits in its own empty clinic — without
         this the panel would file it under the staffed demo clinic and then
         open a blank EMR on whoever clicked it. */
      const accounts = data.testAccounts || [];
      r.check("every listed account names its clinic",
        accounts.every((a) => typeof a.clinic === "string" && a.clinic.length > 0),
        JSON.stringify(accounts.map((a) => [a.email, a.clinic])));
      const freshRow = accounts.find((a) => a.email === "fresh@therachart.demo");
      const mariaRow = accounts.find((a) => a.email === "maria@therachart.demo");
      r.check("the blank-clinic account is grouped apart from the staffed clinic",
        !!freshRow && !!mariaRow && freshRow.clinic !== mariaRow.clinic,
        `fresh=${freshRow && freshRow.clinic} maria=${mariaRow && mariaRow.clinic}`);

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

  /* ---------------------------------------------------------------- *
   *  A long-lived deployment that has NEVER had the demo accounts
   *
   *  This is the state the Cloud Run instance was actually in: storage is
   *  non-empty, so seed() never fires, so the demo logins simply do not exist
   *  — enabling the panel alone would have shown nothing, and typing the
   *  addresses by hand returned "Incorrect email or password".
   *  store.ensureDemoAccounts() (run at boot, behind the same flag) grafts
   *  them back. What it must NOT do is touch the clinic's real staff.
   * ---------------------------------------------------------------- */

  {
    // A "production" database: one real clinic, one real admin, no demo anything.
    const prodBlob = JSON.stringify({
      settings: { facilityName: "Real Clinic" },
      clinics: { "clinic-owner": { id: "clinic-owner", name: "Real Clinic" } },
      users: [{
        id: "u-owner", name: "Dr. Real Owner", email: "owner@realclinic.ph", role: "admin",
        pin: "supersecret", active: true, clinicId: "clinic-owner",
        license: { number: "PT-9999999", expires: "2030-01-01" },
      }],
      patients: [{ id: "p-real", clinicId: "clinic-owner", name: "Real Patient" }],
      documents: [], appointments: [], audit: [], accessRequests: [], sessionUserId: null,
    });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-nodemo-"));
    fs.writeFileSync(path.join(dataDir, "therachart.json"), prodBlob);

    const s = await startServer({ THERACHART_DEMO_LOGINS: "1" }, { dataDir });
    try {
      const { data } = await s.call("/api/bootstrap");
      const emails = (data.testAccounts || []).map((a) => String(a.email).toLowerCase());
      r.check("demo logins are restored on a database that never had them",
        emails.length === 6, `${emails.length} listed: ${JSON.stringify(emails)}`);
      r.check("the blank-clinic login is among them",
        emails.includes("fresh@therachart.demo"), JSON.stringify(emails));

      // The whole point: every advertised row must actually work.
      for (const email of ["grace@therachart.demo", "maria@therachart.demo", "ana@therachart.demo", "fresh@therachart.demo"]) {
        const login = await s.login(email, "1234");
        r.check(`${email} can sign in`, login.status === 200 && !!login.data.token,
          `status ${login.status} ${JSON.stringify(login.data)}`);
      }
      // carlo is seeded as voided — the panel says so, and the server agrees
      const voided = await s.login("carlo@therachart.demo", "1234");
      r.check("the voided demo account is still refused", voided.status !== 200, `status ${voided.status}`);

      // ...and the real clinic is untouched.
      r.check("the real admin's password was NOT reset",
        (await s.login("owner@realclinic.ph", "1234")).status !== 200);
      const owner = await s.login("owner@realclinic.ph", "supersecret");
      r.check("the real admin can still sign in", owner.status === 200 && !!owner.data.token,
        `status ${owner.status}`);
      r.check("the real admin is not published on the sign-in screen",
        !JSON.stringify(data).includes("realclinic.ph"), JSON.stringify(data).slice(0, 300));

      // Tenancy is what keeps the published password harmless: a demo admin
      // must not be able to see the real clinic's patients.
      const grace = await s.login("grace@therachart.demo", "1234");
      const seen = await s.call("/api/state", { token: grace.data.token });
      const names = JSON.stringify(((seen.data || {}).state || {}).patients || []);
      r.check("a demo admin cannot see the real clinic's patients",
        !names.includes("Real Patient"), names.slice(0, 300));
    } finally { s.stop(); }

    /* The address drift that actually broke the live instance. Accounts stored
       before email login had no email; ensureEmails() derived one from the name
       ("Maria Santos, PT" -> maria.santos@therachart.demo), so the documented
       maria@therachart.demo returned "Incorrect email or password" even though
       the account was right there. The graft must restore the seed address. */
    {
      const drift = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-drift-"));
      fs.writeFileSync(path.join(drift, "therachart.json"), JSON.stringify({
        settings: { facilityName: "Physical Therapy Center" },
        clinics: { "clinic-demo": { id: "clinic-demo", name: "Physical Therapy Center" } },
        // seeded ids, but no email — exactly the pre-email-login shape
        users: [{ id: "u-maria", name: "Maria Santos, PT", role: "therapist", active: true, clinicId: "clinic-demo" }],
        patients: [], documents: [], appointments: [], audit: [], accessRequests: [], sessionUserId: null,
      }));
      const s2 = await startServer({ THERACHART_DEMO_LOGINS: "1" }, { dataDir: drift });
      try {
        const login = await s2.login("maria@therachart.demo", "1234");
        r.check("a drifted demo address is restored to the documented one",
          login.status === 200 && !!login.data.token, `status ${login.status}`);
        const { data } = await s2.call("/api/bootstrap");
        const emails = (data.testAccounts || []).map((a) => String(a.email).toLowerCase());
        r.check("the panel advertises the documented address, not the derived one",
          emails.includes("maria@therachart.demo") && !emails.includes("maria.santos@therachart.demo"),
          JSON.stringify(emails));
      } finally { s2.stop(); }
      try { fs.rmSync(drift, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // Idempotent: a second boot must not duplicate anything.
    const again = await startServer({ THERACHART_DEMO_LOGINS: "1" }, { dataDir });
    try {
      const { data } = await again.call("/api/bootstrap");
      r.check("a second boot does not duplicate the demo accounts",
        (data.testAccounts || []).length === 6, `${(data.testAccounts || []).length} listed`);
    } finally { again.stop(); }

    // The same production database, with the flag OFF, must stay clean — the
    // graft is opt-in, so an ordinary clinic deployment grows no demo logins.
    // (Copied from the pristine blob, not from dataDir, which has been grafted.)
    const off = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-off-"));
    fs.writeFileSync(path.join(off, "therachart.json"), prodBlob);
    const clean = await startServer({}, { dataDir: off });
    try {
      const { data } = await clean.call("/api/bootstrap");
      r.check("the panel stays empty when the flag is off",
        (data.testAccounts || []).length === 0, JSON.stringify(data.testAccounts));
      r.check("no demo account is created when the flag is off",
        (await clean.login("grace@therachart.demo", "1234")).status !== 200);
    } finally { clean.stop(); }

    for (const d of [dataDir, off]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
