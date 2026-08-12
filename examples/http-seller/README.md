# x402 HTTP Seller Example

This example demonstrates how to build a simple standalone HTTP API using Express and `@x402/express`. 
It hosts a paid endpoint at `/api/joke` that returns a random dad joke for 0.00025 XLM.

When started, it automatically configures and funds a Stellar testnet account via Friendbot if one is not provided.

## Prerequisites
- Node.js >= 20
- A running x402 Facilitator instance (e.g. `npm start` in the repo root).

## How to run

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start the server:**
   ```bash
   # Ensure the facilitator is running at http://localhost:3402 first!
   npm start
   ```

Upon startup, the script will:
- Check for a `.merchant-secret` file. If none is found, it generates a new Stellar keypair and funds it on the testnet.
- Spin up an express server on `http://localhost:3401`.
- Declare discovery metadata mapping the route `/api/joke` to a structured catalog item.

## Finding it in the Bazaar

The facilitator you point it to (`http://localhost:3402` by default) will crawl the resource on its next auto-indexing pass (or instantly upon a payment attempt). 

You can manually verify it is available in the catalog by running:
```bash
curl "http://localhost:3402/discovery/search?query=joke"
```
You should see your local `http://localhost:3401/api/joke` endpoint returned as a searchable, paid tool.
