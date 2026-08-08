# Brief 6.3 — Buried-Lead Fixes Report

**Goal:** turn the 6 adversarial failures + the KNOWN_ISSUES CLIENT_CONVERSATION
tripwire from Brief 6.2 into fixes, proven by harness re-run.

**Result:** all 6 target fixtures FAIL → PASS, no structural regression on the 93,
and the overall numbers went **up** — classifier 86% → **94%**, field 92.3% → **96.1%**.
The CLIENT_CONVERSATION tripwire is **RESOLVED** (1/6 → 5/6 classified).

**Spend:** ~**$4.2** across 3 full harness runs + 2 adversarial-subset iterations + the
second-pass verification (hard cap $10). tsc clean, migration applied cleanly.

---

## Per-fixture before → after (the 6 targets)

| Fixture | Bucket | Brief 6.2 (before) | Brief 6.3 (after) |
|---|---|---|---|
| `adv_intent_info_plus_seller_lead` | buried lead | ❌ NOISE (0.95) — lead dropped | ✅ **SELLER_LEAD**, party + Windsor Terrace/Brooklyn |
| `adv_buried_thankyou_future_listing` | buried lead | ❌ CLIENT_CONVERSATION, party inverted | ✅ **SELLER_LEAD**, Chelsea |
| `adv_buried_newsletter_listing` | buried lead | ❌ MARKET_REPORT — listing missed | ✅ **ACTIVE_SALE_LISTING**, 240 W 23rd St, $875k |
| `adv_hist_sold_comp_forward` | deceptive comp | ❌ SELLER_LEAD — phantom lead | ✅ **MARKET_REPORT** — no phantom |
| `adv_addr_cross_street` | address | ❌ address = "5th Avenue & 82nd Street" | ✅ address = **null** |
| `adv_multi_html_table_10` | resale vs dev | ❌ COMING_SOON_DEVELOPMENT | ✅ **COMING_SOON_SALE**, 9 opps |

All six at 100% on the final run.

---

## Overall accuracy delta (118-fixture harness)

| Metric | Brief 6.2 baseline | Brief 6.3 | Δ |
|---|---|---|---|
| Classifier accuracy | 86% (102/118) | **94% (111/118)** | +8 pts |
| Overall field accuracy | 92.3% | **96.1%** | +3.8 pts |
| Adversarial bucket | 19/25 | **24/25** | +5 |
| CLIENT_CONVERSATION | 1/6 · 58% | **5/6 · 68%** | +4 classified |

Selected category rollup (after): SELLER_LEAD 100%, SHOWING_CONFIRMATION 100%,
BUYER_ISO 100%, NOISE 100%, OPEN_HOUSE 97%, PRICE_DROP 97%, COMING_SOON_SALE 100%.

---

## Regressions on the 93 existing fixtures

**None structural.** The path there was not free, and the intermediate runs are worth
recording honestly:

- **Intermediate regression, fixed:** the first full run dropped OPEN_HOUSE (81%) and
  PRICE_DROP (84%) because the widened/HTML body made gpt-4o-mini flip
  `needsDeepExtract` to false on two emails, skipping extraction. Fixed by **deriving
  `needsDeepExtract` from the category** instead of trusting the model's boolean →
  both restored to ~100%.
- **Intermediate regression, fixed:** the first buried-intent prompt over-fired on
  genuine CLIENT_CONVERSATION threads (a buyer check-in → RENTER_INQUIRY, a
  vague-referral thank-you → SELLER_LEAD, a client forwarding a listing →
  ACTIVE_SALE_LISTING). Fixed by a **precision "KEEP AS CLIENT_CONVERSATION"** section
  (ongoing threads, offer negotiation on a live deal, reacting to someone else's
  listing, vague future/third-party mentions stay conversations) — which is *why*
  CLIENT_CONVERSATION rose to 5/6 rather than falling.
- **Intermediate regression, fixed:** the conversation guidance then bled into
  SHOWING_CONFIRMATION (a reschedule reply → CLIENT_CONVERSATION). Fixed with a
  **SHOWING_CONFIRMATION PRECEDENCE** note → SHOWING_CONFIRMATION back to 4/4.
