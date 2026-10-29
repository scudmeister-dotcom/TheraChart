/* TheraChart account-preferences checker — a person's display preferences
   (how they sort, order and pin their work queue) live on their account.

   Asked for on 2026-10-29: the queue's sort should persist per account, across
   the app closing and reopening and across devices. So it is saved on the user
   record (store.setMyPrefs) and synced like any other field. That makes it a
   field a device pushes, so these checks pin who may change it:

     - your own push saves your preferences, and they come back on sign-in
     - a colleague's push cannot change yours, even an admin's

   Run: node test/prefs.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const r = reporter("account-preferences checker");

  const S = require("../store.js");
  S.load();
  const maria = S.getUser("u-maria");
  S.setMyPrefs(maria, "queue", { sort: { drafts: "name" } });
  r.check("setMyPrefs saves on the account", S.myPrefs(maria).queue.sort.drafts === "name");
  S.setMyPrefs(maria, "queue", null);
  r.check("…and null removes it", !("queue" in S.myPrefs(maria)));

  const srv = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  try {
    const mToken = (await srv.demoSignIn("u-maria")).data.token;
    const gToken = (await srv.demoSignIn("u-grace")).data.token;
    const stateOf = async (token) => (await srv.call("/api/state", { token })).data;
    const prefsOf = (st, id) => (st.state.users.find((u) => u.id === id) || {}).prefs;

    const cur = await stateOf(mToken);
    const mine = JSON.parse(JSON.stringify(cur.state));
    mine.users.find((u) => u.id === "u-maria").prefs = { queue: { sort: { drafts: "type" }, pinned: { drafts: ["d-eval-liza"] } } };
    const put = await srv.call("/api/state", { method: "PUT", token: mToken, body: { baseRev: cur.rev, state: mine } });
    r.check("a person's own push is accepted", put.status === 200, `-> ${put.status}`);
    const back = prefsOf(await stateOf(mToken), "u-maria");
    r.check("…and their preferences come back on the next read", back && back.queue.sort.drafts === "type" && back.queue.pinned.drafts[0] === "d-eval-liza", JSON.stringify(back));

    const cur2 = await stateOf(gToken);
    const meddle = JSON.parse(JSON.stringify(cur2.state));
    meddle.users.find((u) => u.id === "u-maria").prefs = { queue: { sort: { drafts: "name" } } };
    await srv.call("/api/state", { method: "PUT", token: gToken, body: { baseRev: cur2.rev, state: meddle } });
    const after = prefsOf(await stateOf(mToken), "u-maria");
    r.check("an admin's push cannot change someone else's preferences", after && after.queue.sort.drafts === "type", JSON.stringify(after));
  } finally {
    srv.stop();
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
