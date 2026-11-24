/* Offline checker for the paper-page scanner (scan.js): the contrast stretch,
   the JPEG header reader, and the PDF it assembles from the pages.
   Run: node test/scan.test.js

   The browser half (enhancePage: decode, rotate, draw) needs a canvas and is
   exercised in the app; everything it relies on to be RIGHT is here. The
   PDF is checked structurally — every xref offset must land on its object —
   because a PDF with one wrong offset still opens in some viewers and fails
   in others, and the model reading it is one of the others. */
"use strict";

const T = require("../scan.js");

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) passed++;
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

/* A JPEG as far as headers go: SOI, an APP segment to skip, a DQT, the SOF
   frame header, a stub scan, EOI. Enough for jpegInfo and for buildPdf,
   which copies the bytes without decoding them. */
function fakeJpeg(width, height, components, sof) {
  const seg = (marker, body) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
  const app1 = seg(0xe1, Array.from({ length: 300 }, (_, i) => i & 0xff));   // > 255: two-byte length matters
  const dqt = seg(0xdb, Array(65).fill(1));
  const sofBody = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, components];
  for (let c = 0; c < components; c++) sofBody.push(c + 1, 0x11, 0);
  const frame = seg(sof || 0xc0, sofBody);
  const sos = seg(0xda, [1, 1, 0, 0, 0x3f, 0]);
  return new Uint8Array([0xff, 0xd8, ...app1, ...dqt, ...frame, ...sos, 0x12, 0x34, 0xff, 0xd9]);
}

const text = (u8) => Buffer.from(u8).toString("latin1");

/* ---------------- jpegInfo ---------------- */
{
  const rgb = T.jpegInfo(fakeJpeg(1200, 1600, 3));
  check("reads width/height past a long APP1 segment", rgb.width === 1200 && rgb.height === 1600, JSON.stringify(rgb));
  check("reads three channels", rgb.components === 3);
  check("reads one channel (gray)", T.jpegInfo(fakeJpeg(10, 20, 1)).components === 1);
  check("reads a progressive frame (SOF2)", T.jpegInfo(fakeJpeg(640, 480, 3, 0xc2)).width === 640);
  let threw = false;
  try { T.jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])); } catch (_) { threw = true; }
  check("refuses a PNG", threw);
  threw = false;
  try { T.jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0])); } catch (_) { threw = true; }
  check("refuses a JPEG with no frame header", threw);
}

/* ---------------- buildPdf ---------------- */
{
  const pages = [fakeJpeg(1200, 1600, 3), fakeJpeg(800, 600, 1), fakeJpeg(1000, 1414, 3)];
  const pdf = T.buildPdf(pages);
  const s = text(pdf);

  check("starts with a PDF header", s.startsWith("%PDF-1.4\n"));
  check("ends with %%EOF", s.trimEnd().endsWith("%%EOF"));
  check("page count is the number of photos", /\/Count 3\b/.test(s));
  check("three page objects", (s.match(/\/Type \/Page\b/g) || []).length === 3);

  const startxref = Number(s.match(/startxref\n(\d+)\n%%EOF/)[1]);
  check("startxref points at the xref table", s.slice(startxref, startxref + 5) === "xref\n");

  const xref = s.slice(startxref).split("\n");
  const count = Number(xref[1].split(" ")[1]);
  check("xref covers catalog, pages and 3 objects per page", count === 3 + 3 * 3, String(count));
  let allLand = true;
  for (let id = 1; id < count; id++) {
    const off = Number(xref[2 + id].slice(0, 10));
    if (s.slice(off, off + `${id} 0 obj`.length) !== `${id} 0 obj`) { allLand = false; console.error(`    object ${id} offset ${off} misses`); }
  }
  check("every xref offset lands on its own object", allLand);
  check("xref entries are 20 bytes each", xref.slice(2, 2 + count).every((l) => (l + "\n").length === 20));

  // pages in the order given, each image's colour space matching its channels
  const imgs = [...s.matchAll(/\/Width (\d+) \/Height (\d+) \/ColorSpace \/(\w+)/g)].map((m) => [+m[1], +m[2], m[3]]);
  check("images keep page order and size",
    JSON.stringify(imgs.map((x) => x.slice(0, 2))) === JSON.stringify([[1200, 1600], [800, 600], [1000, 1414]]), JSON.stringify(imgs));
  check("3-channel JPEG is DeviceRGB, 1-channel is DeviceGray",
    imgs[0][2] === "DeviceRGB" && imgs[1][2] === "DeviceGray" && imgs[2][2] === "DeviceRGB");

  // long edge is A4's 842pt; a landscape photo gets a landscape page
  const boxes = [...s.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [+m[1], +m[2]]);
  check("portrait page is 631.5 × 842", boxes[0][0] === 631.5 && boxes[0][1] === 842, JSON.stringify(boxes[0]));
  check("landscape photo → landscape page", boxes[1][0] === 842 && boxes[1][1] === 631.5, JSON.stringify(boxes[1]));

  // JPEG bytes copied verbatim, and each stream's /Length is its real length
  const buf = Buffer.from(pdf);
  let verbatim = true;
  for (const jp of pages) if (buf.indexOf(Buffer.from(jp)) < 0) verbatim = false;
  check("each page's JPEG bytes are embedded untouched", verbatim);
  let lengthsOk = true;
  for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length, len = Number(m[1]);
    if (s.slice(start + len, start + len + 10) !== "\nendstream") lengthsOk = false;
  }
  check("every stream /Length matches its bytes", lengthsOk);

  let threw = false;
  try { T.buildPdf([]); } catch (_) { threw = true; }
  check("no pages is an error, not an empty PDF", threw);
}

