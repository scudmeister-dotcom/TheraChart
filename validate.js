/* TheraChart intake validation — guardrails on what a front desk can type.
   DOM-free like clinical.js and parser.js, so the same rules run in the
   browser and in the offline checker (node test/validate.test.js).

   Why this file exists: a patient record is the one thing in the chart that
   everything else hangs off. A phone number typed as "0917" or a birth date
   of 2035 doesn't announce itself — it surfaces weeks later when reception
   can't reach the patient about a cancelled slot, or when an age-banded
   outcome measure is scored against a nonsense age. The form is where that
   gets caught, once, by the person who has the patient in front of them.

   Three deliberate positions:

   - PHILIPPINE NUMBERS, NOT US ONES. The mask is not (###) ###-####. A PH
     mobile is 11 digits behind a leading 0 (0917 123 4567); a landline is 10
     ((02) 8123 4567 in Metro Manila, (032) 123 4567 elsewhere). Forcing a
     10-digit US shape would reject every valid mobile in the country. A
     non-PH number can still be entered with an explicit + prefix, because a
     clinic that turns away a returning OFW's foreign mobile has a worse
     problem than a tidy database.

   - ERRORS BLOCK, WARNINGS DON'T. Something impossible (a birth date in the
     future) is an error. Something merely surprising (an authorisation that
     already expired, a patient who looks like a duplicate) is a warning: it
     is shown, and the user can proceed anyway. Front desk staff are right
     more often than the rule is, and a form that refuses a real patient at
     the counter gets worked around — usually by typing junk into the field.

   - VALIDATION CLEANS, TOO. Every check returns a normalised value, so what
     lands in the record is "0917 555 0101" no matter whether it was typed as
     +63 917 555 0101, 09175550101, or 0917-555-0101. Consistent storage is
     what makes the phone searchable later. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraValidate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_AGE_YEARS = 120;
  const LIMITS = {
    name: 60, address: 200, email: 120, referringPhysician: 120,
    allergies: 300, relationship: 40, provider: 80, memberId: 40,
    notes: 300, reference: 60,
  };

  const str = (v) => (v == null ? "" : String(v));
  /* Collapse runs of whitespace so "Juan   Carlos" and "Juan Carlos" are the
     same patient to the duplicate check. */
  const tidy = (v) => str(v).replace(/\s+/g, " ").trim();
  const digits = (v) => str(v).replace(/\D/g, "");

  /* ================================================================== *
   *  PHONE — the Philippine numbering plan
   *
   *  After the trunk prefix 0, a national number is:
   *    mobile    9XX XXX XXXX      (10 digits -> 11 with the 0)
   *    landline  <area><subscriber> (9 digits  -> 10 with the 0)
   *      Metro Manila area code is one digit (2) with an 8-digit subscriber;
   *      everywhere else it is two digits (32 Cebu, 82 Davao…) with 7.
   *
   *  +63 and 63 are both accepted as the country code and rewritten to the
   *  trunk 0, because that is how patients read their own number aloud.
   * ================================================================== */

  const PH_MANILA = "2"; // the one single-digit area code

  /* Reduce anything the user might type to bare national digits.
     Returns { national, intl } — intl is set only for a non-PH + number,
     which we pass through rather than reject. */
  function normalizePhone(raw) {
    const s = tidy(raw);
    if (!s) return { national: "", intl: "" };
    const plus = s.startsWith("+");
    let d = digits(s);
    if (!d) return { national: "", intl: "" };

    if (d.startsWith("63")) d = "0" + d.slice(2);          // +63 917… / 63 917…
    else if (plus) return { national: "", intl: d };        // some other country
    else if (d.startsWith("9") && d.length === 10) d = "0" + d; // 917 555 0101
    return { national: d, intl: "" };
  }

  /* Group the digits the way a Filipino reads them back. Used both for the
     stored value and for live formatting as the user types, which is why it
     must tolerate a half-finished number and simply format what it has. */
  function formatPhone(raw) {
    const { national: d, intl } = normalizePhone(raw);
    if (intl) return "+" + intl;
    if (!d) return "";

    const cut = (a, b) => d.slice(a, b);
    if (d.startsWith("09")) {
      // mobile: 0917 555 0101
      return [cut(0, 4), cut(4, 7), cut(7, 11)].filter(Boolean).join(" ");
    }
    if (d.startsWith("0" + PH_MANILA)) {
      // Metro Manila: (02) 8123 4567
      const sub = d.slice(2);
      const tail = [sub.slice(0, 4), sub.slice(4, 8)].filter(Boolean).join(" ");
      return tail ? `(02) ${tail}` : "(02";
    }
    if (d.startsWith("0")) {
      // provincial: (032) 123 4567
      const area = d.slice(0, 3);
      const sub = d.slice(3);
      const tail = [sub.slice(0, 3), sub.slice(3, 7)].filter(Boolean).join(" ");
      return tail ? `(${area}) ${tail}` : `(${area}`;
    }
    return d;
  }

  /* The live-typing formatter is deliberately gentler than formatPhone: it
     leaves a number alone until enough digits exist to know its shape, so the
     caret doesn't jump around while someone is still on the area code. */
  function formatPhoneAsTyped(raw) {
    const s = tidy(raw);
    if (s.startsWith("+") && !digits(s).startsWith("63")) return s; // foreign: hands off
    const d = normalizePhone(s).national;
    if (d.length < 4) return s;
    return formatPhone(s);
  }

  function checkPhone(raw, opts) {
    const o = opts || {};
    const label = o.label || "Phone number";
    const s = tidy(raw);
    if (!s) {
      return o.required
        ? { ok: false, value: "", error: `${label} is required.` }
        : { ok: true, value: "" };
    }

    const { national: d, intl } = normalizePhone(s);

    if (intl) {
      // Non-PH number, entered deliberately with a +. Sanity-bound it against
      // the ITU maximum rather than pretending to know every country's plan.
      if (intl.length < 8 || intl.length > 15) {
        return { ok: false, value: s, error: `${label}: that international number doesn't look complete.` };
      }
      return { ok: true, value: "+" + intl };
    }

    if (!d) return { ok: false, value: s, error: `${label}: enter a number.` };
    if (/[a-zA-Z]/.test(s.replace(/^\+/, ""))) {
      return { ok: false, value: s, error: `${label} can't contain letters.` };
    }
    if (!d.startsWith("0")) {
      return { ok: false, value: s, error: `${label} should start with 0 (mobile 0917…) or +63.` };
    }

    if (d.startsWith("09")) {
      if (d.length !== 11) {
        return { ok: false, value: s, error: `${label}: a mobile number has 11 digits — 0917 555 0101 (you typed ${d.length}).` };
      }
      return { ok: true, value: formatPhone(d) };
    }
    if (d.length !== 10) {
      return { ok: false, value: s, error: `${label}: a landline has 10 digits — (02) 8123 4567 or (032) 123 4567 (you typed ${d.length}).` };
    }
    return { ok: true, value: formatPhone(d) };
  }

  /* ================================================================== *
   *  NAMES
   *
   *  Filipino names carry ñ, hyphens, apostrophes (D'Souza), periods (Jr.)
   *  and Spanish particles (de la Cruz). The check is therefore about what a
   *  name can NOT contain — digits and symbols — rather than an allow-list
   *  that would reject a real patient at the counter.
   * ================================================================== */

  const NAME_BANNED = /[0-9@#$%^*_=+<>{}[\]\\/|~`"]/;

  function checkName(raw, opts) {
    const o = opts || {};
    const label = o.label || "Name";
    const s = tidy(raw);
    if (!s) {
      return o.required
        ? { ok: false, value: "", error: `${label} is required.` }
        : { ok: true, value: "" };
    }
    if (s.length > LIMITS.name) {
      return { ok: false, value: s, error: `${label} is too long (max ${LIMITS.name} characters).` };
    }
    if (NAME_BANNED.test(s)) {
      return { ok: false, value: s, error: `${label} can't contain numbers or symbols.` };
    }
    if (!/[\p{L}]/u.test(s)) {
      return { ok: false, value: s, error: `${label} needs at least one letter.` };
    }
    return { ok: true, value: s };
  }

  /* ================================================================== *
   *  DATES
   * ================================================================== */

  const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(str(s));

  /* Parse as a plain calendar date. Date.parse on "2026-02-30" happily rolls
     into March, so the round-trip comparison is what actually rejects it. */
  function parseDate(s) {
    if (!isIsoDate(s)) return null;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt;
  }

  const todayIso = (today) => str(today) || new Date().toISOString().slice(0, 10);

  function ageOn(dob, today) {
    const b = parseDate(dob);
    const t = parseDate(todayIso(today));
    if (!b || !t) return null;
    let age = t.getUTCFullYear() - b.getUTCFullYear();
    const beforeBirthday =
      t.getUTCMonth() < b.getUTCMonth() ||
      (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age;
  }

  function checkDob(raw, opts) {
    const o = opts || {};
    const s = tidy(raw);
    if (!s) {
      return o.required
        ? { ok: false, value: "", error: "Date of birth is required." }
        : { ok: true, value: "" };
    }
    if (!parseDate(s)) return { ok: false, value: s, error: "Date of birth isn't a real date." };

    const age = ageOn(s, o.today);
    if (age < 0) return { ok: false, value: s, error: "Date of birth can't be in the future." };
    if (age > MAX_AGE_YEARS) {
      return { ok: false, value: s, error: `Date of birth would make the patient ${age} years old — check the year.` };
    }
    const out = { ok: true, value: s, age };
    // A newborn is plausible in a clinic; a patient born today is more often
    // this year's date left in the picker by accident. Say so, don't block.
    if (age === 0) out.warning = "That birth date makes the patient under 1 year old — is the year right?";
    return out;
  }

  function checkFutureDate(raw, opts) {
    const o = opts || {};
    const label = o.label || "Date";
    const s = tidy(raw);
    if (!s) {
      return o.required ? { ok: false, value: "", error: `${label} is required.` } : { ok: true, value: "" };
    }
    if (!parseDate(s)) return { ok: false, value: s, error: `${label} isn't a real date.` };
    const out = { ok: true, value: s };
    if (s < todayIso(o.today)) out.warning = `${label} is already in the past.`;
    return out;
  }

  /* ================================================================== *
   *  EMAIL
   *
   *  Intentionally shallow. The only email check that proves anything is
   *  sending a message to it; a stricter regex mostly rejects valid addresses.
   *  This catches the typo class that matters — no @, no dot, stray spaces.
   * ================================================================== */

  function checkEmail(raw, opts) {
    const o = opts || {};
    const s = tidy(raw);
    if (!s) {
      return o.required ? { ok: false, value: "", error: "Email is required." } : { ok: true, value: "" };
    }
    if (s.length > LIMITS.email) return { ok: false, value: s, error: `Email is too long (max ${LIMITS.email} characters).` };
    if (/\s/.test(s)) return { ok: false, value: s, error: "Email can't contain spaces." };
    if (!/^[^@]+@[^@]+\.[^@.]{2,}$/.test(s)) {
      return { ok: false, value: s, error: "Email doesn't look right — it should read name@example.com." };
    }
    return { ok: true, value: s.toLowerCase() };
  }

  /* ================================================================== *
   *  FREE TEXT + NUMBERS
   * ================================================================== */

  function checkText(raw, opts) {
    const o = opts || {};
    const label = o.label || "This field";
    const max = o.max || LIMITS.notes;
    const s = tidy(raw);
    if (!s) {
      return o.required ? { ok: false, value: "", error: `${label} is required.` } : { ok: true, value: "" };
    }
    if (s.length > max) return { ok: false, value: s, error: `${label} is too long (max ${max} characters).` };
    return { ok: true, value: s };
  }

  function checkCount(raw, opts) {
    const o = opts || {};
    const label = o.label || "Value";
    const max = o.max == null ? 999 : o.max;
    const s = tidy(raw);
    if (!s) return { ok: true, value: 0 };
    if (!/^\d+$/.test(s)) return { ok: false, value: s, error: `${label} must be a whole number.` };
    const n = Number(s);
    if (n > max) return { ok: false, value: s, error: `${label} can't be more than ${max}.` };
    return { ok: true, value: n };
  }

  /* PhilHealth identification numbers are 12 digits, printed ##-#########-#.
     Wrong length is worth flagging — but as a warning, because a patient who
     has mislaid their card should still get registered and treated today. */
  function checkPhilHealthId(raw, provider) {
    const s = tidy(raw);
    if (!s) return { ok: true, value: "" };
    if (s.length > LIMITS.memberId) {
      return { ok: false, value: s, error: `Member / policy ID is too long (max ${LIMITS.memberId} characters).` };
    }
    const looksPhilHealth = /philhealth/i.test(str(provider));
    const d = digits(s);
    if (looksPhilHealth && d.length !== 12) {
      return {
        ok: true, value: s,
        warning: `A PhilHealth number has 12 digits (##-#########-#) — this one has ${d.length}.`,
      };
    }
    if (looksPhilHealth && d.length === 12) {
      return { ok: true, value: `${d.slice(0, 2)}-${d.slice(2, 11)}-${d.slice(11)}` };
    }
    return { ok: true, value: s };
  }

  /* ================================================================== *
   *  DUPLICATE PATIENTS
   *
   *  Same name and same birth date is the standard match. It is a warning,
   *  never a block: twins share a surname and a birthday, and a clinic
   *  sometimes has a genuine reason for a second record.
   * ================================================================== */

  const dupKey = (p) =>
    `${tidy(p.lastName).toLowerCase()}|${tidy(p.firstName).toLowerCase()}|${tidy(p.dob)}`;

  function findDuplicate(fields, existing, selfId) {
    const key = dupKey(fields);
    if (key === "||") return null;
    return (existing || []).find((p) => p && p.id !== selfId && dupKey(p) === key) || null;
  }

  /* ================================================================== *
   *  THE WHOLE PATIENT
   *
   *  Returns { ok, errors, warnings, cleaned, duplicate }. errors and
   *  warnings are keyed by field name so a form can put each message under
   *  the input it belongs to instead of one line at the bottom.
   * ================================================================== */

  function validatePatient(fields, opts) {
    const f = fields || {};
    const o = opts || {};
    const ec = f.emergencyContact || {};
    const ins = f.insurance || {};
    const au = f.authorization || {};

    const errors = {};
    const warnings = {};
    const take = (key, res) => {
      if (!res.ok) errors[key] = res.error;
      else if (res.warning) warnings[key] = res.warning;
      return res.value;
    };

    const cleaned = {
      firstName: take("firstName", checkName(f.firstName, { label: "First name", required: true })),
      lastName: take("lastName", checkName(f.lastName, { label: "Last name", required: true })),
      dob: take("dob", checkDob(f.dob, { required: true, today: o.today })),
      sex: ["F", "M"].indexOf(tidy(f.sex)) >= 0 ? tidy(f.sex) : "",
      address: take("address", checkText(f.address, { label: "Address", max: LIMITS.address })),
      phone: take("phone", checkPhone(f.phone, { label: "Phone number", required: true })),
      email: take("email", checkEmail(f.email)),
      referringPhysician: take("referringPhysician",
        checkName(f.referringPhysician, { label: "Referring physician" })),
      allergies: take("allergies", checkText(f.allergies, { label: "Allergies", max: LIMITS.allergies })),
      emergencyContact: {
        name: take("ecName", checkName(ec.name, { label: "Emergency contact" })),
        relationship: take("ecRelationship",
          checkText(ec.relationship, { label: "Relationship", max: LIMITS.relationship })),
        phone: take("ecPhone", checkPhone(ec.phone, { label: "Emergency contact phone" })),
      },
      insurance: {
        provider: take("provider", checkText(ins.provider, { label: "Provider", max: LIMITS.provider })),
        memberId: take("memberId", checkPhilHealthId(ins.memberId, ins.provider)),
        notes: take("paymentNotes", checkText(ins.notes, { label: "Payment notes", max: LIMITS.notes })),
      },
      authorization: {
        visitsAuthorized: take("visitsAuthorized",
          checkCount(au.visitsAuthorized, { label: "Visits authorised", max: 999 })),
        expiresOn: take("authExpires",
          checkFutureDate(au.expiresOn, { label: "Authorisation expiry", today: o.today })),
        reference: take("authReference",
          checkText(au.reference, { label: "Authorisation reference", max: LIMITS.reference })),
      },
    };

    /* A contact with a name and no number can't be contacted, which is the
       whole point of the field. Half-filled is worse than empty. */
    const ecFilled = !!(cleaned.emergencyContact.name || cleaned.emergencyContact.phone ||
                        cleaned.emergencyContact.relationship);
    if (ecFilled && !cleaned.emergencyContact.name && !errors.ecName) {
      errors.ecName = "Add the contact's name, or clear the emergency contact fields.";
    }
    if (ecFilled && !cleaned.emergencyContact.phone && !errors.ecPhone) {
      errors.ecPhone = "An emergency contact needs a phone number.";
    }
    /* The same number for patient and next of kin is usually the patient's own
       number typed twice — no use in an emergency, but occasionally correct
       for a spouse on a shared line. */
    if (cleaned.emergencyContact.phone && cleaned.emergencyContact.phone === cleaned.phone && !errors.ecPhone) {
      warnings.ecPhone = "That's the same number as the patient's own.";
    }

    if (cleaned.authorization.visitsAuthorized > 0 && !cleaned.authorization.expiresOn && !errors.authExpires) {
      warnings.authExpires = "Authorised visits are recorded with no expiry date.";
    }

    const duplicate = findDuplicate(cleaned, o.existingPatients, o.patientId);
    if (duplicate) {
      warnings.lastName =
        `${tidy(duplicate.lastName)}, ${tidy(duplicate.firstName)} is already registered with the same birth date.`;
    }

    return {
      ok: Object.keys(errors).length === 0,
      errors,
      warnings,
      cleaned,
      duplicate,
      /* Field order for "focus the first thing that's wrong" — the order they
         appear on the intake form, not the order the checks happened to run. */
      firstError: FIELD_ORDER.find((k) => errors[k]) || null,
    };
  }

  const FIELD_ORDER = [
    "firstName", "lastName", "dob", "address", "phone", "email", "referringPhysician",
    "allergies", "ecName", "ecRelationship", "ecPhone",
    "provider", "memberId", "paymentNotes", "visitsAuthorized", "authExpires", "authReference",
  ];

  return {
    // phone
    normalizePhone, formatPhone, formatPhoneAsTyped, checkPhone,
    // individual fields
    checkName, checkDob, checkEmail, checkText, checkCount, checkFutureDate, checkPhilHealthId,
    // dates
    parseDate, ageOn,
    // whole record
    validatePatient, findDuplicate, dupKey,
    // exposed for tests and for callers that want the same ceilings
    LIMITS, MAX_AGE_YEARS, FIELD_ORDER,
  };
});
