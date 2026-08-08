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
