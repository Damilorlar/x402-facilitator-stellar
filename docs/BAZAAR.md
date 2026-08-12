# Bazaar Data Model

## Identity Decision
Identity is the crucial decision for the catalog:
- **HTTP resources** are keyed uniquely by their `url`.
- **MCP resources** are keyed by the tuple `(url, toolName)` because a single MCP server URL can expose multiple tools, and each tool is considered a distinct catalog entry.

## Upstream Type
Derived from `@x402/extensions` (v2.21.0) `DiscoveryResource`.

## API: `GET /discovery/resources`

Allows agents and clients to list discovered resources with optional filtering and pagination.
Pagination uses `limit` (max 100, default 20) and `offset`. The results are ordered by discovery time (newest first).

### Example
```bash
curl "https://facilitator.example.com/discovery/resources?type=mcp&limit=10"
```
```json
{
  "x402Version": 2,
  "items": [
    {
      "type": "mcp",
      "url": "http://mcp.ex",
      "toolName": "search_docs",
      "serviceName": "Documentation Search",
      "scheme": "exact",
      "network": "stellar:testnet"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 1
  }
}
```

## API: `GET /discovery/search`

Provides lexical full-text search over discovered resources, designed to be called by agents discovering tools on the fly.

### Retrieval & Ranking
The search performs a lexical match against:
- `serviceName` (high weight)
- `tags` (high weight for exact matches)
- `description` (medium weight)
- Parameter descriptions within `extensions` (low weight, but critical for agent legibility)

Matches are ranked using these signals, and then boosted by:
- **Provenance:** Resources verified via actual payments (`source: 'payment'`) outrank those manually registered.
- **Recency:** A time-decay (half-life of ~43 days) is applied so live endpoints naturally outrank stale ones.

### Cold Start
Because ranking over an empty catalog is meaningless, the memory store relies on the testnet and pubnet instances being seeded with a curated set of example tools on startup (or via `POST /discovery/resources` in CI pipelines) to provide immediate utility for first-time callers.

### Pagination & Degraded States
Cursor pagination is implemented via the opaque `cursor` parameter. Both `limit` and `cursor` are *advisory* — the server may return fewer results. `partialResults` will be set to `true` if the backend is degraded (e.g. if a future Postgres migration fails to query all partitions), though currently it is always `false` in the memory-backed spike.

### Performance Target
The p95 latency target for this endpoint is **<50ms**, ensuring it does not block agent interactive paths.

## Validation & Cataloging Policy

Automatic cataloging is triggered asynchronously off the payment path for `/verify` and `/settle` when the `PaymentPayload` carries the discovery extension. Manual registration is supported via `POST /discovery/resources` but marked as `source: 'manual'`.

The validation rules for resources submitted to the catalog are as follows:

| Field | Failure | Outcome | Reason |
|---|---|---|---|
| Extension schema | Invalid | **Hard drop** (resource discarded) | Must conform to upstream bazaar spec. |
| `routeTemplate` | Invalid / Traversal | **Hard drop** (resource discarded) | Security boundary to prevent SSRF and traversal. |
| `serviceName` | Invalid / Oversized | **Soft drop** (field removed) | Protects against UI bloat and poisoning. |
| `iconUrl` | Invalid or private IP | **Soft drop** (field removed) | Protects against SSRF tracking pixels and local probes. |
| `description` | Contains HTML or oversized | **Truncated** (up to 200 chars) | Prevents script injection and limits storage impact. |
| `tags` | Too many tags or oversized | **Filtered** (invalid tags dropped) | Prevents tag flooding and index bloat. |

**Catalog limits:**
- **Rate Limit:** Catalog operations are limited per payer IP to 10 requests per minute (`catalog_rpm` in config).
- **Resource Cap:** A single `payTo` address can have a maximum of 50 resources in the catalog. New inserts beyond this limit are rejected.
- **PayTo changes:** If a resource is already cataloged and a subsequent payment reports a different `payTo`, a warning is logged.

## Search Quality & Evaluation History

Search quality is continually measured against a human-authored judgement set (`eval/judgements/queries.json`) and run in CI on every relevant change. Our methodology and its limitations are documented in `eval/judgements/README.md`.

We track the following metrics on our test set:

| Release | Date | P@3 | R@3 | MRR | nDCG | Notes |
|---------|------|-----|-----|-----|------|-------|
| `v0.0.1` | 2026-08-12 | 0.625 | 1.000 | 1.000 | 0.991 | Initial lexical baseline release |
| `v0.0.2` | 2026-08-12 | 0.583 | 1.000 | 1.000 | 1.000 | Hybrid semantic search via API |

## Full Re-index Procedure

Because this is an in-memory conformance spike, re-indexing is implicit on restart. All catalog items are rebuilt as payments arrive.

For a persistent deployment, a full re-index (required when changing the embedding model) is performed by:
1. Configuring the new embedding model endpoint.
2. Iterating through the primary catalog table.
3. Repopulating the dense vectors.
4. Hot-swapping the new vector index.

