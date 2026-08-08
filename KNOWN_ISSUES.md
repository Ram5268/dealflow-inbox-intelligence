# Known Issues

Tracked, deliberately-deferred issues. Each entry states current impact and a
tripwire: the condition under which the issue stops being cosmetic and becomes
load-bearing (and what must ship alongside the change that trips it).

## CLIENT_CONVERSATION classifier: 1/6 accuracy (cosmetic)

**Status: DEFERRED** — no retrieval path currently consumes this category, so the
low classification accuracy has no product impact today.

**Measured (Brief 6.0 fixture harness):** 1 of 6 CLIENT_CONVERSATION fixtures were
classified correctly. The gpt-4o-mini classifier routes 1:1 client threads to
BUYER_ISO / SELLER_LEAD / NOISE instead (a seller reply-chain → SELLER_LEAD, a
forwarded pre-approval → BUYER_ISO, a board-timing thread → NOISE, a thank-you →
NOISE). CLIENT_CONVERSATION is a fuzzy catch-all with weak lexical signal.

**Verified (Brief 6.1 audit):** CLIENT_CONVERSATION is classified as INFORMATIONAL
in `lib/domain/Categories.ts` (the `INFORMATIONAL` group). No retrieval or matching
path filters on it — searchListings, searchParties, matchmaking, and the chips
route all filter only on supply / demand / lead categories. Every code reference to
CLIENT_CONVERSATION is display (`lib/utils.ts`), extraction
(`lib/ingestion/extractors/clientConversationExtractor.ts`, `lib/ai.ts`), or
enrichment/validator skip-lists — none are query filters. So misclassifying a
conversation only mislabels an informational row that nothing retrieves.

**TRIPWIRE:** If any retrieval path ever starts filtering on category
CLIENT_CONVERSATION (Brief 6.2 will do exactly this — expanding searchParties to
mine conversation-derived criteria), classifier accuracy becomes load-bearing that
day. Do NOT ship such a change without also shipping:

- CLIENT_CONVERSATION fixtures with extractable criteria (so accuracy is measurable
  on the retrieval-relevant shape, not just the classification label)
- Null-field enforcement: rows with hallucination-suspicious nulls do NOT enter the
  match index
- A provenance field on `ExtractedOpportunity` distinguishing client-derived rows
  from co-broke-derived rows
- A cutoff date or re-extract gate for historical rows (so pre-fix low-quality
  conversation extractions don't silently pollute the match pool)

**Related deferred (Brief 6.2 scope, not load-bearing today):**
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
