#!/usr/bin/env python3
"""Build image-only ("scanned") PDFs of PT chart records, for extract.js.

A PDF built out of text drawing operators has a text layer, so a model can
read it without ever doing OCR — which makes it useless for testing the
scanned-record import. Every page here is a grayscale BITMAP with photocopy
artifacts (skew, toner speckle, scanner falloff, JPEG noise) and no text layer
at all, so the import path is exercised the way a real chart scan exercises it.

Deterministic (fixed seed): repeat runs measure the model, not the fixture.

    python3 test/eval/fixtures/make-scan.py

Needs Pillow. macOS system python has it: /usr/bin/python3. The PDFs are
gitignored — extract.js regenerates them on demand.

The content is synthetic. Never commit a real patient record here.
"""
import io, os, random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
DPI_RENDER = 200
DPI_OUT = 150
W, H = int(8.5 * DPI_RENDER), int(11 * DPI_RENDER)
FONT_DIR = "/System/Library/Fonts/Supplemental"


def font(name, pt):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), int(pt / 72.0 * DPI_RENDER))


MONO = lambda pt: font("Courier New.ttf", pt)
MONO_B = lambda pt: font("Courier New Bold.ttf", pt)


def render_page(lines, rng):
    """lines: list of (text, bold) tuples. Returns a scan-like grayscale image."""
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    x0, y = int(0.75 * DPI_RENDER), int(0.7 * DPI_RENDER)
    lh = int(10.5 / 72.0 * DPI_RENDER * 1.45)
    for text, bold in lines:
        if text:
            # per-line jitter: real photocopies don't have perfectly aligned rows
            jx = rng.randint(-2, 2)
            ink = rng.randint(15, 65)
            d.text((x0 + jx, y), text, font=(MONO_B if bold else MONO)(10.5), fill=ink)
        y += lh

    # --- photocopy artifacts ---
    img = img.rotate(rng.uniform(-0.7, 0.7), resample=Image.BICUBIC, fillcolor=255)
    img = img.filter(ImageFilter.GaussianBlur(radius=0.8))

    # toner speckle + paper grain
    px = img.load()
    for _ in range(int(W * H * 0.0012)):
        sx, sy = rng.randrange(W), rng.randrange(H)
        px[sx, sy] = max(0, px[sx, sy] - rng.randint(40, 150))
    noise = Image.effect_noise((W, H), 18).convert("L")
    img = Image.blend(img, Image.composite(img, noise, img.point(lambda v: 255 if v > 200 else 0)), 0.35)

    # scanner light falloff down the page
    grad = Image.linear_gradient("L").resize((W, H)).point(lambda v: 255 - int(v * 0.06))
    img = Image.blend(img, Image.composite(img, grad, grad), 0.5)

    img = img.resize((int(W * DPI_OUT / DPI_RENDER), int(H * DPI_OUT / DPI_RENDER)), Image.LANCZOS)

    # bake in JPEG compression artifacts the way a real scanner would
    buf = io.BytesIO()
    img.convert("L").save(buf, "JPEG", quality=58)
    buf.seek(0)
    return Image.open(buf).convert("L")


def build(name, pages):
    rng = random.Random(20260728)
    imgs = [render_page(p, rng) for p in pages]
    path = os.path.join(OUT, name)
    imgs[0].save(path, "PDF", resolution=float(DPI_OUT), save_all=True, append_images=imgs[1:])
    print(f"{name}: {len(imgs)} page(s), {os.path.getsize(path):,} bytes")
    return path


def L(text="", bold=False):
    return (text, bold)


