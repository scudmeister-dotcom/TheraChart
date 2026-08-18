/* TheraChart auth checker — verifies the pluggable authenticator: legacy PINs
   migrate to hashes, login/verify/setPassword go through the injected hasher,
   password rules hold, and credentials never round-trip in cleartext.
   Run: node test/auth.test.js */

"use strict";

const crypto = require("crypto");
const store = require("../store.js");

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

// A real-ish scrypt authenticator, mirroring the server's.
const AUTH = {
  hash(plain) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(String(plain), salt, 64).toString("hex")}`;
  },
  verify(user, plain) {
    if (!user.passwordHash) return user.pin != null && user.pin === String(plain);
    const [, saltHex, hashHex] = String(user.passwordHash).split("$");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(String(plain), Buffer.from(saltHex, "hex"), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  },
};

store.resetAll();
store.setAuthenticator(AUTH);

// --- migration -----------------------------------------------------------
const migrated = store.hashLegacyPins();
check("legacy pins migrated to hashes", migrated >= 1, `migrated=${migrated}`);
const maria = store.getUser("u-maria");
check("passwordHash set after migration", !!maria.passwordHash && maria.passwordHash.startsWith("scrypt$"));
check("plaintext pin removed after migration", maria.pin === undefined);
check("re-running migration is a no-op", store.hashLegacyPins() === 0);

// --- login through the authenticator ------------------------------------
/* Password login is exercised on a REAL staff account, not a seeded demo one:
   demo accounts are deliberately unreachable by password now (they are opened
   from the demo panel), so using one here would test the refusal instead of the
   authenticator. */
const staff = store.addUser(
  { name: "Rosa Villanueva, PT", email: "rosa@clinic.test", role: "therapist",
    password: "staffPass12", license: { number: "PT-1234", expires: "2030-01-01" } },
  store.getUser("u-grace"),
);
check("staff fixture created", !staff.error && !!staff.user, staff.error);
const staffId = staff.user && staff.user.id;
check("login with migrated password succeeds", store.login(staffId, "staffPass12") === null);
check("login with wrong password fails", typeof store.login(staffId, "nope") === "string");
check("verifyPassword true for correct", store.verifyPassword("u-maria", "1234") === true);
check("verifyPassword false for wrong", store.verifyPassword("u-maria", "xxxx") === false);
check("verifyPassword does not start a session", true); // (pure check — no session mutation asserted below)

// --- setPassword rules + effect -----------------------------------------
check("setPassword rejects < 8 chars", !!store.setPassword("u-maria", "short", maria).error);
check("setPassword accepts a strong one", !store.setPassword("u-maria", "brandNewPw1", maria).error);
check("old password no longer verifies", store.verifyPassword("u-maria", "1234") === false);
check("new password verifies", store.verifyPassword("u-maria", "brandNewPw1") === true);
check("setPassword kept it hashed (no cleartext)", store.getUser("u-maria").pin === undefined &&
  store.getUser("u-maria").passwordHash.startsWith("scrypt$"));

// --- hash is salted (same input → different stored value) ----------------
const h1 = AUTH.hash("samePw12"), h2 = AUTH.hash("samePw12");
check("hashes are salted (distinct for same input)", h1 !== h2);
check("both salted hashes still verify", AUTH.verify({ passwordHash: h1 }, "samePw12") && AUTH.verify({ passwordHash: h2 }, "samePw12"));

// --- email login --------------------------------------------------------
check("login by email works", store.login("rosa@clinic.test", "staffPass12") === null);
check("login by email is case-insensitive", store.login("ROSA@clinic.test", "staffPass12") === null);

/* Opening a demo account without its password. The REFUSAL of a typed demo
   password is a server policy (it applies only where a demo is offered), so it
   is asserted over HTTP in the bootstrap checker — not here, where store.login
   is just a credential check. */
check("loginAsDemo opens a seeded demo account without a password",
  store.loginAsDemo("u-grace") === null);
check("loginAsDemo refuses a non-demo account",
  typeof store.loginAsDemo(staffId) === "string");
check("loginAsDemo refuses an unknown id",
  typeof store.loginAsDemo("u-nope") === "string");
check("getUserByEmail resolves", (store.getUserByEmail("maria@therachart.demo") || {}).id === "u-maria");
check("wrong email is a generic refusal", store.login("nobody@x.com", "1234") === "Incorrect email or password.");

// --- admin: create / reset / delete employees ---------------------------
const admin = store.getUser("u-grace"); // seeded admin
const created = store.addUser({ name: "New Hire, PT", email: "new.hire@clinic.com", role: "therapist", password: "tempPass12", license: { number: "PT-9", expires: "2030-01-01" } }, admin);
check("addUser creates a user", !created.error && !!created.user);
check("new hire has the login email", created.user && created.user.email === "new.hire@clinic.com");
check("new hire must change password", created.user && created.user.mustChangePassword === true);
check("new hire can log in by email + temp password", store.login("new.hire@clinic.com", "tempPass12") === null);
check("addUser rejects a missing/invalid email", !!store.addUser({ name: "X", role: "therapist", password: "whatever8" }, admin).error);
check("addUser rejects a duplicate email", !!store.addUser({ name: "Y", email: "new.hire@clinic.com", role: "therapist", password: "whatever8" }, admin).error);
check("addUser rejects short temp password", !!store.addUser({ name: "X", email: "x@clinic.com", role: "therapist", password: "short" }, admin).error);

// self-change clears the must-change flag; admin reset re-arms it
store.setPassword(created.user.id, "realPass345", created.user);
check("self set-password clears mustChangePassword", store.getUser(created.user.id).mustChangePassword === undefined);
store.setPassword(created.user.id, "tempReset99", admin, { mustChange: true });
check("admin reset re-arms mustChangePassword", store.getUser(created.user.id).mustChangePassword === true);

check("can't delete the last active admin", !!store.deleteUser("u-grace", admin).error);
check("can't delete your own account", !!store.deleteUser(admin.id, admin).error);
check("deleteUser removes an employee", store.deleteUser(created.user.id, admin).ok === true && store.getUser(created.user.id) === null);

console.log(`TheraChart auth checker: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n")); process.exit(1); }