/* ---------------- contrast ---------------- */
{
  const hist = new Array(256).fill(0);
  // a photographed page: grey paper around 190, ink around 60, a few outliers
  hist[0] = 2; hist[255] = 2;
  for (let v = 50; v <= 70; v++) hist[v] = 100;
  for (let v = 180; v <= 200; v++) hist[v] = 900;
  const { lo, hi } = T.levelsFromHistogram(hist);
  check("lo sits at the ink, not the stray black pixels", lo >= 45 && lo <= 60, String(lo));
  check("hi sits at the paper, not the stray white pixels", hi >= 190 && hi <= 200, String(hi));

  const flat = new Array(256).fill(0);
  for (let v = 120; v <= 130; v++) flat[v] = 1000;   // a blank back of a page
  const f = T.levelsFromHistogram(flat);
  check("a near-blank page is widened to at least 64 levels", f.hi - f.lo >= 64, JSON.stringify(f));
  check("…and stays inside 0-255", f.lo >= 0 && f.hi <= 255);
  const dark = new Array(256).fill(0); dark[0] = 500; dark[3] = 500;
  const d = T.levelsFromHistogram(dark);
  check("a range at the very bottom is clamped, not negative", d.lo === 0 && d.hi === 64, JSON.stringify(d));
  check("an empty histogram stretches nothing", JSON.stringify(T.levelsFromHistogram(new Array(256).fill(0))) === '{"lo":0,"hi":255}');

  const px = new Uint8ClampedArray([
    60, 60, 60, 255,      // ink → black
    195, 195, 195, 255,   // paper → white
    128, 128, 128, 255,   // middle → middle
    255, 0, 0, 255,       // red pen → visible grey, not erased
  ]);
  T.grayStretch(px, 60, 195);
  check("ink goes to black", px[0] === 0);
  check("paper goes to white", px[4] === 255);
  check("mid-grey stays mid", px[8] > 100 && px[8] < 155, String(px[8]));
  check("a red pen mark stays visible", px[12] < 60, String(px[12]));
  check("every pixel is grey (r = g = b) and alpha kept",
    [0, 4, 8, 12].every((i) => px[i] === px[i + 1] && px[i] === px[i + 2] && px[i + 3] === 255));

  const h = T.histogramOf(new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255, 200, 200, 200, 255]));
  check("histogram counts pixels by luma", h[10] === 2 && h[200] === 1 && h.reduce((a, b) => a + b, 0) === 3);
}

/* ---------------- uneven light ---------------- */
{
  // 5×5 of paper at 200 with one stroke of ink (60) through the middle column
  const w = 5, h = 5;
  const g = new Float32Array(w * h).fill(200);
  for (let y = 0; y < h; y++) g[y * w + 2] = 60;
  const bg = T.dilateMax(g, w, h, 1);
  check("dilateMax drops a thin ink stroke from the paper estimate", bg.every((v) => v === 200), Array.from(bg).join(","));

  // the same ink on a bright and a shaded part of the page
  const px = new Uint8ClampedArray([
    220, 220, 220, 255,   // bright paper
    110, 110, 110, 255,   // shaded paper
    66, 66, 66, 255,      // ink on bright paper (30% of it)
    33, 33, 33, 255,      // ink on shaded paper (30% of it)
    5, 5, 5, 255,         // a black table edge
  ]);
  T.flattenLight(px, [220, 110, 220, 110, 5]);
  check("bright and shaded paper both become white", px[0] === 255 && px[4] === 255, `${px[0]} ${px[4]}`);
  check("ink ends up equally dark on bright and shaded paper", Math.abs(px[8] - px[12]) <= 1 && px[8] < 90, `${px[8]} ${px[12]}`);
  check("a near-black border is not divided by ~0 into white", px[16] < 128, String(px[16]));
}

