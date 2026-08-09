# Known Issues

Tracked, deliberately-deferred issues. Each entry states current impact and a
tripwire: the condition under which the issue stops being cosmetic and becomes
load-bearing (and what must ship alongside the change that trips it).

## CLIENT_CONVERSATION classifier / buried-lead boundary — RESOLVED (Brief 6.3, 2026-08-08)

**Status: RESOLVED.** The informational-boundary failures that Brief 6.2 turned from
hypothesis into evidence (buried seller/buyer leads dropped to NOISE/CLIENT_CONVERSATION,
sold comps promoted to phantom SELLER_LEADs, a newsletter's real listing missed) are
addressed by the Brief 6.3 three-layer fix, verified on the 118-fixture harness.

**What changed (all in `lib/ingestion/sourceClassifier.ts` + extractor):**
1. **Classifier tuning + wider body window.** A BURIED-INTENT section routes concrete,
   actionable intent to the right lead/listing category (chatty/thank-you "I'm thinking
   of listing" → SELLER_LEAD; colleague's buyer with real criteria → BUYER_ISO; a
   newsletter's concrete listing → its listing category; a sold/historical comp →
   MARKET_REPORT/NOISE, never a lead). A companion "KEEP AS CLIENT_CONVERSATION" section
   protects genuine ongoing threads (showing follow-ups, offer negotiation on a live
   deal, reacting to someone else's listing, vague future/third-party mentions). The
   classifier body window was widened 500→1200 chars so a listing/lead buried at the
   BOTTOM of an email is actually visible. `needsDeepExtract` is now derived from the
   category (not the model's boolean) so extractable categories never skip extraction.
2. **Lead-recovery second pass** (`lib/extraction/recoverBuriedLead.ts`, wired in
   `ingestEmailV2` for informational buckets): a conservative Sonnet scan that recovers
   a buried lead only on concrete intent, tags it `provenance='buried_recovery'`, and
   flags sold comps as `provenance='comp_reference'`. Returns null on genuine
   noise/ongoing chatter (verified directly).
3. **Provenance field** on `ExtractedOpportunity` (`comp_reference` | `buried_recovery`
   | null). Match pools (`lib/matchmaking.ts`, `lib/chat/tools/searchParties.ts`) now
   EXCLUDE `comp_reference` — a sold comp can never enter the match pool as a live lead.

**Measured (Brief 6.3 harness, 118 fixtures):** CLIENT_CONVERSATION classification
1/6 → **5/6** (field acc 58% → **68%**); overall classifier 86% → **94%**, overall
field 92.3% → **96.1%**. All six Brief 6.2 target failures FAIL → PASS. No structural
regression on the 93 existing fixtures.

**Residual (fuzzy, not load-bearing):** a couple of CLIENT_CONVERSATION edge fixtures
that carry real buyer readiness (`_06` forwarded pre-approval with neighborhoods) still
lean BUYER_ISO — genuinely borderline between "existing client" and "actionable ISO."
The provenance guard bounds the downside if such a call is wrong. The prior TRIPWIRE
(don't wire retrieval on CLIENT_CONVERSATION without provenance + null-field guards) is
now satisfied by the provenance field; the null-field/re-extract-gate guards remain
advisable before mining conversation-derived criteria at scale.

**Related deferred (still open, not in Brief 6.3 scope):**
- Multi-unit rental sheet → DEVELOPMENT_INVENTORY misroute (`rental_listing_03`
  fixture: 0 of 5 units extracted because the new-dev spec ran instead of rental).
- REAL_ESTATE_EVENT with payload only in an image attachment → NOISE misroute
  (`real_estate_event_02`).

## LlamaParse tier: agentic (committed 2026-08-08)

The prior `lib/parsing/llamaParse.ts` used `parse_mode=parse_page_with_lvm`, which
LlamaParse retired — the API now returns **410** on every call, so the production
PDF-attachment path was fully broken (discovered by the Brief 6.1 live smoke test).
Fixed by switching to the current tier-based API: `tier=agentic`.

Reasoning: direct semantic replacement for the deprecated `parse_page_with_lvm`
vision mode. Sustainable at production scale (~$15/mo forecast at 1,500 emails/mo ×
20% with PDF × 10 pages avg). Pay-per-use — no subscription, no lock-in.

**TRIPWIRE:** Do NOT turn on any real data source (Outlook, third-party feeds, etc.)
without first re-benchmarking `agentic` vs `agentic_plus` on ≥20 real broker PDFs
(sponsor OMs, hotsheets, rent rolls, flyers, price lists). If `agentic` drops
units/pricing on dense multi-column docs, upgrade to `agentic_plus` (one-line
change in `lib/parsing/llamaParse.ts`). The ~$75/mo delta is worth one missed match.
Real PDFs for the benchmark can come from Ryan directly (forwarded from his current
inbox to a fixture folder) — no live Outlook needed.

## Qdrant + Voyage removed (2026-08-08)

Vector infrastructure ripped out. The Voyage-embedded chunks + Qdrant Cloud vector
database were write-only dead weight — nothing in the retrieval path ever consumed
them. Extractor reads chunks from Postgres. Chat/matching reads structured
ExtractedOpportunity rows from Postgres.

OpenAI embeddings + Postgres pgvector on ExtractedOpportunity and MojoContact are
UNCHANGED — System 1 continues to power semanticSearch in lib/streetEasyHotsheet.ts.

If semantic search over raw email/attachment chunks is ever needed: git history
preserves the deleted code — recovery is checkout + adapt, not rebuild from scratch.
