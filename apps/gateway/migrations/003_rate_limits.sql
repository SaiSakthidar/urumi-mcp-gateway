-- Rate limiting (per API key / per user) and a new audit outcome for rejected calls.
-- Counters live in Postgres so the limit holds across several gateway replicas.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_outcome_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_outcome_check
  CHECK (outcome IN ('ok', 'tool_error', 'timeout', 'unreachable', 'disabled',
                     'not_found', 'error', 'denied', 'auth_revoked', 'rate_limited'));

CREATE TABLE rate_limit_counters (
  bucket        text NOT NULL,          -- "key:<id>" or "user:<id>"
  window_start  timestamptz NOT NULL,   -- start of the one-minute window
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
