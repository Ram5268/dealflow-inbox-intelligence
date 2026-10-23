# valuation/dfval: DealFlow's monthly home-value model

**In plain English.** Once a month this gives every CRM seller's home DealFlow's own estimated
value and a range, from free city records. It learns from about three years of real Brooklyn and
Queens sales of 1–4 family homes, checks itself on the newest three months of sales, and sends the
values to DealFlow only if those checks pass. The values appear on Ryan's own CRM lead page and
nowhere a buyer or homeowner could see them (Ryan's decision, 2026-10-17). It never contacts
anyone, never reads a person's name, and never downloads anything itself: it reads the folder of
public records that `valuation/fetch` downloads.

## Run it

From the repo root, with Python 3.12:

```
pip install -r valuation/dfval/requirements.txt
python -m valuation.dfval run --data <folder written by valuation/fetch> --out <folder>             # dry run
VALUATION_IMPORT_SECRET=... python -m valuation.dfval run --data <folder> --out <folder> --publish  # publish if every gate passes
```

- A run reads the sellers to value from DealFlow's protected `GET /api/valuations/targets`, so even
  a dry run needs `VALUATION_IMPORT_SECRET`. A dry run never sends anything (`--dry-run` is the default).
- `<out>/summary.json` holds counts, accuracy, gate results, the matching scoreboard and one median
  value rounded to $10,000. Nothing per home: no contact ids, addresses or values (engineering
  precaution, Brief 44 §4). Exit code 3 means a `--publish` run ran but a gate failed, so nothing was published.
- `python -m valuation.dfval reproduce ...` is the local two-part reproduction check (below).

## Every month, on its own (Brief 49)

`.github/workflows/valuation-monthly.yml` runs the whole thing on GitHub Actions:

- **When:** 10:00 UTC on the 20th, after the city posts the month's sales (around the 15th). The
  run on the 23rd is the backup: it does nothing when DealFlow's public status page already shows
  values "as of" the 1st of this month, and otherwise tries again (a failed 20th, or one that still
  had last month's sales).
- **By hand:** Actions → valuation-monthly → Run workflow. Leave "publish" unticked for a dry run,
  which builds and checks everything and sends nothing.
- **Steps:** check free disk space; install the pinned versions (one environment for
  `valuation/fetch`, one for this package); run both test suites; decide what the run does
  (`python -m valuation.dfval plan`); download into the runner's temp folder (`valuation/fetch`,
  with the NYC Open Data key pair); `run` (with `--publish` on a publish run); print the summary
  (`python -m valuation.dfval summary`: counts and gate results only).
- **Red means the run needs a look.** A failed download, a failed gate (on a dry run too) or a
  failed request publishes nothing, and DealFlow keeps the last published values. Values are
  published only after every gate passed and every request succeeded; the summary says
  "Published: yes" when they were.
- **A publish run started by hand must use main** (engineering precaution: only reviewed code
  publishes); asked from another branch, it stops red before downloading anything.
- **What it keeps:** `summary.json` and the download's `manifest.json`, for 90 days: counts,
  accuracy numbers and one median rounded to $10,000. No home's value, address, tax lot or contact.
- **Secrets:** `NYC_SOCRATA_KEY_ID` and `NYC_SOCRATA_KEY_SECRET` go only to the download step
  (without them the download is anonymous); `VALUATION_IMPORT_SECRET` only to the valuation step.

## What a run does

1. **Sales.** DOF's 2003–2015 Excel files, then DOF annualized sales, then DOF rolling sales. The
   rolling file covers the last 12 months and the annualized file whole years, so they overlap; the
   cut-over is chosen each run as the first full month of the rolling file, and each sale comes from
   exactly one source. Tax-lot numbers are rebuilt from borough, block and lot (the city's own `bbl`
   column points condo sales at the billing lot).
2. **Deeds.** Each 1–4 family sale since July 2022 is matched to its ACRIS deed (Master + Legals
   only; the property's borough comes from Legals). Exact repeated rows in the city's files are
   dropped; repeated documents that differ in amount or share stay as candidates, and the sale's
   match picks the one agreeing with the DOF price, as the research did.
3. **Arm's-length screen, with no names** (Brief 44 revision 3): an ordinary deed for one lot and
   100% of the interest; a DOF price of at least $100,000 on one lot; and a price of at least 30% of
   the city's market value for that lot on the roll in effect before the sale.
4. **Inputs** (90): the research's model e (comparable sales, repeat sales, the city's value, lot and
   building measures, zoning, subway distance, alteration permits) plus condition clues from permits,
   job filings and violations, building footprints and 421-a. Each input uses only records dated
   before the sale (or before the as-of date, for a seller). The research's five inputs from
   homeowners' mortgage records (G6) are left out (Brief 44 revision 5, data minimization).
5. **Model.** Gradient-boosted trees on log price, one model per month trained only on earlier
   sales (at most 48 months back), exactly the research's "DealFlow model today".
6. **Range** (Ryan, 2026-10-04: one value and a range, sized to be right about 2 times in 3; no
   buttons, no confidence label). The half-width is chosen per group on the 12 months before the gate
   months: 2–4 family homes in Ryan's 8 neighborhoods, and everything else.
7. **Gates** (engineering precautions, Brief 44 §5), on the 3 newest months, out of sample: typical
   miss ≤ 11.5% for all homes and ≤ 14.5% for 2–4 family homes in the 8 neighborhoods; range coverage
   60–75%; at least 1,300 sellers valued. Any failure: the run is recorded and nothing is published,
   so DealFlow keeps the last published values.
8. **Sellers.** Each seller's tax lot comes from DealFlow's cached lot (from a published run), or a
   local match of the property address against PLUTO and DOF sales addresses (ZIP must agree).
   Homes the model doesn't cover get a reason: `five_plus_units`, `condo_without_unit`, `not_found`,
   `other_property_type`.
9. **The matching scoreboard** (Ryan, 2026-10-05: judge values by matching): on the gate months,
   400 simulated buyers per budget style, scored with DealFlow's live chance-of-fit rule
   (`lib/matching/sellerPrice.ts`): real matches found, the share of shown pairs that are real, and
   how well real buyers rank (AUC).
10. **Publish**: `start` → rows (200 per request) → `publish` on `POST /api/valuations/import`, with
    the payload checked against DealFlow's contract first (`contract.py`). No retries.

## Rules and where they come from

- No downloads in this package; it reads `valuation/fetch`'s folder (Brief 44 revisions 5–6).
- No person's name, ever: no ACRIS parties data and no PLUTO owner names (Ryan's decision,
  2026-10-17; Brief 44 revision 3). No mortgage, loan or tax-lien records (revision 5, data minimization).