- **Residual (LLM noise, not a code regression):** `price_drop_03_chelsea_forwarded`
  landed PRICE_DROP (100%) in one run and ACTIVE_SALE_LISTING (89%, still extracts the
  listing) in another — run-to-run nondeterminism on a forwarded price-drop, within
  normal variance. PRICE_DROP is a sale subtype, so the near-miss still yields the
  listing.

---

## What changed (by fix layer)

### Fix #1 — buried leads (three layers, shipped together)

**A. Classifier prompt + wider window** (`lib/ingestion/sourceClassifier.ts`):
- New **BURIED INTENT** section: concrete list/sell intent → SELLER_LEAD; a buyer
  (incl. a colleague's) with real criteria → BUYER_ISO; a newsletter's concrete
  listing → its listing category; a sold/historical comp → MARKET_REPORT/NOISE, never
  a lead.
- New **KEEP AS CLIENT_CONVERSATION** section (the precision guard above) + a
  **SHOWING_CONFIRMATION PRECEDENCE** note.
- **Body window widened 500 → 1200 chars**, and `buildPrompt` now prefers the fuller
  body over the short preview — so a listing/lead buried at the *bottom* of an email
  (e.g. a newsletter's exclusive at char 725) is visible to the classifier at all.
- `needsDeepExtract` **derived from category** (only NOISE / MARKET_REPORT /
  REAL_ESTATE_EVENT skip extraction), removing model-driven flakiness.

**B. Lead-recovery second pass** (`lib/extraction/recoverBuriedLead.ts`, wired in
`ingestEmailV2` for informational buckets): a conservative Sonnet scan that recovers a
buried lead only on concrete intent, tags `provenance='buried_recovery'`, and flags
sold comps as `provenance='comp_reference'`. Verified directly (the harness can't
reach it — see note below): recovers a real seller lead, returns **null** on an
ongoing conversation, and declines a sold comp.

**C. Provenance field** (`prisma` migration `20260808203930_add_provenance_field`;
wired in `extractEmailV2` persistence): `comp_reference` | `buried_recovery` | null.
`lib/matchmaking.ts` and `lib/chat/tools/searchParties.ts` now **exclude
`comp_reference`** from every match pool (Prisma `not` keeps null + buried_recovery).

### Fix #2 — cross-street → null address (`lib/extraction/schemas.ts`)
Added an explicit rule to the SALE / RENTAL / COMING_SOON / SELLER extractor prompts:
a cross-street / intersection with no street number is not a mailable address →
output null.

### Fix #3 — resale hotsheet vs development (`lib/ingestion/sourceClassifier.ts`)
Classifier rule: multiple units at DIFFERENT addresses → resale category
(COMING_SOON_SALE / ACTIVE_SALE_LISTING, N opportunities); multiple units at the SAME
building → development. (The harness's `bodyForClassifier` was also aligned to feed the
classifier the stripped HTML table, mirroring production, so the hotsheet's addresses
are visible.)

---

## Verification note on the second pass (#1B)

Two facts shape how #1B is verified:
1. The harness grades `category` on the **raw classifier output**, so a second pass
   that *preserves* the primary category cannot move a harness fixture — and it
   doesn't need to: the **classifier tuning + wider window already route all 6 target
   fixtures correctly**, so the harness verifies Fixes #1A/#2/#3 end-to-end.
2. `extractEmailV2` runs only for `needsDeepExtract` categories, and `ingestEmailV2`
   is gated by `INGESTION_TEST_MODE_ONLY` until a real source is enabled — so the
   second pass is **forward-looking hardening for the long tail** (leads buried below
   even the widened window in real inbox traffic), not a harness-tested path.

Because the harness can't reach it, #1B was verified **directly**: it recovers the
Chelsea seller lead (conf 0.82), returns null on a genuine ongoing conversation, and
declines the sold comp — i.e. it does not manufacture phantom leads from noise, which
was the main risk. The provenance guard is the belt to that suspenders.

---

## Constraints honored

- Fixtures (adversarial + 93) **unmodified**. Grader **unmodified** (only the
  classifier-input assembly in the harness was aligned to production).
- Scope: classifier + extractor + one Prisma migration + matchmaking/searchParties
  provenance guard. No other chat/guard files touched.
- tsc clean; migration applied cleanly; Prisma client regenerated.
- Spend ~$4.2 < $10 cap. Committed granularly (6 fix commits + this report).
- Branch `brief-6.3-buried-leads-fixes` **held — not pushed, no PR, not merged.**
