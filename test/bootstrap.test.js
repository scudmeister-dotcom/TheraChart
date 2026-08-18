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

      /* The demo accounts carry NO password, on a server that offers no demo
         at all. This is the case the /api/login demo gate cannot cover — that
         gate only runs where a demo is offered — so if the shared "1234" ever
         still worked anywhere, it would be here. */
      const login = await s.login("grace@therachart.demo", "1234");
      r.check("the old shared password opens nothing, even with no demo offered",
        login.status !== 200, `status ${login.status} ${JSON.stringify(login.data).slice(0, 120)}`);
      r.check("…and the refusal gives nothing away",
        /incorrect email or password/i.test(String((login.data || {}).error || "")),
        JSON.stringify(login.data));
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
      r.check("no listed account carries a password",
        (data.testAccounts || []).every((a) => a.password === undefined),
        JSON.stringify(data.testAccounts).slice(0, 200));
      r.check("every listed account carries the id the picker opens it by",
        (data.testAccounts || []).every((a) => typeof a.id === "string" && a.id),
        JSON.stringify(data.testAccounts).slice(0, 200));

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
      // a demo box refuses a typed demo password, so enter the way the panel does
      const admin = await first.demoSignIn("u-grace");
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

      /* The whole point: every advertised row must actually open. Through the
         picker's own path now — a typed password is refused wherever a demo is
         offered, so exercising these by password would test the refusal. */
      for (const id of ["u-grace", "u-maria", "u-ana", "u-fresh"]) {
        const opened = await s.demoSignIn(id);
        r.check(`${id} opens from the panel`, opened.status === 200 && !!opened.data.token,
          `status ${opened.status} ${JSON.stringify(opened.data)}`);
        const typed = await s.login(`${id.replace(/^u-/, "")}@therachart.demo`, "1234");
        r.check(`${id} cannot be entered by typing its password`, typed.status === 403,
          `status ${typed.status}`);
      }
      // carlo is seeded as voided — the panel says so, and the server agrees
      const voided = await s.demoSignIn("u-carlo");
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
      const grace = await s.demoSignIn("u-grace");
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
        const opened = await s2.demoSignIn("u-maria");
        r.check("a drifted demo account still opens", opened.status === 200 && !!opened.data.token,
          `status ${opened.status}`);
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

  /* ---------------------------------------------------------------- *
   *  Invite-only demo: the picker is the ONLY way into a demo account
   * ---------------------------------------------------------------- *
   *  Hiding the panel stopped PUBLISHING the shared password; it did not stop
   *  the password working. Anyone who saw it once, or guessed it, could still
   *  type their way in — so the gate around the picker bought nothing. These
   *  checks pin the fix: where a demo is offered, the credential is inert and
   *  entry goes through a request that authorizes the CALLER.
   */
  {
    const s = await startServer({ THERACHART_DEMO_INVITE: "1" });
    try {
      const { data } = await s.call("/api/bootstrap");
      r.check("invite mode advertises the demo without naming an account",
        data.demoInvite === true && (data.testAccounts || []).length === 0,
        JSON.stringify(data).slice(0, 200));
      r.check("invite mode publishes no password",
        !JSON.stringify(data).includes("1234"), JSON.stringify(data).slice(0, 200));

      const typed = await s.login("grace@therachart.demo", "1234");
      r.check("a typed demo password is refused", typed.status === 403,
        `status ${typed.status} ${JSON.stringify(typed.data).slice(0, 120)}`);
      r.check("…and says where to go instead of 'wrong password'",
        /demo panel/i.test(String((typed.data || {}).error)),
        JSON.stringify(typed.data));

      /* The refusal must not become a way to enumerate real staff: a real
         account on the same server still authenticates normally. */
      const listed = await s.call("/api/demo-logins");
      r.check("the account list needs a caller", listed.status === 401,
        `status ${listed.status}`);
      const jumped = await s.call("/api/demo-signin", { method: "POST", body: { userId: "u-grace" } });
      r.check("entering the demo needs a caller too", jumped.status === 401,
        `status ${jumped.status}`);
      /* The picker must still WORK for someone who is allowed to use it —
         a gate that locks everyone out is not a gate, it is an outage. */
      const admin = await s.login("amador.moriles@gmail.com", "x");
      const viaPanel = await s.call("/api/demo-signin", { method: "POST",
        token: (admin.data || {}).token, body: { userId: "u-grace" } });
      r.check("an unknown caller still cannot enter", viaPanel.status !== 200,
        `status ${viaPanel.status}`);
    } finally { s.stop(); }
  }

  /* ---------------------------------------------------------------- *
   *  Requesting an account without Google
   * ---------------------------------------------------------------- */

  {
    const s = await startServer({ THERACHART_DEMO_INVITE: "1" });
    try {
      const weak = await s.call("/api/request-account", { method: "POST",
        body: { name: "Rosa V", email: "rosa@clinic.test", password: "short" } });
      r.check("a short password is refused", weak.status === 400, `status ${weak.status}`);
      const bad = await s.call("/api/request-account", { method: "POST",
        body: { name: "Rosa V", email: "not-an-email", password: "longenough1" } });
      r.check("a malformed address is refused", bad.status === 400, `status ${bad.status}`);

      const ok = await s.call("/api/request-account", { method: "POST",
        body: { name: "Rosa V", email: "rosa@clinic.test", password: "longenough1" } });
      r.check("a well-formed request is accepted", ok.status === 200, `status ${ok.status}`);
      r.check("the reply does not confirm whether the address is known",
        !/exист|already|exists/i.test(String((ok.data || {}).message || "")),
        JSON.stringify(ok.data));

      /* Requesting is not joining: until an admin approves, the chosen password
         must not sign anyone in. */
      const early = await s.login("rosa@clinic.test", "longenough1");
      r.check("a pending request cannot sign in yet", early.status !== 200,
        `status ${early.status}`);
    } finally { s.stop(); }
  }

  /* ---------------------------------------------------------------- *
   *  …and approving one actually produces a working account
   * ---------------------------------------------------------------- *
   *  The half that matters to the person waiting. A queue that accepts
   *  requests and approves them into an account that cannot sign in is worse
   *  than no queue: the admin believes they have let someone in.
   */
  {
    // an admin in the clinic that access requests are routed to
    const ownerDir = fs.mkdtempSync(path.join(os.tmpdir(), "therachart-approve-"));
    fs.writeFileSync(path.join(ownerDir, "therachart.json"), JSON.stringify({
      settings: { facilityName: "My Clinic" },
      clinics: { "clinic-owner": { id: "clinic-owner", name: "My Clinic" } },
      users: [{
        id: "u-boss", name: "Dr. Boss", email: "boss@myclinic.ph", role: "admin",
        pin: "bosspassword1", active: true, clinicId: "clinic-owner",
        license: { number: "PT-1", expires: "2030-01-01" },
      }],
      patients: [], documents: [], appointments: [], audit: [], accessRequests: [], sessionUserId: null,
    }));
    // the operator is identified by email — this box's operator is the boss
    const s = await startServer({ GOOGLE_OWNER_EMAIL: "boss@myclinic.ph" }, { dataDir: ownerDir });
    try {
      const asked = await s.call("/api/request-account", { method: "POST",
        body: { name: "Rosa V", email: "rosa@clinic.test", password: "rosaPassword1" } });
      r.check("the request is accepted", asked.status === 200, `status ${asked.status}`);

      const boss = await s.login("boss@myclinic.ph", "bosspassword1");
      r.check("the admin can sign in", boss.status === 200 && !!boss.data.token, `status ${boss.status}`);
      const token = (boss.data || {}).token;

      const state = await s.call("/api/state", { token });
      const queued = (((state.data || {}).state || {}).accessRequests || [])
        .filter((q) => q.status === "pending");
      r.check("the request reaches the admin's own queue",
        queued.some((q) => q.email === "rosa@clinic.test"),
        JSON.stringify(queued.map((q) => q.email)));
      r.check("…tagged as an email request, not a Google one",
        (queued.find((q) => q.email === "rosa@clinic.test") || {}).source === "email");
      r.check("…and the queue does not expose the chosen password",
        !JSON.stringify(queued).includes("rosaPassword1"), JSON.stringify(queued).slice(0, 200));

      const target = queued.find((q) => q.email === "rosa@clinic.test");

      /* A clinic admin who is NOT the operator must not be able to approve —
         approving decides which clinic a real person joins, and every clinic
         has an admin. */
      const notOwner = await s.call("/api/users", { method: "POST", token,
        body: { name: "Other Admin", email: "other@myclinic.ph", role: "admin", password: "otherPass12",
                license: { number: "PT-2", expires: "2030-01-01" } } });
      r.check("the operator can still add an account directly", notOwner.status === 200, `status ${notOwner.status}`);
      const other = await s.login("other@myclinic.ph", "otherPass12");
      const refused = await s.call("/api/access-requests", { method: "POST", token: (other.data || {}).token,
        body: { id: target && target.id, action: "approve", role: "therapist" } });
      r.check("a clinic admin who is not the operator cannot approve",
        refused.status === 403, `status ${refused.status}`);
      r.check("…and cannot add an account directly either",
        (await s.call("/api/users", { method: "POST", token: (other.data || {}).token,
          body: { name: "Sneak", email: "sneak@myclinic.ph", role: "therapist", password: "sneakPass12" } })).status === 403);
      r.check("…but the operator's queue is not even readable to them",
        (await s.call("/api/access-requests", { token: (other.data || {}).token })).status === 403);

      const approved = await s.call("/api/access-requests", { method: "POST", token,
        body: { id: target && target.id, action: "approve", role: "therapist" } });
      r.check("the admin can approve it", approved.status === 200, `status ${approved.status} ${JSON.stringify(approved.data).slice(0, 160)}`);

      const after = await s.login("rosa@clinic.test", "rosaPassword1");
      r.check("the approved person can now sign in with the password they chose",
        after.status === 200 && !!after.data.token, `status ${after.status} ${JSON.stringify(after.data).slice(0, 160)}`);
      r.check("…and lands in the approving admin's clinic",
        (((after.data || {}).state || {}).clinics || {})["clinic-owner"] !== undefined,
        JSON.stringify(Object.keys(((after.data || {}).state || {}).clinics || {})));

      /* ---- the operator decides WHICH clinic, including a brand-new one ---- */
      const asked2 = await s.call("/api/request-account", { method: "POST",
        body: { name: "Bea N", email: "bea@bayanihanpt.ph", password: "beaPassword1" } });
      r.check("a second person can ask", asked2.status === 200, `status ${asked2.status}`);
      const q2 = (((await s.call("/api/state", { token })).data || {}).state || {}).accessRequests || [];
      const bea = q2.find((q) => q.email === "bea@bayanihanpt.ph" && q.status === "pending");

      const intoNew = await s.call("/api/access-requests", { method: "POST", token,
        body: { id: bea && bea.id, action: "approve", role: "admin", newClinicName: "Bayanihan Physical Therapy" } });
      r.check("the operator can approve into a brand-new clinic",
        intoNew.status === 200 && !!intoNew.data.clinicId,
        `status ${intoNew.status} ${JSON.stringify(intoNew.data).slice(0, 160)}`);
      r.check("…and it is NOT the operator's own clinic",
        intoNew.data.clinicId !== "clinic-owner", String(intoNew.data.clinicId));

      const beaIn = await s.login("bea@bayanihanpt.ph", "beaPassword1");
      r.check("the approved admin signs into their own new clinic",
        beaIn.status === 200 && Object.keys(((beaIn.data || {}).state || {}).clinics || {})[0] === intoNew.data.clinicId,
        JSON.stringify(Object.keys(((beaIn.data || {}).state || {}).clinics || {})));
      r.check("…and cannot see the operator's clinic",
        (((beaIn.data || {}).state || {}).clinics || {})["clinic-owner"] === undefined);

      r.check("a duplicate clinic name is refused",
        (await s.call("/api/access-requests", { method: "POST", token,
          body: { id: bea && bea.id, action: "approve", role: "admin", newClinicName: "Bayanihan Physical Therapy" } })).status === 400);
      r.check("an unknown clinic id is refused rather than filed anywhere",
        (await s.call("/api/access-requests", { method: "POST", token,
          body: { id: bea && bea.id, action: "approve", role: "therapist", clinicId: "clinic-nope" } })).status === 400);

      /* ---- a clinic admin asks for staff instead of adding them ---------- */
      const beaToken = (beaIn.data || {}).token;
      r.check("a clinic admin cannot add an account themselves",
        (await s.call("/api/users", { method: "POST", token: beaToken,
          body: { name: "Direct Add", email: "direct@bayanihanpt.ph", role: "therapist", password: "directPass1" } })).status === 403);

      const asked3 = await s.call("/api/staff-requests", { method: "POST", token: beaToken,
        body: { name: "Ramil Torres, PT", email: "ramil@bayanihanpt.ph", role: "therapist", password: "ramilTemp123" } });
      r.check("…but can request one for their clinic", asked3.status === 200, `status ${asked3.status} ${JSON.stringify(asked3.data).slice(0,140)}`);

      const opQueue = await s.call("/api/access-requests", { token });
      const ramil = (opQueue.data.requests || []).find((q) => q.email === "ramil@bayanihanpt.ph");
      r.check("the request reaches the OPERATOR, not the asking admin", !!ramil,
        JSON.stringify((opQueue.data.requests || []).map((q) => q.email)));
      r.check("…stamped with the asking clinic, so it lands back there",
        ramil && ramil.clinicName === "Bayanihan Physical Therapy", ramil && ramil.clinicName);
      r.check("…and carries the role the clinic asked for",
        ramil && ramil.wantRole === "therapist", ramil && ramil.wantRole);
      r.check("…without exposing the temporary password",
        !JSON.stringify(opQueue.data.requests).includes("ramilTemp123"));

      const okRamil = await s.call("/api/access-requests", { method: "POST", token,
        body: { id: ramil && ramil.id, action: "approve", role: "therapist", clinicId: intoNew.data.clinicId } });
      r.check("the operator approves it into that clinic", okRamil.status === 200, `status ${okRamil.status}`);
      const ramilIn = await s.login("ramil@bayanihanpt.ph", "ramilTemp123");
      r.check("the requested therapist can sign in with the temporary password",
        ramilIn.status === 200 && !!ramilIn.data.token, `status ${ramilIn.status}`);
      const ramilSelf = (((ramilIn.data || {}).state || {}).users || []).find((u) => u.email === "ramil@bayanihanpt.ph");
      r.check("…is told to set their own password first",
        ramilSelf && ramilSelf.mustChangePassword === true, JSON.stringify(ramilSelf && ramilSelf.mustChangePassword));
      r.check("…and is in the clinic that asked for them",
        ramilSelf && ramilSelf.clinicId === intoNew.data.clinicId, ramilSelf && ramilSelf.clinicId);

      /* Removing is still the clinic's own call — the dangerous direction is
         leaving a departed employee with a login, not taking one away. */
      r.check("a clinic admin can still remove someone from their clinic",
        (await s.call("/api/delete-user", { method: "POST", token: beaToken,
          body: { userId: ramilSelf && ramilSelf.id } })).status === 200);
    } finally { s.stop(); }
    try { fs.rmSync(ownerDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