- Free public data only; nothing bought, no listing site read (their terms forbid scraping).
- Nothing contacts anyone. The job holds no database credentials; it writes only through DealFlow's
  own protected address (engineering precaution, Brief 44 §5).

## Reproduction check (2026-10-18, Brief 44 §5)

Built from `valuation/fetch`'s download of 2026-10-18 and scored on the research's test year
(Sep 2025–Aug 2026). Within 10% / typical miss:

| | All homes | 2–4 family | Top-8 2–4 family |
|---|---|---|---|
| Research "DealFlow model today" (95 inputs) | 48.9% / 10.28% | 45.3% / 11.28% | 40.7% / 12.84% |
| This code on the research's saved tables, 95 inputs | identical, bit for bit | | |
| Same tables, 90 inputs (no mortgage records) | 48.7% / 10.31% | 44.6% / 11.43% | 41.1% / 12.97% |
| **Part 1**: fresh files, research's saved flags, the research's 11,434 test sales | **48.7% / 10.30%** | 44.5% / 11.52% | **40.7% / 12.72%** |
| **Part 2**: fresh files, no names, its own 12,635 test sales | 47.4% / 10.74% | 43.7% / 11.76% | 41.2% / 12.94% |
| Parts 1 and 2 on the 11,996 sales both score | 49.1% → 48.8% | 45.1% → 45.0% | 41.6% → 41.8% |

- Part 1 is within 1 point of the research on both segments the check names.
- The no-name screen catches few non-market sales: at the 30% cutoff, 84 of the 703 tuning-year sales
  the research flagged (family, same party, referee), while dropping 76 of 12,063 ordinary ones. Most
  of part 2's drop on its own test set comes from scoring those sales it can't recognize, not from
  worse values: on the same sales the cost is 0.3 points.
- The research's saved flags were used only here, locally, and never leave the research Mac.

## Tests

`python -m pytest valuation/dfval/tests` (no network; invented data only).
