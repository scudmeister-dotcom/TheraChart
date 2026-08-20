#!/usr/bin/env python3
"""Build chart-record PDFs for extract.js, in two flavours.

DEFAULT — image-only "scans". A PDF built out of text drawing operators has a
text layer, so a model can read it without ever doing OCR, which makes it
useless for testing the scanned-record import. Every page here is a grayscale
BITMAP with simulated photocopy artifacts (skew, toner speckle, scanner
falloff, JPEG noise) and no text layer at all.

    python3 test/eval/fixtures/make-scan.py
      -> scan_2visit.pdf  scan_4visit.pdf  scan_handwritten.pdf

--print — clean, high-contrast pages meant to be PRINTED and then captured
with a real scanner or a phone. No simulated artifacts: the point is to let a
real sensor supply the real ones (shadow, keystone, lighting, JPEG). Print
these, capture them, and drop the result in next to this script.

    python3 test/eval/fixtures/make-scan.py --print
      -> print_2visit.pdf  print_4visit.pdf  print_handwritten.pdf

Simulated degradation is a stand-in, not the real thing — a phone photo of a
printed page is a materially better fixture than anything in here.

Deterministic (fixed seed): repeat runs measure the model, not the fixture.
Needs Pillow; macOS system python has it (/usr/bin/python3). Generated PDFs
are gitignored — extract.js rebuilds them on demand.

The content is synthetic, and the printable pages say so on the page. Never
commit a real patient record here.
"""
import io, os, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = "/System/Library/Fonts/Supplemental"
PAGE_IN = (8.5, 11)

# Printed pages render bigger and cleaner: the real capture device supplies the
# noise, so we want to hand it the crispest page we can.
SCAN_DPI, PRINT_DPI = 200, 300
SCAN_OUT_DPI = 150

FOOTER = "SYNTHETIC TEST DOCUMENT - NOT A PATIENT RECORD - TheraChart test fixture"


def font(name, pt, dpi):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), max(1, int(pt / 72.0 * dpi)))


# A real chart is a printed form with handwritten fills, so we need both.
def typeface(style, pt, dpi):
    return font({"b": "Courier New Bold.ttf",
                 "h": "Bradley Hand Bold.ttf"}.get(style, "Courier New.ttf"), pt, dpi)


def P(text):  return (text, "")     # printed
def B(text):  return (text, "b")    # printed bold (headings, form labels)
def Hd(text): return (text, "h")    # handwritten fill
def L(*segs): return list(segs)     # one line = left-to-right segments


def render_page(lines, rng, degrade=True):
    """lines: list of lines, each a list of (text, style) segments."""
    dpi = SCAN_DPI if degrade else PRINT_DPI
    W, H = int(PAGE_IN[0] * dpi), int(PAGE_IN[1] * dpi)
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    x0, y = int(0.75 * dpi), int(0.7 * dpi)
    lh = int(10.5 / 72.0 * dpi * 1.45)

    for segs in lines:
        x = x0
        # per-line jitter: real photocopies don't have perfectly aligned rows
        if degrade:
            x += rng.randint(-2, 2)
        for text, style in segs:
            if not text:
                continue
            pt = 12 if style == "h" else 10.5
            f = typeface(style, pt, dpi)
            if degrade:
                # handwriting sits heavier and wanders off the baseline
                ink = rng.randint(10, 40) if style == "h" else rng.randint(15, 65)
                dy = rng.randint(-3, 3) if style == "h" else 0
            else:
                ink, dy = 0, 0
            d.text((x, y + dy), text, font=f, fill=ink)
            x += d.textlength(text, font=f)
        y += lh

    if not degrade:
        d.text((x0, H - int(0.55 * dpi)), FOOTER, font=font("Courier New.ttf", 8, dpi), fill=110)
        return img

    # --- simulated photocopy artifacts ---
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

    img = img.resize((int(W * SCAN_OUT_DPI / dpi), int(H * SCAN_OUT_DPI / dpi)), Image.LANCZOS)

    # bake in the JPEG artifacts a real scanner would leave
    buf = io.BytesIO()
    img.convert("L").save(buf, "JPEG", quality=58)
    buf.seek(0)
    return Image.open(buf).convert("L")


