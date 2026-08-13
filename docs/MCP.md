# x402 Agent MCP Server

This repository includes a standalone Model Context Protocol (MCP) server that empowers any MCP-compatible agent to discover, verify, and call paid x402 endpoints natively. It transforms paid API integration from a manual coding task into a simple tool call.

## Features

- **Agent-facing Discovery**: Exposes the facilitator catalog directly to the agent's context.
- **Automated Payment Negotiation**: Handles HTTP 402 responses, `x402` payload signing, and payment injection transparently.
- **Hard Spending Controls**: Enforces strict per-call and per-session max spending limits, rejecting any over-budget calls before money is moved.
- **Secure Key Custody**: Key is provided at startup via environment variable and is never logged or exposed to the model.

## Installation & Configuration

The MCP server is implemented as a standard Node.js stdio script.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_PAYER_SECRET_KEY` | **(Required for `call_paid_resource`)** Stellar Ed25519 Secret Key to pay for API calls. | *none* |
| `MAX_FEE_PER_CALL_STROOPS` | Max amount willing to pay for a single API call (in stroops). | `1000` (0.0001 XLM) |
| `MAX_SESSION_SPEND_STROOPS`| Max amount willing to pay per session (in stroops). | `10000` (0.001 XLM) |
| `FACILITATOR_URL` | Facilitator endpoint for catalog discovery. | `http://localhost:3402` |
| `NETWORK` | Stellar network to use. | `stellar:testnet` |

### Adding to Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-stellar": {
      "command": "node",
      "args": ["/path/to/x402-facilitator-stellar/src/mcp/cli.js"],
      "env": {
        "AGENT_PAYER_SECRET_KEY": "S...YOUR_TESTNET_KEY...",
        "MAX_FEE_PER_CALL_STROOPS": "1000",
        "MAX_SESSION_SPEND_STROOPS": "50000",
        "FACILITATOR_URL": "http://localhost:3402"
      }
    }
  }
}
```

## Available Tools

The MCP server exposes three tools to the agent:

1. **`search_resources` (Free)**: Search the facilitator's catalog using natural language and filters. Returns resource metadata including parameter descriptions.
2. **`get_resource` (Free)**: Get full metadata and pricing information for a specific resource URL.
3. **`call_paid_resource` (Paid)**: Call a paid endpoint. The tool handles the 402 negotiation and payment automatically. **This tool will spend money.**

## Worked Example

Agent prompt:
> "Find a weather API in the x402 catalog, get the forecast for London, and tell me if it will rain."

What the agent does:
1. Calls `search_resources` with `{"query": "weather forecast"}`.
2. Reads the returned parameters and pricing.
3. Calls `call_paid_resource` with `{"url": "...", "method": "GET"}`.
4. The MCP proxy intercepts the 402 response, signs the payment payload using `AGENT_PAYER_SECRET_KEY`, resubmits the request, and returns the weather data to the agent.
5. The agent responds to the user: "It will not rain in London today."
