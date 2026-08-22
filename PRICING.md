# What a visit costs, and what we can charge for one

Companion to `pricing-model.js` (`node pricing-model.js` prints every figure
below). This file holds the reasoning; the script holds the arithmetic, so a
rate change is one edit rather than a rewrite.

Neither is served to the browser — `server.js` serves an allowlist
(`isClientAsset`), and both are excluded from the deploy. Commercial figures
must not ship with the app.

> **Read this first.** Every number here is still a *model*. The metering that
> landed on 2026-08-16 records real Gemini tokens and real billed STT seconds
> per clinic per day at `/api/usage`, but no clinic has generated a week of
> real traffic yet. Three inputs — answer tokens, how deep the "high" thinking
> path actually goes, and how many minutes a therapist really dictates — are
> estimated, and they are the three that move the answer most. Re-run the model
> against `/api/usage` before publishing a price.

## Where the money goes

Prices are list, dated, and applied at read time in `/api/usage` so a rate
change re-prices history instead of leaving it stale.

| Line | Rate | Source |
|---|---|---|
| Speech-to-Text v2, standard tier | **$0.016/min** | Chirp and Chirp 2 carry no premium on v2. Dynamic batch is $0.003/min but "within 24 hours", which fails the in-the-room requirement. Volume tiers reach ~$0.004/min at 2M+ min/mo — roughly 4,000 seats away. |
| Gemini 3.7 Flash, to 2026-12-31 | **$0.75 / $3.75** per 1M in/out | Introductory. Thinking bills as output. |
| Gemini 3.7 Flash, from 2027-01-01 | **$1.50 / $7.50** per 1M in/out | **Price for this one.** It doubles the AI line on New Year's Day. |
| Cloud SQL + Cloud Run + storage | ~$55/mo for the whole stack | Cloud SQL is always-on and dominates; Cloud Run scales to zero. |

FX: ₱61.5 = $1 (mid-August 2026).

Prompt sizes are **measured** against the real builders in `ai.js` /
`insights.js`: refine is 1,484 tokens on a 73-line transcript, insights is
2,651 on a 12-visit chart plus a digest of 20 older visits. Thinking is
measured too — `ai.js` records ~2.3k tokens at `medium` and "up to ~7k" at
`high`. Answer tokens and the true depth of `high` are the estimated band.

## One documented visit

A visit costs dictation minutes plus two Gemini calls: `refine` (the transcript
cleanup, `medium` thinking) and `insights` (the chart review, `high` thinking,
which re-runs when a new note changes the chart).

Modelled at 2.9 billed dictation minutes — one 6-minute evaluation per eight
2.5-minute daily notes. *Billed* means voiced audio only; silence is dropped
before it is ever submitted.

| | Dictation | AI | Total | Dictation's share |
|---|---|---|---|---|
| Today (intro rate) | ₱2.84 | ₱1.82 – ₱3.20 | **₱4.66 – ₱6.05** | 47–61% |
| From January (list rate) | ₱2.84 | ₱3.64 – ₱6.41 | **₱6.48 – ₱9.25** | 31–44% |

**Dictation is about half the variable cost, not most of it** — and from
January it is the *smaller* half. That is a change from where we started
yesterday, and it has two causes: the voice gate removed the silence that used
to make STT the whole bill, and `GOOGLE_SETUP.md` was quoting Speech-to-Text v1
prices ($0.024–$0.064/min) for a codebase that calls v2 at $0.016. Corrected
there.

Dictation stays the line worth *watching* even so, because it is the only one a
human controls in the moment. The AI cost per note is fixed; the dictation cost
is whatever someone leaves the microphone recording.

## Per seat, per month (22 working days, 2027 rate)

| Visits/day | Visits/mo | Variable cost | Billed dictation |
|---|---|---|---|
| 6 | 132 | ₱855 – ₱1,221 | 381 min |
| 8 | 176 | ₱1,141 – ₱1,628 | 508 min |
| 12 | 264 | ₱1,711 – ₱2,442 | 763 min |

At 8 visits/day, COGS is **₱1,473/seat/month** including an infrastructure
share. That is the floor everything else is built on:

| Gross margin | Price per seat |
|---|---|
| 60% | ₱3,700 |
| 70% | ₱5,000 |
| 75% | ₱5,900 |
| 80% | ₱7,400 |
| 85% | ₱9,900 |

Software-business margins (80%+) want ₱7,400/seat. That is almost certainly
above what a Philippine PT clinic will pay. The gap is the actual pricing
problem, and it closes from both ends: charge nearer ₱3,500–5,000, and cut
COGS.

## What we sell

**Repriced 2026-08-21.** This section previously described a three-rung,
per-seat ladder the product had already stopped selling. The shipped ladder is
**per clinic**, has four rungs, and meters **two** things — visits *and* a
monthly dictation pool. It lives in two places, both authoritative:

- `app.js` → `renderLanding()` — the tiers a customer reads and buys
- `store.js` → `DEFAULT_SETTINGS` — the allowance and overage rates the app meters

`pricing-model.js` mirrors both and **fails with a non-zero exit** if its copy
drifts from either. A confident margin computed for a price nobody is charged is
worse than no model.

| Plan | Price | Was | Visits | Per visit | Dictation pool |
|---|---|---|---|---|---|
| **Solo** | ₱3,450/mo | ₱2,450 | 130 | ₱26.54 | 780 min |
| **Practice** | ₱6,700/mo | ₱4,700 | 260 | ₱25.77 | 1,560 min |
| **Clinic** | ₱10,900/mo | ₱7,900 | 450 | ₱24.22 | 2,700 min |
| **Group** | ₱32,900/mo | ₱24,900 | 1,450 | ₱22.69 | 8,700 min |

Overage: **₱42 per extra visit** (was ₱28), **₱7 per extra dictation minute**
(was ₱3). The pool is **6 minutes × included visits** (was 10), granted in full
on the 1st, never enforced — only shown.

Practice is ₱6,700 rather than the ₱6,900 a 70% target would ask for, because
**every rung has to be cheaper per visit than the one below it** — at ₱6,900 it
landed on ₱26.54, exactly Solo's rate, so upgrading bought capacity and no
better price. `test/allowance.test.js` pins that as an invariant.

### Why these numbers

Three things moved together, because fixing any one alone left the business
thin:

1. **The pool went 10 → 6 minutes.** At the January rate, break-even on the
   entry plan was **10.4 dictation minutes a visit** and the plan promised 10.
   A clinic using what it had been *sold* left a 2% gross margin. Six is still
   more than twice the 2.9 min/visit the model assumes, so nobody documenting
   normally will ever see it.
2. **The chart review stopped re-running on every keystroke.** See below.
3. **Prices rose 33–41%.** The old ladder sat at 2.1–2.4% of a clinic's
   collections; practice software elsewhere runs 2–5%. The new one sits at
   **2.84–3.32%** at a ₱800 visit — still inside the norm, and TheraChart is
   doing something the non-AI EMRs in this market are not.

   > That band was first written here, and in the repricing commit, as
   > "2.9–3.9%". It never was. The figure came from the *target* prices
   > computed before Solo was pulled down to ₱3,450 and Practice to ₱6,700,
   > and it is arithmetically impossible for the shipped ladder at any visit
   > fee: the ladder's own per-visit spread is 1.17× and a 2.9–3.9% band is
   > 1.34×. `node pricing-model.js` now prints the real band from the real
   > prices, at four visit fees, so the number cannot be transcribed by hand
   > again. The correction matters commercially rather than pedantically —
   > 3.9% is the top of the norm and 3.3% is the middle of it.

Solo is deliberately priced to a **65%** target rather than 70%: it is the rung
where price sensitivity is highest and the one clinics grow out of, and its
margin is hurt most by fixed infrastructure spread over only 130 visits.

### Where the margins land

Gross margin at the January 2027 rate — the hard case, since it doubles the
Gemini line:

| Plan | Typical (75% of allowance, 2.9 min) | Allowance maxed | Everything maxed |
|---|---|---|---|
| Solo | **69%** | 62% | 50% |
| Practice | **73%** | 65% | 54% |
| Clinic | **73%** | 66% | 53% |
| Group | **74%** | 66% | 52% |

At today's introductory rate every figure is 6–9 points higher. The right-hand
column is the one that matters commercially: **a clinic consuming every visit
and every dictation minute it was sold still leaves us better than half.**
Before this repricing that column read 2–6%.

### The overage rates are a matched pair, not two numbers

Three constraints decide them together, and only a pair satisfies all three:

1. **They must agree with each other.** An extra visit arrives with its
   dictation allowance priced in, so `overagePerVisit ÷ fairUseMinutesPerVisit`
   has to land on `overagePerMinute` — otherwise the same overrun costs a
   different amount depending on which meter happened to notice it.
2. **The visit rate must clear the entry plan's own per-visit rate** (₱26.54),
   or a clinic is better off sitting on overage than moving up a rung.
3. **Both must carry the margin the plans carry.**

₱42 over a 6-minute pool is exactly ₱7 a minute, clears ₱26.54, and carries
**75% and 86%** at the January rate against a real cost of ₱10.65 a visit and
₱0.98 a minute. ₱28/₱3 was set against a 10-minute pool and an ₱18.85 visit;
when both of those moved it broke (2) and (3) at once.