def build(name, pages, degrade=True):
    rng = random.Random(20260728)
    imgs = [render_page(p, rng, degrade) for p in pages]
    path = os.path.join(OUT, name)
    imgs[0].save(path, "PDF", resolution=float(SCAN_OUT_DPI if degrade else PRINT_DPI),
                 save_all=True, append_images=imgs[1:])
    print(f"{name}: {len(imgs)} page(s), {os.path.getsize(path):,} bytes")


# ---------------------------------------------------------------- content --
# Ground truth for all three documents is the same clinical story, so one set
# of expectations in extract.js covers them: an eval on 05/02, a daily note on
# 05/09, a progress re-eval on 05/23, a discharge on 06/13.

PAGE_2VISIT = [
    L(B("BAYANIHAN PHYSICAL THERAPY CENTER")),
    L(P("PATIENT RECORD (photocopy)")),
    L(),
    L(P("Patient: REYES, JUAN   DOB: 04/12/1988")),
    L(P("Dx: R rotator cuff strain")),
    L(),
    L(B("INITIAL EVALUATION - 05/02/2023")),
    L(P("Therapist: R. Villanueva, PT")),
    L(P("S: Right shoulder pain 8/10 after lifting at work, worse")),
    L(P("   overhead. Denies numbness or tingling.")),
    L(P("O: Guarding noted. Shoulder flexion 95 degrees.")),
    L(P("   Abduction 85 degrees. MMT right shoulder abduction")),
    L(P("   3+/5. Positive Neer test.")),
    L(P("A: Findings consistent with right rotator cuff strain.")),
    L(P("P: PT 3x/week for 6 weeks - therex, manual therapy,")),
    L(P("   modalities.")),
    L(),
    L(B("DAILY TREATMENT NOTE - 05/09/2023")),
    L(P("Therapist: R. Villanueva, PT")),
    L(P("S: Pain improved to 5/10. Still sore reaching overhead.")),
    L(P("O: Shoulder flexion 115 degrees.")),
    L(P("Rx: Scaption raises 3x10, ER isometrics, posterior")),
    L(P("    capsule mobilization grade III, HEP reviewed.")),
    L(P("    Tolerated well.")),
]

# page 1 of the 4-visit chart is the 2-visit page with a page marker
PAGE_4A = [PAGE_2VISIT[0], L(P("PATIENT RECORD (photocopy)          Page 1 of 2"))] + PAGE_2VISIT[2:]

PAGE_4B = [
    L(B("BAYANIHAN PHYSICAL THERAPY CENTER")),
    L(P("PATIENT RECORD (photocopy)          Page 2 of 2")),
    L(),
    L(P("Patient: REYES, JUAN")),
    L(),
    L(B("PROGRESS RE-EVALUATION - 05/23/2023")),
    L(P("Therapist: M. Santos, PT")),
    L(P("S: Pain now 3/10 with overhead reach. Able to sleep on")),
    L(P("   the right side again. Returning to light duty.")),
    L(P("O: Shoulder flexion 150 degrees, abduction 140 degrees.")),
    L(P("   MMT right shoulder abduction 4/5. Negative Neer test.")),
    L(P("A: Good progress toward goals. Strength deficit remains.")),
    L(P("P: Continue 2x/week for 3 weeks, progress resistance.")),
    L(),
    L(B("DISCHARGE SUMMARY - 06/13/2023")),
    L(P("Therapist: M. Santos, PT")),
    L(P("S: Denies pain with daily activity. Occasional ache after")),
    L(P("   heavy overhead work, 1/10.")),
    L(P("O: Shoulder flexion 170 degrees, abduction 165 degrees.")),
    L(P("   MMT right shoulder abduction 5/5.")),
    L(P("A: Goals met. Patient independent with HEP.")),
    L(P("P: Discharge to independent home program. Follow up PRN.")),
]

