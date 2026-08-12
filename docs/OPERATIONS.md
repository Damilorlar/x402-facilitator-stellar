# Operations & Rate Limiting

The x402 facilitator includes an in-memory sliding-window rate limiter and usage meter. This protects the service from abuse and limits the cumulative fee exposure, as the service sponsors Stellar transaction fees for every settlement.

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
