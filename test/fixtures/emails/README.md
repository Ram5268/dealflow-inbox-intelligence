# Ingestion Fixture Set (Brief 6.0)

Hand-crafted email fixtures for validating the V2 extractor against a controlled,
repeatable set. This is the ingestion-side analog of Brief 5's chat isolation: it
lets us run the extractor over known inputs and produce an **honest baseline
accuracy report** — not a pass/fail gate. A category scoring 60% is a finding we
log, not something we tune fixtures to hide.

## What runs against these

`scripts/extractor-fixture-harness.ts` loads every `*.json` under
`test/fixtures/emails/<category>/`, and for each fixture:

1. Runs the **real gpt-4o-mini classifier** (`sourceClassifier`) on the fixture's
   subject/sender/body/attachment-names → predicted category + `needsDeepExtract`.
2. If `needsDeepExtract` is true and the predicted category has an extraction spec
   (everything except `NOISE`), builds the extractor context with the **real
   `buildContext()`** and runs the **real Sonnet extraction** via `runExtraction()`
   — the same functions `extractEmailV2` uses in production. No DB writes.
3. Diffs the extracted `OppRowData` against the fixture's `expected` block,
   field by field, and records per-fixture cost.

The harness never touches Postgres, Qdrant, LlamaParse, or vision in its default
mode. Attachments are supplied as **pre-parsed text** (`parsedText`) — the text a
parser *would* yield — because the extraction step consumes assembled text, not
raw bytes. (Real binary parsing of PDFs is spot-checked separately; see
"Attachments" below.)

## Harness architecture note (why pre-parsed text)

The production extractor reads `DocumentChunk` rows written by the ingestion
pipeline, and DOCX/XLSX parsing is **not implemented yet** (`processAttachments`
defers them — a Brief 6.2 gap). So the default harness tests the *extraction*
step given parsed input. A small opt-in subset of PDF fixtures (`--attachments-live`)
runs the true LlamaParse path end-to-end to spot-check binary parsing. See
`project_ingestion_harness_arch` in memory for the full decision.

## Fixture format

Each fixture is one JSON file: `test/fixtures/emails/<category>/<slug>.json`.

```jsonc
{
  "id": "coming_soon_sale_01_park_slope_townhouse",   // unique, matches filename stem
  "notes": "Broker blast, standard format, single listing",
  "edgeCase": false,                                    // true = the deliberately-hard fixture for its category

  "input": {
    "subject": "COMING SOON | 461 6th St, Park Slope | 2BR $1.75M",
    "from": { "name": "Jane Smith", "email": "jane.smith@compass.com" },
    "receivedAt": "2026-08-05T14:32:00Z",
    "bodyText": "Hi all,\n\nI have a coming soon listing at 461 6th St...",
    "bodyHtml": null,                                    // realistic HTML string, or null
    "attachments": [
      {
        "filename": "hotsheet.pdf",
        "mimeType": "application/pdf",
        "parsedText": "461 6th St, Park Slope | 2BR/1BA | $1,750,000 | ...",
        "live": false,                                   // true => real binary parsed via LlamaParse under --attachments-live
        "file": null                                     // companion binary path (relative to test/fixtures/attachments/) when live
      }
    ]
  },

  "expected": {
    "category": "COMING_SOON_SALE",                     // MANDATORY — one of the 20 CLAUDE.md categories
    "address": "461 6th St",                            // null when truly absent/ambiguous (never hallucinate)
    "neighborhood": "Park Slope",
    "borough": "Brooklyn",
    "beds": 2,
    "price": 1750000,
    "propertyType": null,                               // graded vs the LLM's raw output (NYC enrichment is not run in the harness)
    "confidenceScoreMin": 0.7,                          // extracted confidenceScore must be >= this
    "classificationReasonThemes": ["coming soon", "sale"], // case-insensitive substrings expected in classificationReason
    "shouldExtractParty": false,                        // true for BUYER_ISO / RENTER_INQUIRY / SELLER_LEAD / LANDLORD_LEAD
    "expectedMultipleOpportunities": null               // integer N for multi-listing emails; null otherwise
  }
}
```

### `expected` field rules (mirrors the harness diff)

| field | rule |
|---|---|
| `category` | exact match (predicted classifier category) |
| `address` | whitespace/case-normalized substring match ("461 6th St" ≈ "461 6th Street") |
| `neighborhood` | case-insensitive, abbreviation-normalized ("WV" ≈ "West Village") |
| `borough` | exact after case-normalization |
| `beds` | exact number |
| `price` | exact, or within ±$5000 |
| `propertyType` | exact match, or both null |
| `confidenceScoreMin` | extracted `confidenceScore` ≥ this |
| `classificationReasonThemes` | every substring appears in `classificationReason` (case-insensitive) |
| `shouldExtractParty` | derived from extracted `clientSide` / category |
| `expectedMultipleOpportunities` | extractor produced exactly N rows |

### Grading convention for `expected` (READ THIS — it defines what the report means)