> A side-effect worth knowing about: because the two rates now agree *exactly*,
> six minutes of overrun and one extra visit both come to ₱42. Two tests used
> to tell those billing paths apart by their totals and can no longer — they
> assert the *unit* now (`overBy` vs `excessMinutes`) instead.

## Market position — what clinics actually pay

Researched 2026-08-21. Everything below is a published list price with a
source; where a number is inferred it says so.

### The Philippine anchor is ₱1,500, and it is not us

Two competitors sell clinic software into this market at the same price:

| Product | Price | What it is |
|---|---|---|
| [DoktorEMR](https://doktoremr.com/pricing/) | **₱1,500/mo** | 2 users (1 doctor, 1 secretary). Records, scheduling, labs, prescriptions, and **voice-to-text for notes**. |
| [ClinicEMR — Med Core Solutions](https://www.medcore.solutions/) | **₱1,500/mo** | SOAP charting, PhilHealth YAKAP, eKon replacement, offline mode, booking. |

**This, not the percentage, is the number that decides a deal.** Our entry rung
is ₱3,450 — **2.3× the anchor** — and no argument about shares of collections
survives contact with a ₱1,500 quote on the next tab. Two things about it:

- **DoktorEMR already advertises voice-to-text.** "We have dictation and they
  do not" is *false* and must not be said to a prospect who has seen their
  page. What is true is narrower and has to be demonstrated rather than
  asserted: their feature turns speech into text in a box. Ours decides which
  *section* a sentence belongs in, files ROM/MMT/pain into a measurement table,
  pins the body map, keeps the patient's words separate from the clinician's,
  and does it across Tagalog and Cebuano in one sentence. That is the entire
  pitch, and Kim's testing is what proves or kills it.
- **₱1,500 buys 2 users.** Our ladder is per clinic with unlimited staff, so a
  4-person clinic on DoktorEMR is likely paying more than the sticker suggests.
  Worth confirming before quoting it as a comparison.

### What the AI part is worth, priced elsewhere

AI documentation is not a free feature anywhere else. Standalone AI scribes,
**with no EMR attached**, at [published self-serve
rates](https://www.commure.com/blog-scribe/scribe-pricing):

| Tier | Per clinician / month | In pesos |
|---|---|---|
| Self-serve (Freed, Commure, Heidi) | $39 – $119 | ₱2,400 – ₱7,300 |
| [Heidi Health](https://www.getfreed.ai/resources/cost-of-ai-scribes) clinician / practice | $110 / $180 | ₱6,765 / ₱11,070 |
| Abridge (enterprise) | $208 – $600 | ₱12,800 – ₱36,900 |

**Our entire Solo plan — EMR, body map, billing, scheduling and the AI — is
₱3,450, or about $56.** That is inside the range people pay for the scribe
alone. It is a real argument, with the obvious caveat that these are US prices
and Philippine willingness to pay is structurally lower; it establishes that
the AI has priced value, not that a Manila clinic will pay US rates for it.

### The visit fee, which the whole percentage argument rests on

`VISIT_FEE_PHP = 800` is the assumption, and it holds for the middle of the
market but **not for the bottom**:

| Setting | Per session | Source |
|---|---|---|
| Clinic-based PT | ₱500 – ₱1,500 | [ClinicFinderPH](https://www.clinicfinderph.com/blog/physical-therapy-cost-philippines) |
| Metro Manila | ₱800 – ₱2,500 | [ClinicFinderPH](https://www.clinicfinderph.com/blog/best-physical-therapy-clinics-manila) |
| Makati | ₱600 – ₱2,000 | [ClinicFinderPH](https://www.clinicfinderph.com/blog/physical-therapy-clinics-makati) |
| Pampanga (provincial) | ₱400 – ₱1,200 | [ClinicFinderPH](https://www.clinicfinderph.com/blog/physical-therapy-clinics-pampanga) |
| Government (POC) | ₱300 – ₱700 | [ClinicFinderPH](https://www.clinicfinderph.com/blog/philippine-orthopedic-center-rates-fees) |

So the shipped ladder reads **2.84–3.32% in Manila and 4.42% for a provincial
clinic billing ₱600** — at the very top of the 2–5% norm, and above it at ₱500.
`pricing-model.js` prints the band at four fees for exactly this reason. **The
pricing problem is regional, not global**, and the fix for it is a regional
rung or a negotiated rate, not moving the whole ladder down.

### The argument that actually works: hours, not percentages

A Philippine PT earns [₱19,000–₱23,000 a month, about
₱231/hour](https://ph.jobstreet.com/career-advice/role/physical-therapist/salary).

- Solo at ₱3,450 costs **about 15 hours of therapist time a month**. It pays
  for itself if it saves more than ~40 minutes of charting a day.
- The gap to a ₱1,500 competitor is ₱1,950, or **8.4 hours a month**. That is
  the real question a clinic owner is asking, and it is answerable — but only
  with evidence from a working therapist, which is question 7 in Kim's test
  email.
- At ₱800 a visit, one extra patient a day is ₱17,600 a month. If the AI buys
  back enough evening admin to add even one slot, the subscription is a
  rounding error against it. **This is the pitch.** Do not lead with 3.3%.

## What the AI actually costs, by feature

`pricing-model.js` costed only `refine` and `insights` until 2026-08-21. Both
`patient-assistant` and `extract-doc` also call Gemini, and neither was in the
model, so the model was costing a product we do not sell. `/api/usage` already
meters every Gemini call regardless of endpoint, so the *metering* was never
wrong; only the forecast was.

At the 2027 rate, base band, per documented visit:

| Feature the clinic sees | Line | Cost | Share |
|---|---|---|---|
| Listen & dictate live | Speech-to-Text v2 | ₱2.84 | 37% |
| Review & clean up with AI | Gemini refine | ₱1.86 | 24% |
| Clinical insights card | Gemini insights | ₱1.78 | 23% |
| Grounded AI assistant | Gemini assistant | ₱0.95 | 13% |
| Import an outside document | Gemini extract-doc | ₱0.16 | 2% |
| | **Total** | **₱7.59** | |

The assistant and import *frequencies* are estimated (a question every third
visit, an import every twentieth); their per-call costs are not. They are the
next two numbers `/api/usage` settles.

**Dictation is the largest single line again, at 37%.** It stopped being the
dominant cost when the voice gate removed the silence, and the chart review
overtook it; both cuts below have now put it back in front. AI in total is 63%
of a visit and dictation 37%.

> An earlier version of this file said the chart review was "55% of the variable
> cost". That was wrong — it was refine and insights added together, from before
> the table separated them.

## The two cost cuts — both now made

Together they took a visit from ₱13.38 to ₱7.59.

### 1. The chart review re-ran on every keystroke — **fixed**

`chartReviewKey()` hashed every document's modification stamp, drafts included,
and a draft autosaves on each keystroke. So typing a sentence and then glancing
at the Overview tab fired a full chart review, and doing that two or three times
in a visit paid for it two or three times — for one visit. The model always
assumed **one** run per visit, which made this the most expensive kind of error:
not a wrong price, a wrong *count*, invisible on the invoice.

The key is now built from **signed** documents only. It fires when a note is
signed, amended or removed, and when the patient facts that reach the prompt
change — never while a note is being written. The draft is still *read* when the
review runs; this decides only *when*, not *what*.

The one thing that loses: a review can now be correct about the record and not
know about today's unsigned dictation. That is said on the card, beside the
Re-run button, rather than left for the therapist to discover.
`test/reviewtrigger.test.js` pins both halves — cost control and honesty.

At ~2.5 runs/visit before, this alone was **₱4.54 a visit**, or ₱2,044 a month
across a 450-visit clinic.

### 2. Insights thinking `high` → `medium` — **taken, on evidence**

`ai.js` said not to lower this without re-running the eval. It was re-run:

| | insights/declining-rom | red-flag-screen | radicular | first-visit | overall |
|---|---|---|---|---|---|
| `high`, 3 runs | 100% | 100% | 100% | 100% | **100.0%** |
| `medium`, 3 runs | 100% | 100% | 100% | 100% | **100.0%** |

Against Vertex, twelve calls each, no fallbacks in either. Identical output at
**41% less** — insights ₱3.03 → ₱1.78 a visit.

Caveat worth keeping: this is four cases. The red-flag screen is the clinically
consequential one and it scored full marks at both levels, but if the insights
prompt or schema changes materially, re-run the comparison rather than assuming
it still holds. The command is in the comment at the call site in `ai.js`.

> A separate lesson from that session: **a single eval run is noisy.** One
> refine case swung 35 points between two runs at an identical configuration.
> Use `--runs 3` for any decision, and check `FELL BACK` is absent — a 429
> silently scores the local heuristic and drags the number down.

### Still available, not taken

The live-dictation path pays ~27s per visit in per-request round-up
(record-then-process already collapses this to ~6 events), and context caching
at $0.075/1M would trim the fixed system prompts — worth little, since input is
a rounding error next to thinking.

## What is still un-metered

`/api/usage` covers Gemini and Speech-to-Text. It does **not** cover egress or
storage — and egress was the largest line in the cost model before response
compression landed (~9.5× on a 1,300-document clinic state). It is small now,
but `/api/state` returns the entire clinic record set on every revision bump, so
it grows with chart history and with device count. A delta/since-rev endpoint is
the structural fix; until then, treat the ~$5/mo storage-and-egress line here as
the least trustworthy number on the page.
