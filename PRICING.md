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

## What we can advertise

Priced at the **2027** rate, so January is a cost event and not a repricing.
Allowances are in AI-documented visits — the clinic's own unit, and the thing
that actually drives cost.

| Plan | Price | Seats | Included | Per seat |
|---|---|---|---|---|
| **Solo** | ₱3,900/mo | 1 | 250 visits | ₱3,900 |
| **Clinic** | ₱9,900/mo | 3 | 750 visits | ₱3,300 |
| **Group** | ₱17,900/mo | 6 | 1,600 visits | ₱2,983 |

Extra visits beyond the allowance: **₱15 each** (48% margin at the 2027 rate,
64% after the cuts below).

Gross margin at typical use (8 visits/day/seat):

| Plan | Today | Jan 2027 | After the cuts |
|---|---|---|---|
| Solo | 67% | 56% | 67% |
| Clinic | 68% | 55% | 68% |
| Group | 67% | 53% | 66% |

The allowances are set at ~11 visits/seat/day — comfortably above the 8/day
typical case, so a normal month never touches the overage and the number exists
as a runaway backstop rather than a revenue line. Even fully consumed, no plan
goes underwater.

For scale: a 3-therapist clinic billing ₱800 a visit turns over ~₱420,000 a
month. ₱9,900 is 2.4% of that. Practice-management software elsewhere runs
2–5% of collections, so this is not an aggressive ask.

## Two cost cuts worth making before publishing

Together these take a visit from ₱7.73 to ₱5.41 (−30%) and put a 75% margin
within reach at ₱4,300/seat instead of ₱5,900.

1. **Insights thinking `high` → `medium`.** The chart review is the single
   biggest AI line — ₱4.88 of the ₱7.73 visit. `ai.js` says explicitly not to
   lower a thinking level without re-running the eval. That is the point: there
   *is* an eval, with a 98.0% baseline in `test/eval/baseline.vertex.json`, so
   this is a measurable decision rather than a hopeful one. If the score holds,
   take it. If red flags degrade, don't — insights output is clinically
   consequential and that is not a margin trade.
2. **Stop re-running the chart review on every content change.** The fingerprint
   cache fixed the far worse "re-run on every chart opened" behaviour, but it
   still re-runs on every new note. Running it on demand plus on a new
   *evaluation* would cut it to a fraction of visits.

Two smaller ones, for completeness: the live-dictation path pays ~27s per visit
in per-request round-up (record-then-process already collapses this to ~6
events), and context caching at $0.075/1M would trim the fixed system prompts —
worth little, since input is a rounding error next to thinking.

## What is still un-metered

`/api/usage` covers Gemini and Speech-to-Text. It does **not** cover egress or
storage — and egress was the largest line in the cost model before response
compression landed (~9.5× on a 1,300-document clinic state). It is small now,
but `/api/state` returns the entire clinic record set on every revision bump, so
it grows with chart history and with device count. A delta/since-rev endpoint is
the structural fix; until then, treat the ~$5/mo storage-and-egress line here as
the least trustworthy number on the page.
