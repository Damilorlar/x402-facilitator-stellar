# Deployment Guide

The x402 facilitator is designed to be easily self-hostable.

## Container Build and Run

The project provides a multi-stage `Dockerfile` based on `node:20-alpine` (pinned by digest) and a `docker-compose.yml` for quick setup.

**To run locally with Docker Compose:**

```bash
# FACILITATOR_SECRET is the only required variable for testnet
export FACILITATOR_SECRET="S..." 
docker compose up
```

### Environment Variables

| Variable | Required? | Description |
|---|---|---|
| `FACILITATOR_SECRET` | **Yes** | `S…` secret for the testnet signer. |
| `PORT` | No | Port to listen on (default `3402`). |
| `STELLAR_RPC_URL` | No | Testnet RPC provider (defaults to public testnet). |
| `STELLAR_RPC_URL_PUBNET` | Yes (if pubnet) | A provider URL is required for pubnet (see RPC Provider Decision). |
| `MAX_TX_FEE_STROOPS` | No | Fee ceiling per settlement on testnet (default `50000`). |
| `MAX_TX_FEE_STROOPS_PUBNET`| No | Fee ceiling per settlement on pubnet (default `50000`). |
| `FACILITATOR_API_KEYS` | No | Comma-separated API keys. Unset means open (correct for free testnet). |
| `ENABLE_PUBNET` | No | Set to `true` to enable pubnet. |
| `FACILITATOR_SECRET_PUBNET`| Yes (if pubnet) | `S…` secret for the pubnet signer. |
| `DATABASE_URL` | No | Connection string for PostgreSQL (e.g., `postgres://user:pass@host:5432/db`). Required when `RATE_LIMIT_STORE=postgres`. |
| `RATE_LIMIT_STORE` | No | `memory` (default) or `postgres`. Shared rate-limit state across replicas — see below. |
| `RPC_BREAKER_THRESHOLD` | No | Consecutive connection failures that open the RPC circuit breaker (default `10`). |
| `RPC_BREAKER_COOLDOWN_MS` | No | How long an open breaker waits before a half-open probe (default `30000`). |
| `READINESS_TIMEOUT_MS` | No | Per-call timeout for readiness checks, independent of the RPC retry budget (default `3000`). |
| `READINESS_CACHE_TTL_MS` | No | How long GET /health/ready serves a cached result (default `5000`). |
| `READINESS_FUNDING_FLOOR_STROOPS` | No | Minimum signer balance reported by the readiness probe (default `0` = must exist). |
| `AUDIT_LOG_FILE` | No | File that receives audit records in addition to stdout. |

## Shared Rate-Limit State

By default the rate limiter keeps its counters in process memory. That is fine
for one replica and zero-config testnet, but it has two consequences at scale:

- **A restart resets the daily fee ceiling** (`fee_spd`) — the only spend limit
  on sponsored fees.
- **N replicas enforce N separate limits** — every caller gets N× its
  allowance.

Setting `RATE_LIMIT_STORE=postgres` moves limiter state into Postgres (the
database already provisioned by `docker-compose.yml`, via `DATABASE_URL`):

- two processes sharing one store enforce one combined limit;
- the fee counter survives restarts, redeploys and reschedules;
- increments are atomic single-statement upserts (`migrations/002_rate_limit_buckets.sql`,
  also created automatically on first use) — no lost counts under concurrency.

Postgres was chosen over Redis because it is already part of the stack, and
because its rows are never evicted: a fee counter is a value that must not be
lost to an eviction policy. If Redis is ever introduced here it must run with
`maxmemory-policy noeviction`.

**Degrade behaviour:** when the shared store is unreachable, checks fail CLOSED
with reason `rate_limit_store_unavailable`. Fail-open would mean unlimited
sponsored spend during an outage — exactly the bug this feature exists to
prevent.

## Health Endpoints and Probes

- `GET /healthz` — liveness. Always `{ ok: true }` while the process runs; no
  dependency checks. Point container/orchestrator **restart** logic here.
- `GET /health/ready` — readiness. Checks each configured network's Soroban RPC
  reachability and the signer account's funded balance; returns `503` naming the
  failing check per network when any is unhealthy. Results are cached
  (`READINESS_CACHE_TTL_MS`) and each check runs under its own timeout
  (`READINESS_TIMEOUT_MS`), independent of the ~12s retry budget in the payment
  path. Point load-balancer **traffic gating** here.

## Audit Log

Security-relevant events — settlements (with transaction hash), verifications,
catalog writes, authentication failures, and rate-limit rejections — are
recorded as structured JSON lines with `"channel": "audit"`, separable from
diagnostic logs. Set `AUDIT_LOG_FILE` to mirror them to a file with its own
retention handling. See `docs/AUDIT.md` for the event catalogue and retention.

## Secret Handling

The `FACILITATOR_SECRET` and `FACILITATOR_SECRET_PUBNET` are highly privileged keys. 

**How to supply secrets in production:**
Supply secrets via a secure secrets manager (like AWS Secrets Manager, HashiCorp Vault, or Kubernetes Secrets) and inject them as environment variables at runtime.

**How NOT to supply secrets:**
- DO NOT bake secrets into the container image (`ENV FACILITATOR_SECRET=...` in `Dockerfile`).
- DO NOT commit `.env` files containing real secrets to version control.
- DO NOT pass secrets directly on the command line where they land in shell history (e.g., `docker run -e FACILITATOR_SECRET=S...`).

## RPC Provider Decision

The default `@x402/stellar` package relies on the public Stellar testnet RPC. This is fine for testnet.
**However, for Pubnet:** The public endpoint is explicitly not something to run an availability target against. A pubnet deployment should use a dedicated RPC provider URL (e.g., Blockdaemon, QuickNode, or a self-hosted Horizon/Soroban RPC instance) via `STELLAR_RPC_URL_PUBNET`.

## Database Provisioning and Migration

*(Note: Database persistence is planned for durable settlement in #10 and catalog indexing in #20.)*

When deploying, the database must be provisioned (PostgreSQL 16+) and connected via `DATABASE_URL`.
Migrations will be automatically applied on deploy (or handled by an init container) before the main facilitator process binds to the port to ensure the schema is ready.

## Resource Sizing

- **CPU/Memory:** The facilitator is a lightweight Node.js Express server. A base deployment of `1 vCPU` and `512MB RAM` is sufficient for typical workloads.
- **Signer Keys:** Testnet and pubnet signer keys must be strictly separated. Do not reuse the testnet key for pubnet. The `config.js` will explicitly fail if `ENABLE_PUBNET=true` is set without an independent pubnet secret.

## Rollback Procedure

To roll back a deployment:
1. Revert to the previously known-good container image tag/digest.
2. If a database migration was part of the failed deployment, evaluate if the previous version's code is compatible with the new schema (we aim for forward-compatible migrations). If not, apply the down-migration before restarting the previous image.
3. Restart the service.
