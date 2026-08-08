# Brief 6.2 — Adversarial Fixture Report

**Question this answers:** *Where does the extractor confidently fail?*

**Run:** full harness, 93 existing + 25 adversarial = **118 fixtures**, real gpt-4o-mini
classifier + real Sonnet 4.6 extraction. **Cost $1.22** (hard cap $3). tsc clean, no
extractor/grader/schema changes — additions only, in `test/fixtures/emails/adversarial/`.

Headline numbers (full run):
- Classifier accuracy: **102/118 (86%)**
- Overall field accuracy: **92.3%** (15 normalization rescues, 1 ambiguity excluded)
- Adversarial bucket: **19/25 category (76%)**, 81% field acc

The adversarial set is diagnostic, not a gate. Six category misses and three field
misses are real signal; four of the nine "misses" are defensible or harness artifacts
(explained below). The extractor is **robust** on the mechanical traps (slang, price
formats, address restraint, multi-listing) and **confidently fails on one coherent
cluster**: recovering a real lead/listing that is buried inside informational-looking
text — the same CLIENT_CONVERSATION/informational boundary already flagged in
`KNOWN_ISSUES.md`. Brief 6.2 turns that tripwire from a hypothesis into evidence.

---

## Before / after — per-category accuracy

The 25 adversarial fixtures live in their own `adversarial/` directory, so the 93
existing fixtures' inputs are byte-identical. Their per-category numbers **reproduced
the Brief 6.0/6.1 baseline** (LLM nondeterminism aside), confirming the additions
didn't disturb anything:

| Category | This run (field acc) | Baseline (6.0/6.1) |
|---|---|---|
| ACTIVE_SALE_LISTING | 100% | ~100% |
| BUYER_ISO | 100% | ~100% |
| CLIENT_CONVERSATION | 1/6 cls · 58% | 1/6 · ~58% (matches KNOWN_ISSUES) |
| COMING_SOON_SALE | 5/6 cls · 97% | ~97% |
| DEVELOPMENT_INVENTORY | 97% | ~97% |
| NOISE | 8/8 · 100% | ~100% |
| PRICE_DROP / SELLER_LEAD / SPONSOR_UNIT / SHOWING / OFF_MARKET / RENTER_INQUIRY | 100% | ~100% |
| RENTAL_LISTING | 5/6 cls · 90% | ~90% |
| REAL_ESTATE_EVENT | 2/3 · 89% | ~89% |
| **ADVERSARIAL (new)** | **19/25 cls · 81%** | — |

No regression introduced. The one pre-existing weak spot (CLIENT_CONVERSATION) is
exactly what the adversarial buried-lead fixtures probe from a new angle.

---

## Per-adversarial-fixture results

✅ PASS = graded fields all correct · ⚠️ = defensible/soft · ❌ = real failure

