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
