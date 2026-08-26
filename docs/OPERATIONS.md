# Operations & Rate Limiting

The x402 facilitator includes a sliding-window rate limiter and usage meter. This protects the service from abuse and limits the cumulative fee exposure, as the service sponsors Stellar transaction fees for every settlement.

## Health Endpoints

Two endpoints, two different questions — keep them straight:

### `GET /healthz` — liveness

Always returns `200 { ok: true }` while the process runs. It performs **no
dependency checks**, deliberately: a liveness probe that fails on a downstream
outage triggers restart loops that make the outage worse (and a restart cannot
fix someone else's RPC). The Docker `HEALTHCHECK` targets this endpoint.

### `GET /health/ready` — readiness

Returns `200 { status: "ready", ... }` when the instance can settle right now,
or `503 { ok: false, status: "not_ready", networks: {...} }` naming which check
failed for which network. Per configured network it checks:

| Check | Meaning of failure |
|---|---|
| `rpc_reachable` | The network's Soroban RPC did not answer a bounded getHealth call. Every `/settle` will currently fail; stop routing traffic here. |
| `signer_funded` | The facilitator signer account does not exist or is below `READINESS_FUNDING_FLOOR_STROOPS`. No settlement can be sponsored. Fund the account or fix the signer config. |

The response also reports, without ever failing on them:
- `breakers` — per-RPC-host circuit-breaker state (`open` means calls are being refused fast; see #105);
- `catalog` — catalogue-store health. A cataloguing failure must never fail a payment, so it never fails readiness either.

Results are cached for `READINESS_CACHE_TTL_MS` (default 5s) so probes do not
become an RPC burst, and every underlying call runs under its own
`READINESS_TIMEOUT_MS` (default 3s) rather than inheriting the payment path's
~12s retry budget.

**Probe wiring rule:** restart logic → `/healthz`; traffic gating (load
balancers, Kubernetes `readinessProbe`) → `/health/ready`.

## Rate Limit Store

Counters live in process memory by default (`RATE_LIMIT_STORE` unset). For
multi-replica deployments set `RATE_LIMIT_STORE=postgres` with `DATABASE_URL`
so all replicas share one combined limit and the daily fee ceiling survives
restarts — see docs/DEPLOYMENT.md ("Shared Rate-Limit State").

## Configuration

Rate limits are configured via environment variables. There is a global default, and you can apply overrides per API key. 

Limits are expressed as comma-separated `key=value` pairs.

### Global Default

The `RATE_LIMIT_GLOBAL` environment variable sets the fallback limit for any authenticated caller that lacks a specific override, as well as the per-IP limit for open mode.

**Available metrics:**
- `verify_rpm`: Requests per minute for `/verify`
- `settle_rpm`: Settlements per minute
- `settle_rph`: Settlements per hour
- `settle_rpd`: Settlements per day
- `fee_spd`: Cumulative sponsored fee per day (in stroops)

**Example:**
`RATE_LIMIT_GLOBAL="verify_rpm=100,settle_rpm=10,settle_rph=100,settle_rpd=1000,fee_spd=5000000"`

If not specified, the system defaults to conservative thresholds (`verify_rpm=60,settle_rpm=10,settle_rph=100,settle_rpd=1000,fee_spd=5000000`).

### Per-Key Overrides

To grant a specific API key custom limits, set an environment variable named `RATE_LIMIT_<keyId>`.

**Example:**
If `FACILITATOR_API_KEYS=admin:secret1`, you can override limits for `admin` by setting:
`RATE_LIMIT_admin="verify_rpm=500,settle_rpm=50,fee_spd=10000000"`
Any metrics not explicitly overridden fall back to the global configuration.

## HTTP Headers

When a rate limit is exceeded, the server responds with HTTP `429 Too Many Requests`. 
The response body will contain `{ "error": "rate_limited", "reason": "rate_limit_exceeded" }` or `{ "reason": "fee_ceiling_exceeded" }`.

The following headers are included on rate-limited responses to help clients back off:
- `RateLimit-Limit`: The threshold that was exceeded
- `RateLimit-Remaining`: `0`
- `RateLimit-Reset`: Unix timestamp when the window resets
- `Retry-After`: Seconds to wait before retrying

## Usage Metering

An authenticated caller can view their own consumption by calling `GET /usage`. 
The endpoint requires a valid API key and is scoped exclusively to the caller's `keyId`.

Example Response:
```json
{
  "verify_rpm": 42,
  "settle_rpm": 5,
  "settle_rph": 12,
  "settle_rpd": 12,
  "fee_spd": 60000
}
```

## Open Mode Limits

If `FACILITATOR_API_KEYS` is omitted, the service runs in open mode. In this mode, limits from `RATE_LIMIT_GLOBAL` are enforced per source IP address rather than per API key. This prevents a single abusive client from draining a testnet faucet while still keeping onboarding frictionless.

## Observability

The transport emits **one structured JSON line per request** to stdout (one object per line, no framework). The shape is fixed and whitelisted — it never contains the auth entry, the raw `payload.transaction`, API keys, or the facilitator secret:

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 timestamp |
| `level` | `info` or `error` (derived from outcome) |
| `event` | always `"request"` |
| `requestId` | inbound `X-Request-Id`, or a generated `crypto.randomUUID()` echoed on the response |
| `route` | matched route, e.g. `/verify` |
| `network` | CAIP-2 network from the request body |
| `scheme` | scheme from the request body |
| `keyId` | caller API key id (from #5), or `null` in open mode |
| `durationMs` | request duration |
| `outcome` | `ok` \| `rejected` \| `error` |
| `reason` | reason code (from #6); `none` when there is nothing to report |
| `txHash` | settlement transaction hash, or `null` |

`LOG_LEVEL` (default `info`) filters at the line level; `debug` is not currently noisier than `info` because the structured line is the only diagnostic stream.

### Correlation

A resource server debugging a failed payment hands us a single `X-Request-Id` rather than a timestamp range. We honour an inbound one and always echo ours on the response header `X-Request-Id`.

### Metrics (`GET /metrics`)

Prometheus text format, unauthenticated. By default it is served on `PORT`; set `METRICS_PORT` to bind it to a separate listener (typically an internal interface) so it is not on the public surface. Series:

| Metric | Type | Labels | What it tells you | Alert |
|---|---|---|---|---|
| `x402_requests_total` | counter | `route`, `network`, `outcome`, `reason` | every request, by result | page if `outcome="error"` rate spikes (a dependency or code bug); investigate `reason` labels |
| `x402_request_duration_seconds` | histogram | `route`, `network` | verify/settle latency — the interactive-agent target | alert if p95 > 2s on `/verify` or `/settle` (SLO breach for agent use) |
| `x402_settlements_total` | counter | `network`, `outcome` (`settled`/`failed`) | settlement success rate | alert if `outcome="failed"` rate > 1% over 10m |
| `x402_settlement_fee_stroops` | histogram | `network` | **actual fee paid** — the number that shows whether `MAX_TX_FEE_STROOPS` is sane | alert if p95 fee approaches `MAX_TX_FEE_STROOPS` (fee ceiling about to throttle settlements) |
| `x402_rpc_retries_total` | counter | `code` | Soroban RPC connection-level retries | alert if rate > 0 for a host over several minutes (RPC degradation / IPv6 dead-ends) |
| `x402_signer_inflight` | gauge | `network`, `signer` | in-flight settlements per signer — **the sequence-contention signal (#9)** | alert if it sits at ≥ 1 persistently or climbs (signer pool needed before bursty traffic) |

Operational endpoints (`/metrics`, `/healthz`, `/health/ready`) are logged but excluded from `x402_requests_total` so the payment counters stay semantically about payments.
