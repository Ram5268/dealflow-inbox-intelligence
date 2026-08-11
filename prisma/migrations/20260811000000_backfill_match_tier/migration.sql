-- Brief 8.0-lite Fix #3b — backfill tier on legacy Match rows written before
-- Brief 7.2's persistence adapter. The classic runMatchmaking() never set tier,
-- so consumers keying on match.tier directly regress on those rows. Idempotent:
-- the WHERE clause makes re-runs a no-op.
UPDATE "Match" SET "tier" = CASE
  WHEN "score" >= 90 THEN 'HOT'::"MatchTier"
  WHEN "score" >= 70 THEN 'WARM'::"MatchTier"
  ELSE 'POSSIBLE'::"MatchTier"
END WHERE "tier" IS NULL;
