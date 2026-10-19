// Brief 35: Match writes for nightly scoring. Rows travel as one jsonb parameter
// per statement. The job owns every Match row whose supply is a real (non-test)
// MojoContact, and never touches rows whose supply is a test contact or an
// ExtractedOpportunity.

// $1 = jsonb rows, $2 = organizationId. Inserts new pairs; on an existing pair,
// updates the scorer outputs only when something changed. id, seen and
// createdAt are never touched, so /matches "new" flags and freshness survive.
export const UPSERT_MATCHES_SQL = `
INSERT INTO "Match" AS m (id, "organizationId", "opportunityId", "opportunityType", "counterpartId", "counterpartType",
  score, tier, reason, "captureStatus", "matchFitConfidence", contributions, "unknownFactors")
SELECT r.id, $2, r."opportunityId", 'contact', r."counterpartId", r."counterpartType",
  r.score, r.tier::"MatchTier", r.reason, r."captureStatus", r."matchFitConfidence", r.contributions, r."unknownFactors"
FROM jsonb_to_recordset($1::jsonb) AS r(id text, "opportunityId" text, "counterpartId" text, "counterpartType" text,
  score int, tier text, reason text, "captureStatus" text, "matchFitConfidence" text, contributions jsonb, "unknownFactors" text[])
ON CONFLICT ("opportunityId", "counterpartId", "counterpartType") DO UPDATE SET
  score = EXCLUDED.score, tier = EXCLUDED.tier, reason = EXCLUDED.reason, "captureStatus" = EXCLUDED."captureStatus",
  "matchFitConfidence" = EXCLUDED."matchFitConfidence", contributions = EXCLUDED.contributions,
  "unknownFactors" = EXCLUDED."unknownFactors"
WHERE m."opportunityType" = 'contact' AND m."organizationId" = EXCLUDED."organizationId"
  AND (m.score, m.tier, m.reason, m."captureStatus", m."matchFitConfidence", m.contributions, m."unknownFactors")
      IS DISTINCT FROM (EXCLUDED.score, EXCLUDED.tier, EXCLUDED.reason, EXCLUDED."captureStatus",
                        EXCLUDED."matchFitConfidence", EXCLUDED.contributions, EXCLUDED."unknownFactors")
RETURNING old.id IS NULL AS inserted`

// $1 = organizationId, $2 = jsonb [{opportunityId, counterpartId, counterpartType}]
// of every pair kept this run. Deletes the job's own rows that weren't kept.
export const DELETE_STALE_MATCHES_SQL = `
DELETE FROM "Match" AS m
USING "MojoContact" AS c
WHERE m."organizationId" = $1 AND m."opportunityType" = 'contact'
  AND c.id = m."opportunityId" AND NOT c."isTestData"
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS k("opportunityId" text, "counterpartId" text, "counterpartType" text)
    WHERE k."opportunityId" = m."opportunityId" AND k."counterpartId" = m."counterpartId"
      AND k."counterpartType" = m."counterpartType")`

// Brief 47 (PR 1): $1 = organizationId. The size check's yardstick: how many
// matches, and how many sellers with one, the database holds now, counted over
// exactly the rows the delete above can remove (the same WHERE). Engineering
// precaution (lib/matching/nightly/guard.ts).
export const EXISTING_MATCH_COUNTS_SQL = `
SELECT count(*)::int AS matches, count(DISTINCT m."opportunityId")::int AS sellers
FROM "Match" AS m, "MojoContact" AS c
WHERE m."organizationId" = $1 AND m."opportunityType" = 'contact'
  AND c.id = m."opportunityId" AND NOT c."isTestData"`

// Brief 45 (PR E): the same delete, narrowed to the sellers one import-scoring
// request scored ($3 = jsonb array of their MojoContact ids). That route scores
// a few new sellers between nightly runs, and the statement above would delete
// every other seller's matches. Engineering precaution.
export const DELETE_STALE_MATCHES_OF_SELLERS_SQL = `${DELETE_STALE_MATCHES_SQL}
  AND m."opportunityId" IN (SELECT jsonb_array_elements_text($3::jsonb))`
