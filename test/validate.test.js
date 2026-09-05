/* TheraChart intake-validation checker — phone shapes from the Philippine
   numbering plan, date bounds, names with ñ and apostrophes, and the
   error-vs-warning split that decides whether a save is blocked.
   Run: node test/validate.test.js */

"use strict";
const V = require("../validate.js");

let passed = 0;
const failures = [];
const check = (n, c, d) => { if (c) passed += 1; else failures.push(`✗ ${n}${d ? `\n    ${d}` : ""}`); };

/* A fixed "today" so age bounds don't drift with the calendar. */
const TODAY = "2026-08-16";

/* ---------------------------------------------------------------- *
 *  Phone — mobile
 * ---------------------------------------------------------------- */

{
  const forms = [
    "09175550101", "0917 555 0101", "0917-555-0101", "+63 917 555 0101",
    "+639175550101", "63 917 555 0101", "9175550101", "(0917) 555-0101",
  ];
  const all = forms.map((f) => V.checkPhone(f));
  check("every way of writing one mobile number is accepted",
    all.every((r) => r.ok), JSON.stringify(all.filter((r) => !r.ok)));
  check("…and they all normalise to the same stored value",
    all.every((r) => r.value === "0917 555 0101"),
    JSON.stringify(all.map((r) => r.value)));
}

check("a mobile one digit short is rejected", !V.checkPhone("0917 555 010").ok);
check("…and the message says how many digits were typed",
  /10/.test(V.checkPhone("0917 555 010").error || ""), V.checkPhone("0917 555 010").error);
check("a mobile one digit long is rejected", !V.checkPhone("091755501012").ok);
check("bare junk is rejected", !V.checkPhone("12345").ok);
check("a single digit is rejected", !V.checkPhone("9").ok);
check("letters in a phone number are rejected", !V.checkPhone("0917 CALL ME").ok);
check("a number not starting 0 or +63 is rejected", !V.checkPhone("12345678901").ok);
check("…and it says what a number should start with",
  /0917|\+63/.test(V.checkPhone("12345678901").error || ""));

/* ---------------------------------------------------------------- *
 *  Phone — landlines
 * ---------------------------------------------------------------- */

{
  const manila = V.checkPhone("0281234567");
  check("a Metro Manila landline is accepted", manila.ok, manila.error);
  check("…and formats as (02) 8123 4567", manila.value === "(02) 8123 4567", manila.value);

  const cebu = V.checkPhone("0321234567");
  check("a provincial landline is accepted", cebu.ok, cebu.error);
  check("…and formats as (032) 123 4567", cebu.value === "(032) 123 4567", cebu.value);

  check("a 9-digit landline is rejected", !V.checkPhone("032123456").ok);
  check("…and the message gives the landline shape",
    /\(02\)|\(032\)/.test(V.checkPhone("032123456").error || ""));
}

/* ---------------------------------------------------------------- *
 *  Phone — foreign numbers and optionality
 * ---------------------------------------------------------------- */

{
  const us = V.checkPhone("+1 415 555 0134");
  check("an explicit international number is allowed through", us.ok, us.error);
  check("…and is stored in bare + form", us.value === "+14155550134", us.value);
  check("a too-short international number is rejected", !V.checkPhone("+1 415").ok);
  check("a too-long international number is rejected", !V.checkPhone("+1234567890123456").ok);
}

check("a blank optional phone is fine", V.checkPhone("").ok);
check("a blank required phone is an error", !V.checkPhone("", { required: true }).ok);
check("…and the message names the field",
  /Emergency contact phone/.test(V.checkPhone("", { required: true, label: "Emergency contact phone" }).error || ""));

/* ---------------------------------------------------------------- *
 *  Phone — live formatting as the user types
 * ---------------------------------------------------------------- */

check("typing is left alone until the shape is known",
  V.formatPhoneAsTyped("091") === "091", V.formatPhoneAsTyped("091"));
check("a part-typed mobile picks up its first space",
  V.formatPhoneAsTyped("09175") === "0917 5", V.formatPhoneAsTyped("09175"));
check("a full mobile is grouped 4-3-4",
  V.formatPhoneAsTyped("09175550101") === "0917 555 0101", V.formatPhoneAsTyped("09175550101"));
check("a part-typed provincial landline keeps its bracket",
  V.formatPhoneAsTyped("032123") === "(032) 123", V.formatPhoneAsTyped("032123"));
