-- migrations/002_rate_limit_buckets.sql
--
-- Shared state for the rate limiter / usage meter (issue #94). The service
-- also creates this table itself on first use (CREATE TABLE IF NOT EXISTS in
-- src/rate-limit-store.js); keeping the migration alongside 001 means an ops
-- flow that applies migrations up front gets the same schema.
--
-- One row per limiter bucket. bucket_id embeds owner, counter type, window
-- start and window size, e.g. "key_0:settle:1735689600:3600". Expired windows
-- are swept opportunistically by the service; rows are never evicted under
-- memory pressure, which is precisely why a daily fee ceiling is safe here.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_id TEXT PRIMARY KEY,
    count     BIGINT NOT NULL DEFAULT 0,
    reset_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_reset_at ON rate_limit_buckets(reset_at);