| Fixture | Result | Classifier (conf) | Note |
|---|---|---|---|
| **Address** | | | |
| adv_addr_no_suffix | ✅ | ACTIVE_SALE (0.90) | "45 East 89th" captured w/o suffix |
| adv_addr_building_name | ✅ | ACTIVE_SALE (0.90) | "The Astoria" → address **and** neighborhood null; **did not** leak Queens/Astoria |
| adv_addr_numeric_unit_suffix | ✅ | ACTIVE_SALE (0.90) | beds=1, not 14A→14; address clean |
| adv_addr_cross_street | ❌ | COMING_SOON (0.90) | **wrote "5th Avenue & 82nd Street" into address (conf 0.88)** instead of null |
| **Price** | | | |
| adv_price_abbrev_m | ✅ | ACTIVE_SALE (0.90) | "$1.9M" → 1,900,000 |
| adv_price_annual_rent | ✅ | RENTAL (0.90) | "$54,000/yr" → **$4,500/mo** (converted correctly) |
| adv_price_upper_bound_only | ✅ | BUYER_ISO (0.90) | "under $2M" → demand-side, no address leak |
| adv_price_range_only | ⚠️ | ACTIVE_SALE (0.90) | "$1.8–2.1M" → price **null** (conservative; no fabrication). Expected low-anchor 1.8M |
| **Slang** | | | |
| adv_slang_junior_4 | ✅ | RENTAL (0.90) | "Junior 4" → **1 bed** (not 4) |
| adv_slang_classic_6 | ✅ | ACTIVE_SALE (0.90) | "Classic 6" → **2 beds** (not 6) |
| adv_slang_3plus1 | ✅ | ACTIVE_SALE (0.90) | "3+1" → **3 beds** (not 4) |
| **Multi-listing** | | | |
| adv_multi_two_comparison | ✅ | ACTIVE_SALE (0.90) | 2 opportunities |
| adv_multi_forward_chain_3 | ✅ | ACTIVE_SALE (0.90) | **3 opportunities pulled from a quoted reply chain** |
| adv_multi_html_table_10 | ❌ | COMING_SOON_DEVELOPMENT (0.90) | extracted all **9 rows** (count ✓) but labeled the 9-unit resale hotsheet as *development* |
| **Mixed intent** | | | |
| adv_intent_buyer_asks_comingsoon | ✅ | BUYER_ISO (0.90) | not fooled by "coming soon" wording |
| adv_intent_colleague_buyer | ✅ | BUYER_ISO (0.90) | third-party framing handled |
| adv_intent_info_plus_seller_lead | ❌ | **NOISE (0.95)** | buried seller lead dropped entirely — no extraction |
| **Buried signal** | | | |
| adv_buried_budget_bump | ⚠️ | CLIENT_CONVERSATION (0.90) | **caught** the buried $2.2M/West Village (in row[1]); 50% score is a grader-primary-row artifact |
| adv_buried_thankyou_future_listing | ❌ | CLIENT_CONVERSATION (0.90) | future-seller intent → informational; clientSide mislabeled **buyer** |
| adv_buried_newsletter_listing | ❌ | MARKET_REPORT (0.90) | genuine exclusive at newsletter bottom → not extracted |
| **Deceptive historical** | | | |
| adv_hist_past_purchase_price | ✅ | NOISE (0.95) | "$1.8M for my last place" → NOISE; **no** fabricated listing |
| adv_hist_sold_comp_forward | ❌ | **SELLER_LEAD (0.90)** | sold comp → **phantom seller lead** (see below) |
| **Category boundary** | | | |
| adv_boundary_comingsoon_vs_active | ✅ | COMING_SOON (0.90) | "hitting the market Monday" → coming soon |
| adv_boundary_pricedrop_vs_active | ⚠️ | PRICE_DROP (0.90) | core correct (PRICE_DROP + **new** $2.2M, not old $2.5M); nbhd Flatiron vs Union Sq (both defensible) |
| adv_boundary_openhouse_vs_comingsoon | ⚠️ | COMING_SOON (0.90) | picked COMING_SOON over OPEN_HOUSE — defensible for a pre-public preview |

---

## Where it confidently fails — grouped by weak-spot bucket

### 1. Buried / informational leads are lost or invented (the big one)

Every failure here fires at **classifier confidence 0.90–0.95** — the model is not
hesitating, it is confidently wrong. All four share one root cause: when an email
*looks* informational (a chatty note, a thank-you, a newsletter, a forwarded comp),
the classifier collapses it to CLIENT_CONVERSATION / NOISE / MARKET_REPORT and either
**drops a real actionable lead** or **invents a phantom one.**

| Fixture | Extractor produced | Expected | Why it matters |
|---|---|---|---|
| `adv_hist_sold_comp_forward` | `SELLER_LEAD`, clientSide=seller, **conf 0.82** (nbhd Greenwich Village; price/address null) | MARKET_REPORT / NOISE | A **just-sold comp** forwarded for pricing becomes a **phantom seller in the match pool.** Broker chases a seller who isn't selling. (Restraint credit: it did *not* emit the $2.1M sold price as live.) |
| `adv_intent_info_plus_seller_lead` | `NOISE` (conf 0.95), no extraction | SELLER_LEAD | "btw I'm thinking of listing next month" is a **real seller lead** dropped to the floor. Pure deal loss. |
| `adv_buried_thankyou_future_listing` | `CLIENT_CONVERSATION`, clientSide=**buyer**, conf 0.92 | SELLER_LEAD | Future-seller intent in a thank-you → filed as informational, and the party polarity is inverted (a prospective *seller* tagged *buyer*). |
| `adv_buried_newsletter_listing` | `MARKET_REPORT` (0.90), no extraction | ACTIVE_SALE_LISTING | A genuine exclusive at the bottom of a newsletter is **never extracted** — real inventory invisible to search. |

This is the **same boundary `KNOWN_ISSUES.md` flags** for CLIENT_CONVERSATION, now with
evidence that it cuts both ways: false negatives (leads dropped) *and* false positives
(phantom leads created). For a broker, this bucket is the actual money — a missed
seller lead or a chased phantom is worse than any parsing glitch.

### 2. Cross-street written into the address field

| Fixture | Extractor produced | Expected | Why it matters |
|---|---|---|---|
| `adv_addr_cross_street` | address = `"5th Avenue & 82nd Street"`, **conf 0.88** | address = null | Violates "never invent an address." A cross-street is not a mailable address; downstream matching/geocoding on `address` gets a value that can't resolve. Confident (0.88), so it won't self-suppress. |

