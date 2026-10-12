-- Apply before mounting SessionPersistence in schemas created with variation
-- VARCHAR(16). Native tenant claims support longer variation labels. Widening
-- to text preserves every existing value and leaves session identity keys and
-- their foreign keys unchanged.
ALTER TABLE harness_sessions
  ALTER COLUMN variation TYPE text
  USING variation::text;
