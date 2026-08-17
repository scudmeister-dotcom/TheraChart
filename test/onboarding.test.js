/* TheraChart onboarding checker — creating a clinic, and who may do it.

   Onboarding is the one operation that crosses tenant lines: it creates a
   clinic the caller is not a member of. Everything else in the server is scoped
   so a signed-in user can only reach their own clinic, so the authorisation
   check here IS the security boundary, and these checks exist to keep it.

   The specific trap being guarded: the obvious gate is `role === "admin"`, and
   it is wrong. The seed ships two admin logins whose password is printed on the
   public sign-in screen whenever demo logins are enabled — so gating on the
   admin role would gate on a published credential, and any visitor could create
   clinics. The gate is the GOOGLE_OWNER_EMAIL address instead.

   Run: node test/onboarding.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

const OWNER = "owner@therachart.test";

(async () => {
  const r = reporter("onboarding checker");

  /* ---------------------------------------------------------------- *
   *  Who may onboard a clinic
   * ---------------------------------------------------------------- */

  {
    const s = await startServer({
      THERACHART_DEMO_LOGINS: "1",     // so the demo admin exists to be refused
      GOOGLE_OWNER_EMAIL: OWNER,
    });
    try {
      // The demo admin: role "admin", and a password anyone can read off the
      // public sign-in screen. The most dangerous caller in the system.
      const grace = await s.login("grace@therachart.demo", "1234");
      r.check("the demo admin can sign in at all (precondition)",
        grace.status === 200 && !!grace.data.token, `status ${grace.status}`);

      const listed = await s.call("/api/clinics", { token: grace.data.token });
      r.check("a clinic admin cannot LIST every clinic", listed.status === 403,
        `status ${listed.status} ${JSON.stringify(listed.data)}`);

      const made = await s.call("/api/clinics", {
        method: "POST", token: grace.data.token,
        body: { clinicName: "Hijacked Clinic", ownerName: "Mallory", ownerEmail: "mallory@evil.test", password: "hunter2hunter2" },
      });
      r.check("a clinic admin cannot CREATE a clinic", made.status === 403,
        `status ${made.status} ${JSON.stringify(made.data)}`);
      r.check("the refusal does not leak what's on the other side",
        !JSON.stringify(made.data).match(/clinic-|Physical Therapy/i), JSON.stringify(made.data));

      // ...and no clinic was created as a side effect of trying.
      const stillOut = await s.login("mallory@evil.test", "hunter2hunter2");
      r.check("the refused request created no account", stillOut.status !== 200, `status ${stillOut.status}`);

      // Signed out entirely.
      const anon = await s.call("/api/clinics");
      r.check("an unauthenticated caller is refused", anon.status === 401 || anon.status === 403,
        `status ${anon.status}`);

      // A therapist, for completeness — no role reaches it.
      const maria = await s.login("maria@therachart.demo", "1234");
      const asPt = await s.call("/api/clinics", { token: maria.data.token });
      r.check("a therapist cannot reach it either", asPt.status === 403, `status ${asPt.status}`);
    } finally { s.stop(); }
  }

  /* ---------------------------------------------------------------- *
   *  The owner onboards a clinic, and it is genuinely separate
   * ---------------------------------------------------------------- */

  {
    const s = await startServer({ THERACHART_DEMO_LOGINS: "1", GOOGLE_OWNER_EMAIL: OWNER });
    try {
      /* Give the owner account a password login. The real owner signs in with
         Google (that path maps GOOGLE_OWNER_EMAIL to admin), which needs a live
         Google token; the authorisation being tested is on the email, not on
         how the session was minted, so a password account at the same address
         exercises the same gate. Created by the demo admin, who may add staff
         to their OWN clinic — which is also why the owner starts out in the
         demo clinic here, and why the new clinic must still come out separate. */
      const grace = await s.login("grace@therachart.demo", "1234");
      const mk = await s.call("/api/users", {
        method: "POST", token: grace.data.token,
        body: { name: "Platform Owner", email: OWNER, role: "admin", password: "ownerpassword1" },
      });
      r.check("the owner account was created for the test", mk.status === 200, `status ${mk.status} ${JSON.stringify(mk.data)}`);

      const owner = await s.login(OWNER, "ownerpassword1");
      r.check("the owner can sign in", owner.status === 200 && !!owner.data.token, `status ${owner.status}`);
      r.check("the session is flagged as the platform owner", owner.data.isOwner === true,
        JSON.stringify(owner.data.isOwner));
      r.check("a clinic admin's session is NOT flagged as owner", grace.data.isOwner !== true,
        JSON.stringify(grace.data.isOwner));

      const token = owner.data.token;
      const created = await s.call("/api/clinics", {
        method: "POST", token,
        body: { clinicName: "Bayanihan PT", ownerName: "Bea Navarro, PT", ownerEmail: "bea@bayanihanpt.ph", password: "temporary1234" },
      });
      r.check("the owner can create a clinic", created.status === 200, `status ${created.status} ${JSON.stringify(created.data)}`);
      r.check("the temporary password comes back for the handoff",
        created.data && created.data.temporaryPassword === "temporary1234", JSON.stringify(created.data));

      // The new admin can sign in, and is forced to choose their own password.
      const bea = await s.login("bea@bayanihanpt.ph", "temporary1234");
      r.check("the new clinic's admin can sign in", bea.status === 200 && !!bea.data.token, `status ${bea.status}`);
      const beaSelf = ((bea.data.state || {}).users || []).find((u) => u.email === "bea@bayanihanpt.ph");
      r.check("the new admin must set their own password",
        !!beaSelf && beaSelf.mustChangePassword === true, JSON.stringify(beaSelf));
      r.check("the new admin is an admin of their own clinic",
        !!beaSelf && beaSelf.role === "admin", JSON.stringify(beaSelf && beaSelf.role));

      /* The point of the whole feature: a brand-new clinic opens EMPTY, and
         cannot see the clinic it was created from. */
      const beaState = bea.data.state || {};
      r.check("the new clinic starts with no patients",
        (beaState.patients || []).length === 0, JSON.stringify((beaState.patients || []).length));
      r.check("the new clinic cannot see the demo clinic's patients",
        !JSON.stringify(beaState.patients || []).match(/Reyes|Mercado/i), JSON.stringify(beaState.patients));
      r.check("the new clinic's roster holds only its own admin",
        (beaState.users || []).length === 1, JSON.stringify((beaState.users || []).map((u) => u.email)));
      r.check("the new admin is not the platform owner",
        bea.data.isOwner !== true, JSON.stringify(bea.data.isOwner));

      // ...and the new clinic's own admin cannot onboard further clinics.
      const beaTries = await s.call("/api/clinics", {
        method: "POST", token: bea.data.token,
        body: { clinicName: "Another One", ownerName: "X", ownerEmail: "x@y.test", password: "passwordpassword" },
      });
      r.check("the new admin cannot create clinics of their own", beaTries.status === 403, `status ${beaTries.status}`);

      // The operator's list sees both, with counts and no clinical detail.
      const all = await s.call("/api/clinics", { token });
      const names = (all.data.clinics || []).map((c) => c.name);
      r.check("the owner's list includes the new clinic",
        names.includes("Bayanihan PT"), JSON.stringify(names));
      r.check("the list carries counts, not records",
        (all.data.clinics || []).every((c) => typeof c.staff === "number" && typeof c.patients === "number"
          && c.users === undefined && c.documents !== undefined && !("patientNames" in c)),
        JSON.stringify(all.data.clinics));

      /* Validation. Each of these is a way to end up with a clinic nobody can
         enter, or two clinics an operator can't tell apart. */
      const dupEmail = await s.call("/api/clinics", {
        method: "POST", token,
        body: { clinicName: "Another Clinic", ownerName: "Someone", ownerEmail: "bea@bayanihanpt.ph", password: "temporary1234" },
      });
      r.check("an email already in use is refused", dupEmail.status === 400, `status ${dupEmail.status}`);

      const dupName = await s.call("/api/clinics", {
        method: "POST", token,
        body: { clinicName: "bayanihan pt", ownerName: "Someone", ownerEmail: "new@bayanihanpt.ph", password: "temporary1234" },
      });
      r.check("a duplicate clinic name is refused (case-insensitively)", dupName.status === 400, `status ${dupName.status}`);

      const shortPw = await s.call("/api/clinics", {
        method: "POST", token,
        body: { clinicName: "Third Clinic", ownerName: "Someone", ownerEmail: "third@clinic.test", password: "short" },
      });
      r.check("a too-short temporary password is refused", shortPw.status === 400, `status ${shortPw.status}`);

      const noName = await s.call("/api/clinics", {
        method: "POST", token,
        body: { clinicName: "", ownerName: "Someone", ownerEmail: "fourth@clinic.test", password: "passwordpassword" },
      });
      r.check("a blank clinic name is refused", noName.status === 400, `status ${noName.status}`);

      // A rejected create must leave nothing behind.
      const afterFails = await s.call("/api/clinics", { token });
      r.check("no half-made clinic survived the rejected attempts",
        (afterFails.data.clinics || []).length === (all.data.clinics || []).length,
        `${(afterFails.data.clinics || []).length} vs ${(all.data.clinics || []).length}`);
      r.check("no account was created by the rejected attempts",
        (await s.login("third@clinic.test", "short")).status !== 200);
    } finally { s.stop(); }
  }

  /* ---------------------------------------------------------------- *
   *  A sign-in request reaches someone who can act on it
   *
   *  Access requests carried no clinic, and un-stamped records belong to
   *  DEFAULT_CLINIC — the seeded demo clinic. So a real person asking for
   *  access appeared only to whoever signed in with the password published on
   *  the sign-in screen, and never to the operator. They now land in the clinic
   *  an approved Google sign-in would join.
   * ---------------------------------------------------------------- */

  {
    const s = await startServer({
      THERACHART_DEMO_LOGINS: "1",
      GOOGLE_OWNER_EMAIL: OWNER,
      GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CLINIC_ID: "clinic-owner",
      GOOGLE_CLINIC_NAME: "Operator Clinic",
    });
    try {
      const store = require("../store.js");
      store.resetAll();
      const req = store.requestAccess({ email: "hopeful@newclinic.ph", name: "Hopeful PT", source: "google", clinicId: "clinic-owner" });
      r.check("a request records the clinic it was routed to",
        !!req.request && req.request.clinicId === "clinic-owner", JSON.stringify(req.request));

      const demoScoped = store.requestAccess({ email: "other@newclinic.ph", name: "Other PT", source: "google" });
      r.check("without a clinic it falls back rather than throwing",
        !!demoScoped.request && typeof demoScoped.request.clinicId === "string",
        JSON.stringify(demoScoped.request));

      // The demo admin must not be the one seeing real access requests.
      const grace = await s.login("grace@therachart.demo", "1234");
      const seen = await s.call("/api/state", { token: grace.data.token });
      const queue = JSON.stringify(((seen.data || {}).state || {}).accessRequests || []);
      r.check("the demo clinic's queue does not hold the routed request",
        !queue.includes("hopeful@newclinic.ph"), queue.slice(0, 300));
    } finally { s.stop(); }
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