Note the extractor *was* restrained elsewhere in the same row (price null, beds=3
correct, neighborhood "Museum Mile" reasonable) — the failure is specifically the
address slot accepting a corner instead of nulling.

### 3. Multi-unit resale hotsheet mislabeled as development

| Fixture | Extractor produced | Expected | Why it matters |
|---|---|---|---|
| `adv_multi_html_table_10` | **9 opportunities** (count ✓), category `COMING_SOON_DEVELOPMENT` | COMING_SOON_SALE | The hard part (fan-out to 9 rows from an HTML table) **worked**; the label is wrong. A resale hotsheet with many units reads as one new-development building, which would route these to the wrong supply surface. |

---

## Confident-hallucination highlights (wrong value, confidence > 0.7)

Per the brief, the cases where the extractor is both **wrong and confident**:

1. **`adv_addr_cross_street`** — fabricated a non-mailable address `"5th Avenue & 82nd Street"` at **0.88**.
2. **`adv_hist_sold_comp_forward`** — phantom `SELLER_LEAD` from a sold comp at classifier **0.90** / extraction **0.82**.
3. **`adv_intent_info_plus_seller_lead`** — real lead confidently discarded as `NOISE` at **0.95** (a confident *false negative*).
4. **`adv_buried_thankyou_future_listing`** — informational misfile + inverted party (seller→buyer) at **0.92**.

Not on this list, to be honest about it: the extractor showed **good restraint** where
it counted — `adv_hist_sold_comp_forward` and `adv_addr_cross_street` both left
price/other fields null rather than inventing numbers, and `adv_price_range_only`
declined to fabricate a firm price from a range. The confident failures are about
**routing/intent**, not fabricated numeric values.

---

## What passed — genuine signal that these are *not* weak spots

Worth stating plainly, since the point is signal, not a scary number:

- **NYC bed/bath slang is understood.** Junior 4 → 1, Classic 6 → 2, 3+1 → 3. The
  extractor did *not* read the trailing digit literally in any of the three.
- **Price formats are solid.** `$1.9M` → 1,900,000; **annual→monthly rent conversion**
  ($54,000/yr → $4,500/mo) worked; upper-bound "under $2M" correctly stayed demand-side.
- **Address restraint is mostly good.** Missing suffix ("45 East 89th") captured;
  unit suffix ("2 Park Ave South, 14A") did not become 14 beds; **building-name-only
  ("The Astoria") correctly nulled both address and neighborhood and did not leak the
  Astoria/Queens homonym** — a hard trap, passed.
- **Multi-listing fan-out works**, including **3 listings recovered from a quoted
  forward chain** and 2 from a side-by-side comparison.
- **Coming-soon vs active** ("hitting the market Monday") and the **reprice** (kept the
  new $2.2M, not the old $2.5M) were correct.
- **Past-purchase congratulations → NOISE**, no fabricated listing.

---

## Recommended targets for Brief 6.3 (priority order)

1. **Informational-boundary lead recovery** (bucket 1 above) — highest value. Four
   fixtures, one root cause. Options to explore: a lead-intent pass that runs *after*
   an email is routed to CLIENT_CONVERSATION/NOISE/MARKET_REPORT to recover buried
   seller/buyer intent; provenance labeling so a comp-derived "seller" can't enter the
   match pool as a real lead (this is already named in the KNOWN_ISSUES tripwire).
   Fixes here should ship with the null-field / provenance guards the tripwire lists.
2. **Cross-street → null address** (`adv_addr_cross_street`) — a targeted extractor
   rule: a corner/intersection with no street number is not an `address`.
3. **Resale-hotsheet vs development labeling** (`adv_multi_html_table_10`) — distinguish
   "many resale units in one blast" from "one new-development building."

### Harness note (not an extractor bug, but flag for the grader owner)

`adv_buried_budget_bump` shows the harness grades only `rows[0]`. The extractor split
its output into two CLIENT_CONVERSATION rows and put the buried $2.2M/West Village
signal in `row[1]`, so the primary-row grade (50%) *understates* what was actually
extracted. If future fixtures expect a single primary opportunity but the extractor
legitimately emits multiple rows, the grader may score real successes as failures.
Worth a "best-matching row" grade for single-expectation fixtures — out of scope here
(grader untouched per brief), noted for later.

---

## Constraints honored

- Cost **$1.22** < $3 hard cap.
- Extractor, grader, and Prisma schema **unchanged**. No chat/guard/ingestion source
  touched. Additions only, all under `test/fixtures/emails/adversarial/`.
- tsc clean.
- 25 fixtures committed granularly, one commit per weak-spot bucket.
- Branch `brief-6.2-adversarial-fixtures` held — **not pushed, no PR, not merged.**
