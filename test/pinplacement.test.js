/* TheraChart pin-placement checker.

   A typed finding becomes a pin on the mannequin. This checks the three
   things that have to be true for the pin to land where the therapist meant:

     1. the right REGION and SIDE are read out of an everyday finding,
     2. the coordinates put that side on the correct half of each view
        (the front view is mirrored: the patient's left is the viewer's right),
     3. a pin moved by hand is named back correctly — nearestPart() is what
        offers "Rename to Left knee" after a therapist drags a pin.

   Run: node test/pinplacement.test.js

   Known gaps, left for the therapist's Move pin rather than guessed at here:
   - "pain in the right groin with hip flexion" pins a sideless Groin and an
     extra Hip (the hip is named as a movement, not a complaint).
   - "stiffness between the shoulder blades" adds a one-sided Shoulder blade
     pin next to Mid back. */

"use strict";

const P = require("../parser.js");

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
};
const pins = (line) => P.parseUtterance(line).mentions;
const show = (ms) => ms.map((m) => `${m.side || "-"} ${m.partName} [${m.view} ${m.x},${m.y}]`).join(" | ") || "(none)";

/* ---- 1. region + side from everyday typed findings ---- */
const CASES = [
  // [finding, [[part, side, view], ...]]  — side null = midline
  ["Sharp pain in the left knee, 6/10, worse on stairs", [["Knee", "left", "front"]]],
  ["Right shoulder stiff in the morning", [["Shoulder", "right", "front"]]],
  ["Low back pain radiating down the right leg", [["Lower back", null, "back"], ["Leg", "right", "front"]]],
  ["Tenderness over the left lateral epicondyle", [["Elbow", "left", "front"]]],
  ["Numbness in the right thumb and index finger", [["Thumb", "right", "front"], ["Finger", "right", "front"]]],
  ["Pain in the left wrist and thumb", [["Wrist", "left", "front"], ["Thumb", "left", "front"]]],
  ["Pain at the back of the left thigh when bending", [["Hamstring", "left", "back"]]],
  ["Neck pain 5/10, worse with looking down", [["Neck", null, "front"]]],
  ["Swelling around the left ankle", [["Ankle", "left", "front"]]],
  ["Right hip pain climbing stairs", [["Hip", "right", "front"]]],
  ["Tight right calf after running", [["Calf", "right", "back"]]],
  ["Burning pain in the left heel first thing in the morning", [["Heel", "left", "back"]]],
  ["Right wrist pain typing, positive Phalen's test", [["Wrist", "right", "front"]]],
  ["Left SI joint pain with prolonged sitting", [["SI joint", "left", "back"]]],
  ["Left shoulder blade aches by the end of the day", [["Shoulder blade", "left", "back"]]],
  ["Plantar fascia pain on the right foot", [["Foot", "right", "front"]]],
  ["pain in both knees", [["Knee", "left", "front"], ["Knee", "right", "front"]]],
  ["Right knee and left ankle swelling", [["Knee", "right", "front"], ["Ankle", "left", "front"]]],
];
for (const [line, want] of CASES) {
  const got = pins(line);
  for (const [part, side, view] of want) {
    const hit = got.find((m) => m.partName === part && (m.side || null) === side);
    check(`"${line}" pins ${side || "midline"} ${part}`, !!hit, `got: ${show(got)}`);
    if (hit) check(`"${line}" puts ${part} on the ${view} view`, hit.view === view, `got: ${hit.view}`);
  }
}

/* a side is carried across "and", never across a new clause */
{
  const got = pins("right knee pain, hip feels fine");
  const hip = got.find((m) => m.partName === "Hip");
  check("a new clause keeps its own (missing) side", hip && hip.side == null, `got: ${show(got)}`);
  const sides = pins("right knee and left ankle swelling");
  check("an explicit second side is never overwritten",
    sides.some((m) => m.partName === "Ankle" && m.side === "left"), `got: ${show(sides)}`);
}

/* ---- 2. every sided region lands on the correct half of each view ---- */
for (const part of P.BODY_PARTS) {
  if (!part.sided || !part.dx || part.fixedSide) continue;
  const L = P.coordFor(part, "left");
  const R = P.coordFor(part, "right");
  if (part.view === "front") {
    check(`${part.name}: patient's left is the viewer's right on the front`, L.x > 100 && R.x < 100, `L ${L.x}, R ${R.x}`);
  } else {
    check(`${part.name}: patient's left is the viewer's left on the back`, L.x < 100 && R.x > 100, `L ${L.x}, R ${R.x}`);
  }
  check(`${part.name}: left and right mirror each other`, Math.abs((L.x - 100) + (R.x - 100)) < 0.01, `L ${L.x}, R ${R.x}`);
  check(`${part.name}: inside the figure`, L.x >= 0 && L.x <= 200 && L.y >= 0 && L.y <= 460, `${L.x},${L.y}`);
}

/* head-to-toe order on the front view — a pin for the ankle above the knee
   would be a lexicon typo nobody would spot in review */
{
  const y = (name) => P.coordForName(name, "left").y;
  const order = ["Head", "Neck", "Shoulder", "Elbow", "Wrist", "Knee", "Ankle"];
  for (let i = 1; i < order.length; i++) {
    check(`${order[i - 1]} sits above ${order[i]}`, y(order[i - 1]) < y(order[i]), `${y(order[i - 1])} vs ${y(order[i])}`);
  }
}

/* ---- 3. a hand-placed pin is named back correctly ---- */
for (const part of P.BODY_PARTS) {
  const sides = part.fixedSide ? [part.fixedSide] : part.sided && part.dx ? ["left", "right"] : [null];
  for (const side of sides) {
    const c = P.coordFor(part, side);
    const near = P.nearestPart(part.view, c.x, c.y);
    // several regions share an anchor (Heart and Chest); the spot is what counts
    check(`a pin dropped on ${side || ""} ${part.name} is named for that spot`,
      near && near.dist < 0.01, near ? `nearest ${near.side || "-"} ${near.part} at ${near.dist.toFixed(1)}` : "nothing near");
  }
}
{
  const knee = P.coordForName("knee", "left");
  const n = P.nearestPart("front", knee.x + 3, knee.y + 4);
  check("a pin nudged off the left knee is still the left knee", n && n.part === "Knee" && n.side === "left", JSON.stringify(n));
  const across = P.nearestPart("front", 200 - knee.x, knee.y);
  check("dragging the left-knee pin across the midline reads as the right knee", across && across.part === "Knee" && across.side === "right", JSON.stringify(across));
  check("a spot far outside the figure is nothing", P.nearestPart("front", 199, 5, 20) === null);
}

console.log(`TheraChart pin-placement checker: ${passed}/${passed + failures.length} checks passed`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