/* ---------------- filing: matching a scan to a patient ---------------- */
{
  const pts = [
    { id: "a", firstName: "Juan", lastName: "Reyes", dob: "1980-03-12", phone: "0917 555 0101" },
    { id: "b", firstName: "Juan", lastName: "Reyes", dob: "1992-07-01", phone: "0918 222 3333" },
    { id: "c", firstName: "María", lastName: "Dela Cruz", preferredName: "Bing", dob: "1975-01-20", phone: "" },
    { id: "d", firstName: "Pedro", lastName: "Santos", dob: "1960-05-05", phone: "0917 555 0101" },
  ];
  const ids = (doc) => T.matchPatients(doc, pts).map((m) => m.patient.id);

  check("'Last, First' finds the patient", ids({ patientName: "Reyes, Juan" }).slice(0, 2).sort().join() === "a,b");
  check("birth date picks the right one of two Juan Reyeses",
    ids({ patientName: "Reyes, Juan", patientDob: "1992-07-01" })[0] === "b");
  const wrongDob = T.matchPatients({ patientName: "Juan Reyes", patientDob: "1992-07-01" }, pts).find((m) => m.patient.id === "a");
  check("a differing birth date drops a same-name patient out of the suggestions", !wrongDob);
  const strong = T.matchPatients({ patientName: "Juan M. Reyes", patientDob: "1980-03-12" }, pts)[0];
  check("name + birth date is a strong match, with its reasons",
    strong.patient.id === "a" && strong.strength === "strong" && strong.reasons.includes("birth date matches"), JSON.stringify(strong && strong.reasons));
  check("accents and a two-word last name match", ids({ patientName: "MARIA DELA CRUZ" })[0] === "c");
  check("a preferred name counts", ids({ patientName: "Bing Dela Cruz" })[0] === "c");
  check("an unrelated name suggests nobody", ids({ patientName: "Ana Lim" }).length === 0);
  check("nothing readable suggests nobody", ids({ patientName: "" }).length === 0);
  check("phone alone (no name) still finds the patient",
    ids({ patientName: "", patientPhone: "+63 918 222 3333" })[0] === "b");
  check("a shared phone doesn't outrank the name on the paper",
    ids({ patientName: "Pedro Santos", patientPhone: "09175550101" })[0] === "d");

  const sn = T.splitName;
  check("splitName: 'Reyes, Juan Miguel'", JSON.stringify(sn("Reyes, Juan Miguel")) === '{"firstName":"Juan Miguel","lastName":"Reyes"}');
  check("splitName: 'Juan Miguel Reyes'", JSON.stringify(sn("Juan Miguel Reyes")) === '{"firstName":"Juan Miguel","lastName":"Reyes"}');
  check("splitName: one word is a last name", JSON.stringify(sn("Reyes")) === '{"firstName":"","lastName":"Reyes"}');
  check("splitName: empty", JSON.stringify(sn("")) === '{"firstName":"","lastName":""}');
  check("splitName: capitals become title case", JSON.stringify(sn("DELA CRUZ, ROSARIO")) === '{"firstName":"Rosario","lastName":"Dela Cruz"}', JSON.stringify(sn("DELA CRUZ, ROSARIO")));
  check("splitName: hyphen and apostrophe in capitals", sn("Ana O'BRIEN-SY").lastName === "O'Brien-Sy", sn("Ana O'BRIEN-SY").lastName);
  check("splitName: mixed case left alone", sn("Juan McArthur").lastName === "McArthur");
  check("splitName: an initial stays an initial", sn("Juan M. Reyes").firstName === "Juan M.");

  check("advice: visits found → add them", T.adviceFor({ visits: [{}, {}], docKind: "therapy-notes" }).action === "visits");
  const ref = T.adviceFor({ visits: [], docKind: "referral" });
  check("advice: a referral → file it, named as a referral", ref.action === "file" && /referral/.test(ref.text), ref.text);
}

console.log(`scan: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
