-- migrations/002_idempotency_keys.sql
-- Persistent idempotency keys for /settle (issue #115).
--
-- The unique constraint on `key` is the actual mechanism: two instances behind
-- a load balancer can both attempt to claim the same retry, and exactly one
-- INSERT succeeds. The loser polls for the winner's recorded response.
-- Claims with a NULL response are in flight or failed; they are re-claimable.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    status_code INTEGER NOT NULL DEFAULT 200,
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

-- Responses are small JSON settlement bodies; index only what retention
-- cleanup needs.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
    ON idempotency_keys(created_at);
