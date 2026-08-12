# Bazaar Data Model

## Identity Decision
Identity is the crucial decision for the catalog:
- **HTTP resources** are keyed uniquely by their `url`.
- **MCP resources** are keyed by the tuple `(url, toolName)` because a single MCP server URL can expose multiple tools, and each tool is considered a distinct catalog entry.

## Upstream Type
Derived from `@x402/extensions` (v2.21.0) `DiscoveryResource`.
