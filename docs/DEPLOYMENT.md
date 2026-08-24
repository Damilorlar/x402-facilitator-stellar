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

### Loading a .env file

For local (non-Docker) runs, the service loads a `.env` file from the working
directory at startup:

```bash
cp .env.example .env   # fill in FACILITATOR_SECRET
npm start
```

Properties of this mechanism, and why it is wired this way:

- **Development convenience only.** The file is loaded when `NODE_ENV` is not
  `production`. Production has no `.env`; there the environment comes from the
  orchestrator, so a stray `.env` left next to the image cannot shadow it.
- **Tolerant of absence.** No file, no error — the environment stands alone.
- **Real environment wins.** Variables already set in the environment are never
  overridden by `.env`. A stale local file cannot silently beat what a secrets
  manager injected.
- **`.env` is gitignored.** `FACILITATOR_SECRET` is a signing key.

### Deployment topology and client IP resolution

Whether the service can see the real client IP depends on what sits in front of
it:

| Environment | Topology | `TRUST_PROXY` |
|---|---|---|
| Local development | Direct connection | unset |
| docker-compose | Port published directly, no proxy | unset |
| Hosted (TLS terminator / load balancer / ingress) | 1+ reverse-proxy hops in front | hop count or proxy list |

With no proxy configured, Express's default applies: `req.ip` is the address of
the TCP peer. That is correct when clients connect directly — and wrong behind
a proxy, where every caller shares the proxy's address and, in open mode, one
rate-limit bucket.

When deployed behind a proxy, set `TRUST_PROXY` to the number of trusted proxy
hops (e.g. `TRUST_PROXY=1`) or an explicit list of proxy addresses/CIDRs
(e.g. `TRUST_PROXY=10.0.0.5,10.0.1.0/24`). The value is pinned to known
infrastructure on purpose: `true` is rejected at boot because it trusts the
leftmost `X-Forwarded-For` entry, which the client wrote itself and can forge.

Rate limiting keys on `req.keyId || req.ip`, so getting this right is also what
keeps open-mode callers out of each other's buckets.

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
| `TRUST_PROXY` | No | Express trust proxy setting: hop count or proxy list (see topology above). Never `true`. |
| `REDIS_URL` | No | Shared rate-limit buckets across instances, e.g. `redis://redis:6379`. Unset = in-memory. |
| `DATABASE_URL` | No | Connection string for PostgreSQL (e.g., `postgres://user:pass@host:5432/db`). Enables persistent idempotency keys; unset = in-memory. |

## Horizontal Scalability

A single instance keeps all mutable state in process memory. To run multiple
instances behind a load balancer:

- **Rate limits** — set `REDIS_URL`. All instances then share one counter set
  (per-owner sliding windows with TTLs), so limits mean the same thing
  regardless of which node handled the request. If Redis becomes unreachable,
  an instance degrades to per-instance in-memory counters and logs a warning;
  the service stays up.
- **Idempotency** — set `DATABASE_URL`. Settlement retries are deduplicated via
  a Postgres table with a unique constraint, so a retry routed to a different
  instance replays the recorded response instead of settling twice. If
  Postgres is unavailable, idempotency degrades to process-local with a loud
  warning.
- **Catalog** — still per-instance in-memory; see Known Gaps.

The docker-compose file ships both services (`redis`, `db`) and wires both URLs.

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

When `DATABASE_URL` is set, the database must be provisioned (PostgreSQL 16+)
and migrated before the main facilitator process binds to the port, so the
schema is ready when the first settlement arrives:

```bash
psql "$DATABASE_URL" -f migrations/001_bazaar_catalog.sql
psql "$DATABASE_URL" -f migrations/002_idempotency_keys.sql
```

Migrations are applied on deploy (or handled by an init container). They are
forward-compatible: each creates its tables/indexes if absent and touches
nothing else.

## Resource Sizing

- **CPU/Memory:** The facilitator is a lightweight Node.js Express server. A base deployment of `1 vCPU` and `512MB RAM` is sufficient for typical workloads.
- **Signer Keys:** Testnet and pubnet signer keys must be strictly separated. Do not reuse the testnet key for pubnet. The `config.js` will explicitly fail if `ENABLE_PUBNET=true` is set without an independent pubnet secret.

## Rollback Procedure

To roll back a deployment:
1. Revert to the previously known-good container image tag/digest.
2. If a database migration was part of the failed deployment, evaluate if the previous version's code is compatible with the new schema (we aim for forward-compatible migrations). If not, apply the down-migration before restarting the previous image.
3. Restart the service.