# ---- fixture A: the same 2 visits as SAMPLE_PDF_LINES, but truly scanned ----
PAGE_2VISIT = [
    L("BAYANIHAN PHYSICAL THERAPY CENTER", True),
    L("PATIENT RECORD (photocopy)"),
    L(),
    L("Patient: REYES, JUAN   DOB: 04/12/1988"),
    L("Dx: R rotator cuff strain"),
    L(),
    L("INITIAL EVALUATION - 05/02/2023", True),
    L("Therapist: R. Villanueva, PT"),
    L("S: Right shoulder pain 8/10 after lifting at work, worse"),
    L("   overhead. Denies numbness or tingling."),
    L("O: Guarding noted. Shoulder flexion 95 degrees."),
    L("   Abduction 85 degrees. MMT right shoulder abduction"),
    L("   3+/5. Positive Neer test."),
    L("A: Findings consistent with right rotator cuff strain."),
    L("P: PT 3x/week for 6 weeks - therex, manual therapy,"),
    L("   modalities."),
    L(),
    L("DAILY TREATMENT NOTE - 05/09/2023", True),
    L("Therapist: R. Villanueva, PT"),
    L("S: Pain improved to 5/10. Still sore reaching overhead."),
    L("O: Shoulder flexion 115 degrees."),
    L("Rx: Scaption raises 3x10, ER isometrics, posterior"),
    L("    capsule mobilization grade III, HEP reviewed."),
    L("    Tolerated well."),
]

# ---- fixture B: a longer 4-visit chart across 2 pages ----
PAGE_4A = [
    L("BAYANIHAN PHYSICAL THERAPY CENTER", True),
    L("PATIENT RECORD (photocopy)          Page 1 of 2"),
    L(),
    L("Patient: REYES, JUAN   DOB: 04/12/1988"),
    L("Dx: R rotator cuff strain"),
    L(),
    L("INITIAL EVALUATION - 05/02/2023", True),
    L("Therapist: R. Villanueva, PT"),
    L("S: Right shoulder pain 8/10 after lifting at work, worse"),
    L("   overhead. Denies numbness or tingling."),
    L("O: Guarding noted. Shoulder flexion 95 degrees."),
    L("   Abduction 85 degrees. MMT right shoulder abduction"),
    L("   3+/5. Positive Neer test."),
    L("A: Findings consistent with right rotator cuff strain."),
    L("P: PT 3x/week for 6 weeks - therex, manual therapy,"),
    L("   modalities."),
    L(),
    L("DAILY TREATMENT NOTE - 05/09/2023", True),
    L("Therapist: R. Villanueva, PT"),
    L("S: Pain improved to 5/10. Still sore reaching overhead."),
    L("O: Shoulder flexion 115 degrees."),
    L("Rx: Scaption raises 3x10, ER isometrics, posterior"),
    L("    capsule mobilization grade III, HEP reviewed."),
    L("    Tolerated well."),
]

PAGE_4B = [
    L("BAYANIHAN PHYSICAL THERAPY CENTER", True),
    L("PATIENT RECORD (photocopy)          Page 2 of 2"),
    L(),
    L("Patient: REYES, JUAN"),
    L(),
    L("PROGRESS RE-EVALUATION - 05/23/2023", True),
    L("Therapist: M. Santos, PT"),
    L("S: Pain now 3/10 with overhead reach. Able to sleep on"),
    L("   the right side again. Returning to light duty."),
    L("O: Shoulder flexion 150 degrees, abduction 140 degrees."),
    L("   MMT right shoulder abduction 4/5. Negative Neer test."),
    L("A: Good progress toward goals. Strength deficit remains."),
    L("P: Continue 2x/week for 3 weeks, progress resistance."),
    L(),
    L("DISCHARGE SUMMARY - 06/13/2023", True),
    L("Therapist: M. Santos, PT"),
    L("S: Denies pain with daily activity. Occasional ache after"),
    L("   heavy overhead work, 1/10."),
    L("O: Shoulder flexion 170 degrees, abduction 165 degrees."),
    L("   MMT right shoulder abduction 5/5."),
    L("A: Goals met. Patient independent with HEP."),
    L("P: Discharge to independent home program. Follow up PRN."),
]

if __name__ == "__main__":
    build("scan_2visit.pdf", [PAGE_2VISIT])
    build("scan_4visit.pdf", [PAGE_4A, PAGE_4B])
