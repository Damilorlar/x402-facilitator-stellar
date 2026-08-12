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