check("a foreign number is not reshaped while typing",
  V.formatPhoneAsTyped("+1 415 555") === "+1 415 555", V.formatPhoneAsTyped("+1 415 555"));
check("formatting an empty box yields an empty box", V.formatPhoneAsTyped("") === "");

/* ---------------------------------------------------------------- *
 *  Names
 * ---------------------------------------------------------------- */

{
  const good = ["Peña", "de la Cruz", "D'Souza", "Mary-Jane", "Reyes Jr.", "Ñoño", "José Luis"];
  const results = good.map((n) => V.checkName(n, { required: true }));
  check("Filipino and Spanish name forms are accepted",
    results.every((r) => r.ok), JSON.stringify(good.filter((n, i) => !results[i].ok)));
}

check("a name with digits is rejected", !V.checkName("Juan2", { required: true }).ok);
check("a name of pure symbols is rejected", !V.checkName("###", { required: true }).ok);
check("a blank required name is rejected", !V.checkName("  ", { required: true }).ok);
check("a blank optional name is fine", V.checkName("").ok);
check("an over-long name is rejected", !V.checkName("x".repeat(200), { required: true }).ok);
check("inner whitespace is collapsed",
  V.checkName("Juan   Carlos").value === "Juan Carlos", V.checkName("Juan   Carlos").value);
check("surrounding whitespace is trimmed",
  V.checkName("  Reyes  ").value === "Reyes");

/* ---------------------------------------------------------------- *
 *  Dates of birth
 * ---------------------------------------------------------------- */

check("a normal birth date is accepted", V.checkDob("1984-03-11", { required: true, today: TODAY }).ok);
check("…and the age is computed", V.checkDob("1984-03-11", { today: TODAY }).age === 42,
  String(V.checkDob("1984-03-11", { today: TODAY }).age));
check("a birthday later this year has not happened yet",
  V.ageOn("1984-12-25", TODAY) === 41, String(V.ageOn("1984-12-25", TODAY)));
check("a birthday today counts", V.ageOn("1984-08-16", TODAY) === 42, String(V.ageOn("1984-08-16", TODAY)));
check("a future birth date is rejected", !V.checkDob("2035-01-01", { today: TODAY }).ok);
check("tomorrow is still the future", !V.checkDob("2026-08-17", { today: TODAY }).ok);
check("a 121-year-old is rejected", !V.checkDob("1900-01-01", { today: TODAY }).ok);
check("…but a 99-year-old is fine", V.checkDob("1927-01-01", { today: TODAY }).ok);
check("29 February in a non-leap year is rejected", !V.checkDob("2023-02-29", { today: TODAY }).ok);
check("…but a real leap day is accepted", V.checkDob("2024-02-29", { today: TODAY }).ok);
check("31 April is rejected", !V.checkDob("2020-04-31", { today: TODAY }).ok);
check("a blank required birth date is rejected", !V.checkDob("", { required: true }).ok);
check("an infant's birth date saves with a warning",
  V.checkDob("2026-06-01", { today: TODAY }).ok && !!V.checkDob("2026-06-01", { today: TODAY }).warning);

/* ---------------------------------------------------------------- *
 *  Email
 * ---------------------------------------------------------------- */

check("a normal address is accepted", V.checkEmail("juan.reyes@example.com").ok);
check("…and is lower-cased", V.checkEmail("Juan@Example.COM").value === "juan@example.com");
check("an address with no @ is rejected", !V.checkEmail("juan.example.com").ok);
check("an address with no dot in the domain is rejected", !V.checkEmail("juan@example").ok);
check("an address with a space is rejected", !V.checkEmail("juan reyes@example.com").ok);
check("two @ signs are rejected", !V.checkEmail("a@b@example.com").ok);
check("a blank optional email is fine", V.checkEmail("").ok);

/* ---------------------------------------------------------------- *
 *  Counts and future dates
 * ---------------------------------------------------------------- */

check("a whole number of visits is accepted", V.checkCount("12").ok && V.checkCount("12").value === 12);
check("a blank count means zero", V.checkCount("").value === 0);
check("a decimal number of visits is rejected", !V.checkCount("12.5").ok);
check("a negative number of visits is rejected", !V.checkCount("-3").ok);
check("an absurd number of visits is rejected", !V.checkCount("100000").ok);
check("text in a number field is rejected", !V.checkCount("twelve").ok);

check("a future expiry is clean",
  V.checkFutureDate("2026-12-31", { today: TODAY }).ok && !V.checkFutureDate("2026-12-31", { today: TODAY }).warning);
