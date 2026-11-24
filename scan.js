/* TheraChart page scanner — turns phone photos of a paper chart into one PDF.

   A paper chart is ten to forty loose, handwritten pages. The import reads ONE
   file, so a clinic going digital needs the pages photographed in a row and
   handed over as a single document: same AI read, same review, and one scan
   kept on the chart with every page in order.

   Two halves:
     • pure (node-testable): levelsFromHistogram / grayStretch pick and apply a
       contrast stretch; jpegInfo reads a JPEG's size and colour channels;
       buildPdf wraps JPEG pages in a minimal PDF. No library: a PDF of JPEG
       pages is a few objects and a byte-offset table, and the JPEG bytes go in
       untouched (/DCTDecode), so nothing is re-encoded twice.
     • browser: enhancePage decodes a photo (EXIF orientation honoured),
       rotates, shrinks, turns it to high-contrast grayscale and re-encodes it.

   Why flatten + grayscale + stretch: a phone photo of paper is grey paper and
   blue-grey ink under yellow light, darker in whichever corner the phone
   shaded. Evening out the paper (flattenLight), then stretching the darkest
   1% to black and the lightest 1% to white makes handwriting read like a
   photocopy — for the clinician
   checking the scan and for the model reading it — and drops the size enough
   that a whole chart fits under the import limit. It is a stretch, not a
   threshold: faint pencil and a red-pen tick stay visible as grey, where a
   black/white cut would erase them. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraScan = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_EDGE = 1600;     // px on the long edge: handwriting stays legible, ~150-350 KB a page
  const QUALITY = 0.75;
  const PAPER_WHITE = 232;   // after flattening, at or above this is paper
  const PAGE_LONG_PT = 842;  // A4's long edge in PDF points, so pages print at a sane size

  /* ---------------- contrast ---------------- */

  /* The luminance levels to stretch to black and white: the `clip` share of
     darkest and lightest pixels saturates. A page with almost no range (a
     blank back, a photo of the desk) is widened rather than stretched, or its
     paper grain would be blown up into noise. */
  function levelsFromHistogram(hist, clip) {
    clip = clip == null ? 0.01 : clip;
    let total = 0;
    for (let i = 0; i < 256; i++) total += hist[i];
    if (!total) return { lo: 0, hi: 255 };
    const cut = total * clip;
    let lo = 0, acc = 0;
    while (lo < 255 && acc + hist[lo] <= cut) acc += hist[lo++];
    let hi = 255; acc = 0;
    while (hi > 0 && acc + hist[hi] <= cut) acc += hist[hi--];
    const MIN_RANGE = 64;
    if (hi - lo < MIN_RANGE) {
      const mid = (lo + hi) / 2;
      lo = Math.max(0, Math.round(mid - MIN_RANGE / 2));
      hi = Math.min(255, lo + MIN_RANGE);
      lo = hi - MIN_RANGE;
    }
    return { lo, hi };
  }

  // Rec. 601 luma — the weights a JPEG encoder uses for its Y channel
  const luma = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000;

  function histogramOf(rgba) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < rgba.length; i += 4) hist[Math.round(luma(rgba[i], rgba[i + 1], rgba[i + 2]))]++;
    return hist;
  }

  /* In place: every pixel to its luma, stretched so lo→0 and hi→255. */
  function grayStretch(rgba, lo, hi) {
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < rgba.length; i += 4) {
      let v = ((luma(rgba[i], rgba[i + 1], rgba[i + 2]) - lo) * 255) / span;
      v = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    }
    return rgba;
  }

  /* ---------------- uneven light ---------------- */

  /* A phone held over a page shades one corner and the desk lamp brightens
     another, so the paper itself runs from light to dark grey. One stretch
     for the whole page cannot fix that: the dark corner's paper ends up as
     dark as the bright corner's ink. So the paper's own brightness is
     estimated across the page and each pixel is divided by it — paper goes
     to white everywhere, ink stays as dark as it is relative to its paper.

     The estimate is a small copy of the page (each cell an average of a
     patch) with ink removed by taking the brightest of each cell's
     neighbours: handwriting is thin and never fills a neighbourhood, paper
     always does. */
  function dilateMax(gray, w, h, radius) {
    radius = radius == null ? 1 : radius;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const v = gray[yy * w + xx];
            if (v > m) m = v;
          }
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }

  /* In place on RGBA: luma divided by the paper estimate `bg` (one value per
     pixel, same order), so paper → 255 and ink keeps its relative darkness. */
  function flattenLight(rgba, bg) {
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
      const paper = bg[p] < 16 ? 16 : bg[p];   // a black border is not paper; don't divide by ~0
      let v = (luma(rgba[i], rgba[i + 1], rgba[i + 2]) * 255) / paper;
      v = v > 255 ? 255 : Math.round(v);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    }
    return rgba;
  }

  /* ---------------- JPEG header ---------------- */

  /* Width, height and channel count from the first SOF marker. The PDF has
     to name the colour space the JPEG really holds — a browser's canvas
     encodes a gray picture as three channels, and a PDF that says DeviceGray
     over a three-channel JPEG renders as garbage. */
  function jpegInfo(bytes) {
    if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }                 // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9],
        };
      }
      if (marker === 0xda) break;                               // start of scan: no SOF found
      i += 2 + len;
    }
    throw new Error("JPEG has no frame header");
  }

  /* ---------------- PDF ---------------- */

  const enc = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };

  /* pages: [Uint8Array of JPEG bytes] in reading order → Uint8Array PDF.
     Each image fills its own page, sized so the long edge is A4 long. */
  function buildPdf(pages) {
    if (!pages || !pages.length) throw new Error("no pages");
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const push = (u8) => { chunks.push(u8); pos += u8.length; };
    const str = (s) => push(enc(s));
    const obj = (n, body) => { offsets[n] = pos; str(`${n} 0 obj\n${body}\nendobj\n`); };

    str("%PDF-1.4\n");
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

    const n = pages.length;
    const pageIds = pages.map((_, k) => 3 + k * 3);
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`);

    pages.forEach((jpeg, k) => {
      const info = jpegInfo(jpeg);
      const cs = info.components === 1 ? "/DeviceGray" : info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      const scale = PAGE_LONG_PT / Math.max(info.width, info.height);
      const w = +(info.width * scale).toFixed(2), h = +(info.height * scale).toFixed(2);
      const pageId = pageIds[k], contentId = pageId + 1, imgId = pageId + 2;
      obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im${k} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      const draw = `q ${w} 0 0 ${h} 0 0 cm /Im${k} Do Q`;
      obj(contentId, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
      offsets[imgId] = pos;
      str(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
        `/ColorSpace ${cs} /BitsPerComponent 8 ${info.components === 4 ? "/Decode [1 0 1 0 1 0 1 0] " : ""}` +
        `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      push(jpeg);
      str("\nendstream\nendobj\n");
    });

    const count = 3 + n * 3;
    const xrefAt = pos;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    str(xref + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const out = new Uint8Array(pos);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /* ---------------- filing: which patient is this paper about? ----------------
     A scan is read BEFORE anyone picks a patient, so the name, birth date
     and phone written on it are matched against the clinic's patients to
     suggest who it belongs to. The person filing always chooses; this only
     orders the list and says why. Names are compared as words with accents
     and punctuation dropped, in either order ("Reyes, Juan Miguel" and
     "Juan M. Reyes" both find Juan Reyes), because handwritten charts write
     names every way. A birth date that is on both and DIFFERS counts hard
     against — two Juan Reyeses is the case this exists for. */

  const nameWords = (s) => String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z\s,.-]/g, " ").replace(/[.,-]/g, " ")
    .split(/\s+/).filter(Boolean);
  const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);

  function matchPatients(doc, patients, opts) {
    opts = opts || {};
    const words = nameWords(doc && doc.patientName);
    const dob = (doc && doc.patientDob) || "";
    const phone = digits(doc && doc.patientPhone);
    if (!words.length && !dob && phone.length < 7) return [];
    const has = (w) => words.includes(w);
    const out = [];
    for (const p of patients || []) {
      let score = 0;
      const reasons = [];
      const last = nameWords(p.lastName), first = nameWords(p.firstName), pref = nameWords(p.preferredName);
      if (last.length && last.every(has)) { score += 45; reasons.push("last name matches"); }
      if (first.length && has(first[0])) { score += 30; reasons.push("first name matches"); }
      else if (pref.length && has(pref[0])) { score += 22; reasons.push("goes by this name"); }
      else if (first.length && words.some((w) => w.length === 1 && w === first[0][0])) { score += 8; reasons.push("first initial matches"); }
      if (dob && p.dob) {
        if (p.dob === dob) { score += 50; reasons.push("birth date matches"); }
        else { score -= 50; reasons.push("birth date differs"); }
      }
      const pp = digits(p.phone);
      if (phone.length >= 7 && pp.length >= 7 && pp === phone) { score += 30; reasons.push("phone matches"); }
      if (score >= 30) out.push({ patient: p, score, reasons,
        strength: score >= 95 ? "strong" : score >= 60 ? "likely" : "possible" });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit || 5);
  }

  /* Split a written name into first/last for a new patient. "Reyes, Juan
     Miguel" is last-first; "Juan Miguel Reyes" is first…last. A guess the
     person filing can correct — never saved without their say-so. */
  /* Paper charts write surnames in capitals ("DELA CRUZ, Rosario"); a chart
     record shouldn't keep shouting. Only a word that is ALL capitals is
     changed — "McArthur" or "de los Santos" written by hand stay as written. */
  const unshout = (w) => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)
    ? w.toLowerCase().replace(/(^|[-'])([a-z])/g, (m, a, c) => a + c.toUpperCase())
    : w);
  function splitName(s) {
    const raw = String(s || "").trim().replace(/\s+/g, " ").split(" ").map(unshout).join(" ");
    if (!raw) return { firstName: "", lastName: "" };
    if (raw.includes(",")) {
      const [last, rest] = raw.split(/,(.*)/);
      return { firstName: (rest || "").trim(), lastName: last.trim() };
    }
    const parts = raw.split(" ");
    if (parts.length === 1) return { firstName: "", lastName: parts[0] };
    return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
  }

  /* Where a document of this kind belongs, in words for the person filing. */
  function adviceFor(result) {
    const n = (result.visits || []).length;
    const kind = result.docKind || "other";
    if (n) return { action: "visits", text: `Add ${n} past visit${n === 1 ? "" : "s"} to the patient's chart — the scan is kept with them.` };
    const where = {
      referral: "a referral", imaging: "an imaging report", lab: "a lab result", intake: "an intake form",
      consent: "a consent form", insurance: "an insurance / HMO document", "therapy-notes": "therapy notes",
    }[kind];
    return { action: "file", text: `Save it to the patient's Files${where ? ` as ${where}` : ""} — no visits to add.` };
  }

  /* ---------------- browser: one photo → one cleaned page ---------------- */

  /* The paper's brightness at every pixel of `canvas`: shrink to ~1/24 (the
     browser averages each patch), drop the ink with dilateMax, then scale
     back up with smoothing so the estimate has no visible blocks. */
  function paperEstimate(canvas) {
    const sw = Math.max(4, Math.round(canvas.width / 24)), sh = Math.max(4, Math.round(canvas.height / 24));
    const small = document.createElement("canvas");
    small.width = sw; small.height = sh;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const sd = sctx.getImageData(0, 0, sw, sh);
    const gray = new Float32Array(sw * sh);
    for (let i = 0, p = 0; i < sd.data.length; i += 4, p++) gray[p] = luma(sd.data[i], sd.data[i + 1], sd.data[i + 2]);
    const paper = dilateMax(gray, sw, sh, 2);
    for (let i = 0, p = 0; i < sd.data.length; i += 4, p++) sd.data[i] = sd.data[i + 1] = sd.data[i + 2] = paper[p];
    sctx.putImageData(sd, 0, 0);
    const big = document.createElement("canvas");
    big.width = canvas.width; big.height = canvas.height;
    const bctx = big.getContext("2d", { willReadFrequently: true });
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(small, 0, 0, big.width, big.height);
    const bd = bctx.getImageData(0, 0, big.width, big.height).data;
    const out = new Uint8ClampedArray(big.width * big.height);
    for (let i = 0, p = 0; i < bd.length; i += 4, p++) out[p] = bd[i];
    return out;
  }

  /* rotate: quarter turns clockwise (0-3). Returns { blob, bytes, width,
     height } of a grayscale JPEG. Throws if the browser cannot decode it —
     the caller says so rather than putting a blank page in the chart. */
  async function enhancePage(file, opts) {
    opts = opts || {};
    const turns = ((opts.rotate || 0) % 4 + 4) % 4;
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const scale = Math.min(1, (opts.maxEdge || MAX_EDGE) / Math.max(bitmap.width, bitmap.height));
      const bw = Math.round(bitmap.width * scale), bh = Math.round(bitmap.height * scale);
      const sideways = turns % 2 === 1;
      const canvas = document.createElement("canvas");
      canvas.width = sideways ? bh : bw;
      canvas.height = sideways ? bw : bh;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((turns * Math.PI) / 2);
      ctx.drawImage(bitmap, -bw / 2, -bh / 2, bw, bh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      flattenLight(img.data, paperEstimate(canvas));
      /* Flattened paper sits near 255 (a few levels under, where the shaded
         corner was brightened and its noise with it), so white is fixed at
         PAPER_WHITE rather than measured. Black is the darkest 1% — but a
         page of handwriting is often LESS than 1% ink, and then the darkest
         1% is paper; so black is never closer than 128 levels to white. Ink
         (~40-130 once flattened) goes black, faint pencil (~200) stays grey. */
      const lv = levelsFromHistogram(histogramOf(img.data));
      const hi = PAPER_WHITE, lo = Math.min(lv.lo, hi - 128);
      grayStretch(img.data, lo, hi);
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", opts.quality || QUALITY));
      if (!blob) throw new Error("couldn't encode the page");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { blob, bytes, width: canvas.width, height: canvas.height, levels: { lo, hi } };
    } finally {
      bitmap.close();
    }
  }

  return { levelsFromHistogram, histogramOf, grayStretch, dilateMax, flattenLight, jpegInfo,
    matchPatients, splitName, adviceFor, nameWords, buildPdf, enhancePage, MAX_EDGE, QUALITY };
});