- **`category` is mandatory** and always graded.
- **Include a scalar field only when you want it graded.** A field you **omit** is
  not graded for that fixture. So on a listing whose property type the email states
  only vaguely ("classic brownstone"), just omit `propertyType` rather than guess.
- **A field set to `null` is a non-hallucination assertion**: the extractor MUST NOT
  produce a value. Use this deliberately for identity fields where *leakage* is the
  risk — e.g. a BUYER_ISO must not emit an `address` (the buyer is looking, not
  selling); a vague "townhouse in the West 70s" must not invent a street number.
  Do **not** null-out soft fields just because they're absent — omit them instead.
- **Multi-listing fixtures**: set `expectedMultipleOpportunities` to the row count
  and grade `category` (+ optionally `borough`) only — omit the per-listing scalars,
  since a single top-level `address`/`price` can't represent N listings. When
  `expectedMultipleOpportunities` is omitted, the harness grades scalar fields
  against the single extracted opportunity.

Per CLAUDE.md's "never hallucinate missing real estate data" rule, a graded `null`
is a first-class correct answer, and asserting it is how we catch leakage.

## Coverage matrix (target: 85–100 fixtures, ≥15 with attachments)

| Category | Min fixtures | Attachment fixtures |
|---|---|---|
| COMING_SOON_SALE | 6 | 2 (PDF hotsheet, HTML table) |
| COMING_SOON_RENTAL | 5 | 1 (xlsx rental sheet, pre-parsed) |
| OFF_MARKET_SALE | 5 | 1 (image screenshot, pre-parsed caption) |
| ACTIVE_SALE_LISTING | 5 | 1 (PDF flyer) |
| RENTAL_LISTING | 6 | 2 (xlsx from mgmt co, HTML w/ photos) |
| BUYER_ISO | 6 | 1 (docx buyer profile, pre-parsed) |
| RENTER_INQUIRY | 5 | 0 |
| SELLER_LEAD | 4 | 0 |
| LANDLORD_LEAD | 4 | 0 |
| DEVELOPMENT_INVENTORY | 5 | 2 (PDF offering-plan snippet, xlsx unit avail) |
| COMING_SOON_DEVELOPMENT | 4 | 1 (PDF renderings, pre-parsed) |
| SPONSOR_UNIT | 3 | 1 (PDF sponsor unit sheet) |
| OPEN_HOUSE | 4 | 0 |
| PRICE_DROP | 4 | 0 |
| BACK_ON_MARKET | 3 | 0 |
| MARKET_REPORT | 3 | 1 (PDF market report) |
| REAL_ESTATE_EVENT | 3 | 1 (image invite, pre-parsed) |
| CLIENT_CONVERSATION | 5 | 1 (forwarded chain) |
| SHOWING_CONFIRMATION | 4 | 0 |
| NOISE | 8 | 2 (irrelevant PDF, spam HTML) |
| **Total** | **~92** | **~20** |

Every category has ≥3 fixtures including ≥1 `edgeCase: true`.

## How to add a fixture

1. Pick the category dir. Name the file `<category>_NN_<short_slug>.json`.
2. Set `id` to the filename stem. Write a realistic `input` (see flavor rules below).
3. Fill `expected` with ground truth; `null` where data is genuinely absent.
4. Validate: `npx tsx scripts/extractor-fixture-harness.ts --filter <category> --dry-run`
   (`--dry-run` loads + validates fixtures and runs the classifier only — no Sonnet cost).

### Flavor rules (realism is the deliverable)

- NYC-specific: neighborhood nicknames (WV, UWS, DUMBO, LES, LIC, WBurg, FiDi),
  "$1.5M", "$8k/mo", "co-broke", "off-market", "below 96th".
- Sender variety: Compass/Corcoran/Elliman/Serhant agents, property-mgmt bulk
  senders, hotsheet auto-mailers, landlords, sponsors, event coordinators.
- Format quirks: ALL-CAPS subjects, subject-only info dumps, plain vs HTML,
  multi-listing tables, forwarded chains with `>` quotes, typos.
- ≥1 edge case per category (vague address, price only in attachment, borderline
  category, quoted-signature leakage, ambiguous PRICE_DROP-vs-new-listing, etc.).
- Attachments carry data the body does NOT, forcing the extractor to read them.

## Running the harness

```bash
# Full default run (Sonnet-only, ~$5-7, hard-stops at $10):
npx tsx scripts/extractor-fixture-harness.ts

# Subset by category (cheap iteration):
npx tsx scripts/extractor-fixture-harness.ts --filter rental_listing

# Validate fixtures + classifier only, no Sonnet spend:
npx tsx scripts/extractor-fixture-harness.ts --dry-run

# Include the real-binary PDF spot-check subset:
npx tsx scripts/extractor-fixture-harness.ts --attachments-live

# Lower the hard cost ceiling for a careful first run:
npx tsx scripts/extractor-fixture-harness.ts --budget 3
```

The report prints per-category + per-field accuracy and per-fixture cost, and is
also written to `test/fixtures/last-run-report.json` (git-ignored).