check("a past expiry saves with a warning",
  V.checkFutureDate("2025-01-01", { today: TODAY }).ok && !!V.checkFutureDate("2025-01-01", { today: TODAY }).warning);
check("a nonsense expiry date is rejected", !V.checkFutureDate("2026-13-01", { today: TODAY }).ok);

/* ---------------------------------------------------------------- *
 *  PhilHealth identification numbers
 * ---------------------------------------------------------------- */

check("a 12-digit PhilHealth number is reformatted",
  V.checkPhilHealthId("123456789012", "PhilHealth").value === "12-345678901-2",
  V.checkPhilHealthId("123456789012", "PhilHealth").value);
check("a short PhilHealth number warns but saves",
  V.checkPhilHealthId("12345", "PhilHealth").ok && !!V.checkPhilHealthId("12345", "PhilHealth").warning);
check("a member ID for another provider is left alone",
  V.checkPhilHealthId("MX-88-2211", "Maxicare").value === "MX-88-2211");
check("a blank member ID is fine", V.checkPhilHealthId("", "PhilHealth").ok);

/* ---------------------------------------------------------------- *
 *  The whole patient record
 * ---------------------------------------------------------------- */

const goodPatient = {
  firstName: "Juan", lastName: "Reyes", dob: "1984-03-11", sex: "M",
  address: "12 Mabini St, Quezon City", phone: "+63 917 555 0101",
  email: "juan.reyes@example.com", referringPhysician: "Dr. Santos",
  allergies: "", emergencyContact: { name: "Marites Reyes", relationship: "Spouse", phone: "0917 555 0111" },
  insurance: { provider: "PhilHealth", memberId: "123456789012", notes: "" },
  authorization: { visitsAuthorized: "12", expiresOn: "2026-12-31", reference: "AUTH-9" },
};

{
  const r = V.validatePatient(goodPatient, { today: TODAY });
  check("a well-filled record passes", r.ok, JSON.stringify(r.errors));
  check("…with no warnings", Object.keys(r.warnings).length === 0, JSON.stringify(r.warnings));
  check("…and the phone is stored normalised", r.cleaned.phone === "0917 555 0101", r.cleaned.phone);
  check("…and the PhilHealth number is stored formatted",
    r.cleaned.insurance.memberId === "12-345678901-2", r.cleaned.insurance.memberId);
  check("…and visits authorised became a number",
    r.cleaned.authorization.visitsAuthorized === 12);
  check("…and firstError is null when nothing is wrong", r.firstError === null);
}

{
  const r = V.validatePatient({ ...goodPatient, phone: "1234" }, { today: TODAY });
  check("a bad phone blocks the save", !r.ok);
  check("…and the error is keyed to the phone field", !!r.errors.phone, JSON.stringify(r.errors));
  check("…and firstError points at it", r.firstError === "phone", String(r.firstError));
}

{
  const r = V.validatePatient({}, { today: TODAY });
  check("an empty record reports all four required fields",
    !!r.errors.firstName && !!r.errors.lastName && !!r.errors.dob && !!r.errors.phone,
    JSON.stringify(Object.keys(r.errors)));
  check("…and firstError is the topmost field on the form", r.firstError === "firstName", String(r.firstError));
  check("…and optional sections raise nothing",
    !r.errors.email && !r.errors.ecName && !r.errors.provider, JSON.stringify(r.errors));
}

{
  const r = V.validatePatient(
    { ...goodPatient, emergencyContact: { name: "Marites Reyes", relationship: "", phone: "" } },
    { today: TODAY });
  check("an emergency contact with no number is blocked", !r.ok && !!r.errors.ecPhone);
}

{
  const r = V.validatePatient(
    { ...goodPatient, emergencyContact: { name: "", relationship: "Spouse", phone: "0917 555 0111" } },
    { today: TODAY });
  check("an emergency contact with no name is blocked", !r.ok && !!r.errors.ecName);
}

{
  const r = V.validatePatient(
    { ...goodPatient, emergencyContact: { name: "", relationship: "", phone: "" } },
    { today: TODAY });
  check("a wholly empty emergency contact is allowed", r.ok, JSON.stringify(r.errors));
}

{
  const r = V.validatePatient(
    { ...goodPatient, emergencyContact: { name: "Marites Reyes", relationship: "Spouse", phone: "+63 917 555 0101" } },
    { today: TODAY });
  check("next-of-kin sharing the patient's number warns but saves",
    r.ok && !!r.warnings.ecPhone, JSON.stringify(r.warnings));
}

