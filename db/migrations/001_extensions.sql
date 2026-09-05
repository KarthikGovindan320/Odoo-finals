-- btree_gist lets a GiST exclusion constraint mix a scalar equality (employee_id)
-- with a range overlap (&&). It is what makes the non-overlapping-contract and
-- non-overlapping-attendance constraints possible at the schema level.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- citext gives us case-insensitive email columns by type, so uniqueness and
-- lookups are correct without every query remembering to lower() both sides.
CREATE EXTENSION IF NOT EXISTS citext;