# The realistic case: a preprinted form whose fills are handwritten. Same two
# visits as PAGE_2VISIT, so the same expectations apply.
PAGE_HAND = [
    L(B("BAYANIHAN PHYSICAL THERAPY CENTER")),
    L(P("TREATMENT RECORD")),
    L(),
    L(B("Patient: "), Hd("Reyes, Juan"), P("    "), B("DOB: "), Hd("04/12/1988")),
    L(B("Dx: "), Hd("R rotator cuff strain")),
    L(),
    L(B("VISIT TYPE: "), Hd("Initial Evaluation"), B("   DATE: "), Hd("05/02/2023")),
    L(B("Therapist: "), Hd("R. Villanueva, PT")),
    L(B("S: "), Hd("R shoulder pain 8/10 after lifting at work,")),
    L(P("   "), Hd("worse overhead. Denies numbness or tingling.")),
    L(B("O: "), Hd("Guarding noted. Shoulder flexion 95 deg,")),
    L(P("   "), Hd("abduction 85 deg. MMT R sh abduction 3+/5.")),
    L(P("   "), Hd("Neer test positive.")),
    L(B("A: "), Hd("Consistent with R rotator cuff strain.")),
    L(B("P: "), Hd("PT 3x/week x 6 weeks - therex, manual, modalities.")),
    L(),
    L(B("VISIT TYPE: "), Hd("Daily Treatment Note"), B("   DATE: "), Hd("05/09/2023")),
    L(B("Therapist: "), Hd("R. Villanueva, PT")),
    L(B("S: "), Hd("Pain improved to 5/10. Still sore overhead.")),
    L(B("O: "), Hd("Shoulder flexion 115 deg.")),
    L(B("Rx: "), Hd("Scaption raises 3x10, ER isometrics,")),
    L(P("    "), Hd("posterior capsule mob grade III, HEP reviewed.")),
]

# The register a Philippine clinic actually writes in. Everything the import
# path has to get right is here in a form the English fixtures cannot test:
# laterality written in Tagalog ("sa kaliwa", "kaliwang tuhod"), a denial in
# Tagalog ("walang pamamanhid"), a family history that must NOT become a
# finding on this patient ("nanay niya may arthritis"), and measurements that
# must stay measurements.
PAGE_TAGLISH = [
    L(B("BAYANIHAN PHYSICAL THERAPY CENTER")),
    L(P("PATIENT RECORD (photocopy)")),
    L(),
    L(P("Pasyente: DELA CRUZ, MARIA   DOB: 09/21/1974")),
    L(P("Dx: L knee osteoarthritis")),
    L(),
    L(B("INITIAL EVALUATION - 03/06/2023")),
    L(P("Therapist: J. Bautista, PT")),
    L(P("S: Masakit ang kaliwang tuhod, 7/10, mga 3 buwan na.")),
    L(P("   Mas masakit pag-akyat ng hagdan. Walang pamamanhid.")),
    L(P("   Ang nanay niya may arthritis din.")),
    L(P("O: Antalgic gait. Knee flexion 105 degrees sa kaliwa,")),
    L(P("   extension -10 degrees sa kaliwa.")),
    L(P("   MMT L quad 3+/5. Positive McMurray test.")),
    L(P("A: Consistent sa left knee osteoarthritis.")),
    L(P("P: PT 2x/week x 6 weeks - therex, modalities, HEP.")),
    L(),
    L(B("DAILY TREATMENT NOTE - 03/13/2023")),
    L(P("Therapist: J. Bautista, PT")),
    L(P("S: Bumuti na po, 4/10. Kaya ko na umakyat ng hagdan")),
    L(P("   nang dahan-dahan.")),
    L(P("O: Knee flexion 120 degrees sa kaliwa.")),
    L(P("Rx: Quad sets 3x10, SLR, hot pack 15 mins, HEP reviewed.")),
]

if __name__ == "__main__":
    printable = "--print" in sys.argv
    prefix = "print" if printable else "scan"
    build(f"{prefix}_2visit.pdf", [PAGE_2VISIT], degrade=not printable)
    build(f"{prefix}_4visit.pdf", [PAGE_4A, PAGE_4B], degrade=not printable)
    build(f"{prefix}_handwritten.pdf", [PAGE_HAND], degrade=not printable)
    build(f"{prefix}_taglish.pdf", [PAGE_TAGLISH], degrade=not printable)
    if printable:
        print("\nPrint these, then capture with a scanner or phone. Save the result as\n"
              "  real_<name>.pdf (or .jpg/.png) next to this script,\n"
              "and register it in test/eval/extract.js.")