{
  const r = V.validatePatient(
    { ...goodPatient, authorization: { visitsAuthorized: "12", expiresOn: "", reference: "" } },
    { today: TODAY });
  check("authorised visits with no expiry warns but saves", r.ok && !!r.warnings.authExpires);
}

{
  const r = V.validatePatient({ ...goodPatient, sex: "Male" }, { today: TODAY });
  check("an out-of-list sex value is dropped rather than stored", r.ok && r.cleaned.sex === "");
}

/* ---------------------------------------------------------------- *
 *  Duplicate detection
 * ---------------------------------------------------------------- */

const roster = [
  { id: "p1", firstName: "Juan", lastName: "Reyes", dob: "1984-03-11" },
  { id: "p2", firstName: "Liza", lastName: "Mercado", dob: "1990-07-02" },
];

{
  const r = V.validatePatient(goodPatient, { today: TODAY, existingPatients: roster });
  check("a same-name same-birthday patient is flagged", !!r.duplicate && r.duplicate.id === "p1");
  check("…as a warning, not a block", r.ok && !!r.warnings.lastName, JSON.stringify(r.warnings));
}

{
  const r = V.validatePatient({ ...goodPatient, dob: "1985-03-11" },
    { today: TODAY, existingPatients: roster });
  check("the same name with a different birthday is not a duplicate", !r.duplicate);
}

{
  const r = V.validatePatient(goodPatient, { today: TODAY, existingPatients: roster, patientId: "p1" });
  check("editing a patient doesn't flag them as their own duplicate", !r.duplicate);
}

{
  const r = V.validatePatient({ ...goodPatient, firstName: "  juan  ", lastName: "REYES" },
    { today: TODAY, existingPatients: roster });
  check("duplicate matching ignores case and padding", !!r.duplicate, JSON.stringify(r.cleaned));
}

/* ---------------------------------------------------------------- *
 *  The seeded demo patients must survive their own rules
 *
 *  Read from store.js rather than copied here, so this can't quietly pass
 *  against a fixture that has drifted from the seed the demo actually opens
 *  with. A rule that rejects the demo data is a rule that breaks the demo.
 * ---------------------------------------------------------------- */

{
  const store = require("../store.js");
  store.resetAll();
  const seeded = store.allPatients();

  check("the seed still contains patients to check", seeded.length > 0, `found ${seeded.length}`);

  const results = seeded.map((p) => V.validatePatient(p, { today: TODAY }));
  const broken = seeded
    .map((p, i) => ({ name: `${p.lastName}, ${p.firstName}`, errors: results[i].errors }))
    .filter((x) => Object.keys(x.errors).length);
  check("every seeded demo patient passes the new rules",
    broken.length === 0, JSON.stringify(broken));

  /* The seed writes phones as "+63 917 555 0101"; the form now stores
     "0917 555 0101". Both are valid, and this is what proves the older shape
     keeps working rather than blocking an edit to an existing chart. */
  check("seeded phones are accepted in their stored +63 form",
    seeded.every((p) => !p.phone || V.checkPhone(p.phone).ok),
    JSON.stringify(seeded.map((p) => p.phone).filter((ph) => ph && !V.checkPhone(ph).ok)));

  /* Two seeded patients sharing a name and birth date would make the demo
     open with a duplicate warning on an untouched record. */
  const dupes = seeded.filter((p) => V.findDuplicate(p, seeded, p.id));
  check("no two seeded patients look like duplicates of each other",
    dupes.length === 0, JSON.stringify(dupes.map((p) => `${p.lastName}, ${p.firstName}`)));

  /* …and the self-exclusion that makes that check meaningful: without a
     patient id, every record in the list matches itself. */
  check("a patient in the list matches itself when no id is excluded",
    seeded.every((p) => !!V.findDuplicate(p, seeded, null)));
}

/* ---------------------------------------------------------------- *
 *  Nothing may throw on hostile input
 * ---------------------------------------------------------------- */

