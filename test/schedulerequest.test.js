/* TheraChart schedule-permission checker — only the admin and the front desk
   change the calendar; everyone else asks.

   Asked for on 2026-10-29: a therapist can open the calendar and see every
   column, but booking, moving and cancelling belong to whoever runs the
   schedule. Hiding the buttons is not enough on its own — a device pushes its
   whole state as JSON — so these checks pin both halves:

     - store.js refuses book/series/cancel from a therapist, and lets them file,
       withdraw and see a request; the admin/front desk can approve (which makes
       the change) or decline
     - the server keeps the saved schedule when a therapist pushes a changed
       one, never lets a push delete or answer someone else's request, and does
       let a therapist add their own pending request

   Run: node test/schedulerequest.test.js */

"use strict";

const { startServer, reporter } = require("./helpers/server.js");

(async () => {
  const r = reporter("schedule-request checker");

  /* ---------------- store rules ---------------- */
  const S = require("../store.js");
  S.load();
  const maria = S.getUser("u-maria"), ana = S.getUser("u-ana"), grace = S.getUser("u-grace");
  const pid = S.patients()[0].id;
  // a working day two weeks out, so nothing seeded is in the way
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const day = new Date(); day.setDate(day.getDate() + 14);
  while (!S.slotsForDay(iso(day)).length) day.setDate(day.getDate() + 1);
  const date = iso(day);
  const slot = S.slotsForDay(date)[2];
  const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

  r.check("a therapist cannot edit the schedule", S.canEditSchedule(maria) === false);
  r.check("the admin and the front desk can", S.canEditSchedule(grace) && S.canEditSchedule(ana));
  r.check("a therapist's booking is refused", !!S.bookAppointment({ patientId: pid, therapistId: "u-maria", start: slot }, maria).error);
  r.check("…and so is a series", !!S.bookSeries({ patientId: pid, therapistId: "u-maria", starts: [slot] }, maria).error);
  const existing = S.appointments().find((a) => a.status === "booked");
  r.check("…and a cancellation", !!S.cancelAppointment(existing.id, maria).error && S.appointments().find((a) => a.id === existing.id).status === "booked");

  const noTime = S.requestScheduleChange({ kind: "book", patientId: pid, date }, maria);
  r.check("a booking request needs a time", !!noTime.error, JSON.stringify(noTime));
  const req = S.requestScheduleChange({ kind: "book", patientId: pid, date, time: hm(slot), note: "earlier slot please" }, maria);
  r.check("a therapist can send a booking request", req.request && req.request.status === "pending", JSON.stringify(req));
  r.check("a therapist cannot answer it", !!S.resolveScheduleRequest(req.request.id, "approved", maria).error);
  const ok = S.resolveScheduleRequest(req.request.id, "approved", ana);
  r.check("the front desk's approval books the visit", ok.appt && ok.appt.start === slot && ok.appt.therapistId === "u-maria", JSON.stringify(ok.error || ok.appt));
  r.check("…and the request records who answered", ok.request.status === "approved" && ok.request.resolvedBy === "u-ana");
  r.check("an answered request can't be answered again", !!S.resolveScheduleRequest(req.request.id, "declined", ana).error);

  const cancelReq = S.requestScheduleChange({ kind: "cancel", apptId: ok.appt.id }, maria);
  const declined = S.resolveScheduleRequest(cancelReq.request.id, "declined", grace, { response: "Keep it, please" });
  r.check("declining leaves the visit booked", declined.request.status === "declined" && S.appointments().find((a) => a.id === ok.appt.id).status === "booked");
  r.check("…and carries the reason back", declined.request.response === "Keep it, please");

  const other = S.requestScheduleChange({ kind: "other", date, note: "Seminar, keep me free from 1 PM" }, maria);
  r.check("the sender can withdraw a pending request", S.withdrawScheduleRequest(other.request.id, maria).request.status === "withdrawn");

  /* ---------------- server rules ---------------- */
  const srv = await startServer({ THERACHART_DEMO_LOGINS: "1" });
  try {
    const mToken = (await srv.demoSignIn("u-maria")).data.token;
    const aToken = (await srv.demoSignIn("u-ana")).data.token;
    const stateOf = async (token) => (await srv.call("/api/state", { token })).data;

    // a therapist's device pushes a cancelled visit and a forged approval
    const cur = await stateOf(mToken);
    const target = cur.state.appointments.find((a) => a.status === "booked");
    const sneaky = JSON.parse(JSON.stringify(cur.state));
    sneaky.appointments.find((a) => a.id === target.id).status = "cancelled";
    sneaky.appointments.push({ ...target, id: "ap-sneaky", start: slot, history: [] });
    const seeded = sneaky.scheduleRequests.find((q) => q.id === "sr-jose");
    seeded.status = "approved"; seeded.resolvedBy = "u-maria";
    sneaky.scheduleRequests.push({ id: "sr-mine", kind: "other", requestedBy: "u-maria", status: "pending", date, note: "Half day Friday", createdAt: new Date().toISOString() });
    sneaky.scheduleRequests.push({ id: "sr-forged", kind: "other", requestedBy: "u-jose", status: "pending", date, note: "not mine to send", createdAt: new Date().toISOString() });
    const put = await srv.call("/api/state", { method: "PUT", token: mToken, body: { baseRev: cur.rev, state: sneaky } });
    r.check("the push itself is accepted (the device must not retry forever)", put.status === 200, `-> ${put.status}`);

    const after = await stateOf(aToken);
    r.check("a therapist's push cannot cancel a visit", after.state.appointments.find((a) => a.id === target.id).status === "booked");
    r.check("…or plant a booking", !after.state.appointments.some((a) => a.id === "ap-sneaky"));
    r.check("…or answer someone's request", after.state.scheduleRequests.find((q) => q.id === "sr-jose").status === "pending");
    r.check("…or file one in a colleague's name", !after.state.scheduleRequests.some((q) => q.id === "sr-forged"));
    r.check("but their own new request goes through", (after.state.scheduleRequests.find((q) => q.id === "sr-mine") || {}).status === "pending");

    // a push that drops every request must not delete them
    const cur2 = await stateOf(mToken);
    const wipe = JSON.parse(JSON.stringify(cur2.state));
    wipe.scheduleRequests = [];
    await srv.call("/api/state", { method: "PUT", token: mToken, body: { baseRev: cur2.rev, state: wipe } });
    r.check("a push cannot delete requests by leaving them out", (await stateOf(aToken)).state.scheduleRequests.length === after.state.scheduleRequests.length);

    // the front desk answers, and its schedule change is kept
    const cur3 = await stateOf(aToken);
    const answer = JSON.parse(JSON.stringify(cur3.state));
    const q = answer.scheduleRequests.find((x) => x.id === "sr-jose");
    q.status = "declined"; q.resolvedBy = "u-ana"; q.response = "Clinic is short-staffed that day";
    answer.appointments.find((a) => a.id === target.id).status = "cancelled";
    await srv.call("/api/state", { method: "PUT", token: aToken, body: { baseRev: cur3.rev, state: answer } });
    const final = await stateOf(mToken);
    r.check("the front desk can answer a request", final.state.scheduleRequests.find((x) => x.id === "sr-jose").status === "declined");
    r.check("…and change the schedule", final.state.appointments.find((a) => a.id === target.id).status === "cancelled");
  } finally {
    srv.stop();
  }

  r.done();
})().catch((e) => { console.error(e); process.exit(1); });
