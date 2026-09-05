-- Two small things the new screens need.

-- ---------------------------------------------------------------------------
-- 1. Reading the audit trail newest-first.
--
-- The two indexes on audit_log both lead with a filter column, so they serve
-- "this record's history" and "this user's changes" and neither serves the
-- unfiltered view -- which is the one the screen opens on. Fifty thousand rows
-- were being sorted on every page load to show twenty-five of them.

CREATE INDEX audit_log_recent_idx ON audit_log (changed_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 2. Finding contracts about to end.
--
-- A running contract with an end date is a deadline nobody is told about. The
-- data has always been there; what was missing was any query that asked. This
-- is the index that makes asking cheap -- partial, because a contract that is
-- not running or has no end date can never be the answer.

CREATE INDEX contract_expiry_idx ON contracts (end_date)
  WHERE state = 'running' AND end_date IS NOT NULL;

COMMENT ON INDEX contract_expiry_idx IS
  'Supports the expiring-soon queries on the dashboard and the contract list.';