{
  let threw = null;
  const nasties = [null, undefined, 0, false, [], {}, "<script>alert(1)</script>", " "];
  try {
    nasties.forEach((n) => {
      V.checkPhone(n); V.checkName(n); V.checkDob(n); V.checkEmail(n);
      V.checkCount(n); V.checkText(n); V.checkFutureDate(n); V.checkPhilHealthId(n, n);
      V.formatPhoneAsTyped(n); V.validatePatient(n, { today: TODAY });
      V.validatePatient({ firstName: n, lastName: n, dob: n, phone: n, emergencyContact: n,
                          insurance: n, authorization: n }, { today: TODAY });
    });
  } catch (e) { threw = e; }
  check("no checker throws on null, junk or hostile input", !threw, threw && threw.stack);
}

/* ---------------------------------------------------------------- *
 *  Precautions, and the insurer's two paperwork fields
 *
 *  Precautions were called "allergies" until the field started carrying
 *  weight-bearing status and fall risk too. Records written before the
 *  rename must still validate, and must come out under the new name.
 * ---------------------------------------------------------------- */

const patient = (over) => V.validatePatient(
  Object.assign({ firstName: "Ana", lastName: "Bautista", dob: "1990-03-04", phone: "0917 555 0101" }, over),
  { today: TODAY, existingPatients: [] });

{
  const r = patient({ precautions: "Fall risk. Weight-bearing as tolerated." });
  check("precautions are kept as written", r.cleaned.precautions === "Fall risk. Weight-bearing as tolerated.");
  check("a record with only precautions saves", r.ok, JSON.stringify(r.errors));

  const legacy = patient({ allergies: "Penicillin — rash." });
  check("a pre-rename record still validates", legacy.ok);
  check("…and comes back under the new name", legacy.cleaned.precautions === "Penicillin — rash.");
  check("…and is never written back under the old one", legacy.cleaned.allergies === undefined);

  const both = patient({ precautions: "new", allergies: "old" });
  check("where both keys exist the new one wins", both.cleaned.precautions === "new");

  check("precautions hold a whole post-op protocol",
    patient({ precautions: "x".repeat(600) }).ok && !patient({ precautions: "x".repeat(601) }).ok);
  check("an over-long precaution says so, rather than truncating",
    /too long/i.test(patient({ precautions: "x".repeat(601) }).errors.precautions || ""),
    patient({ precautions: "x".repeat(601) }).errors.precautions);
  check("precautions are optional", patient({}).ok && patient({}).cleaned.precautions === "");
}

{
  const gl = patient({ authorization: { guaranteeLetter: "LOA-2026-0041", submittedOn: "2026-08-01" } });
  check("a guarantee letter and its submission date save together", gl.ok, JSON.stringify(gl.errors));
  check("the guarantee letter number is kept", gl.cleaned.authorization.guaranteeLetter === "LOA-2026-0041");
  check("the submission date is kept", gl.cleaned.authorization.submittedOn === "2026-08-01");

  const future = patient({ authorization: { submittedOn: "2026-12-25" } });
  check("documents cannot have been submitted in the future", !future.ok);
  check("…and it blocks rather than warns", /future/i.test(future.errors.authSubmitted || ""), future.errors.authSubmitted);

  const lonely = patient({ authorization: { guaranteeLetter: "LOA-1" } });
  check("a guarantee letter with no submission date warns", !!lonely.warnings.authSubmitted, JSON.stringify(lonely.warnings));
  check("…but does not block the save", lonely.ok);

  check("a submission date alone is fine", patient({ authorization: { submittedOn: "2026-08-01" } }).ok);
  check("neither field is required", patient({ authorization: {} }).ok);
  check("a junk submission date is refused",
    !patient({ authorization: { submittedOn: "2026-02-31" } }).ok);
  check("an over-long guarantee letter is refused",
    !patient({ authorization: { guaranteeLetter: "L".repeat(61) } }).ok);
}

{
  // checkPastDate on its own, since it is exported for reuse
  check("a past date passes", V.checkPastDate("2026-01-01", { today: TODAY }).ok);
  check("today passes", V.checkPastDate(TODAY, { today: TODAY }).ok);
  check("tomorrow fails", !V.checkPastDate("2026-08-17", { today: TODAY }).ok);
  check("blank passes unless required",
    V.checkPastDate("", { today: TODAY }).ok && !V.checkPastDate("", { today: TODAY, required: true }).ok);
  check("junk fails", !V.checkPastDate("not a date", { today: TODAY }).ok);
}

/* ---------------------------------------------------------------- */

if (failures.length) {
  console.error(`\nTheraChart validation checker: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error(f));
  process.exit(1);
}
console.log(`TheraChart validation checker: ${passed}/${passed} checks passed`);
