# Buyer / Agent Guide

1. **Fund a testnet account:** Use the Stellar laboratory or CLI to create and fund a keypair.
2. **Discover a resource:** Query the Bazaar (`GET /discovery/search`) or use the MCP server.
3. **Pay for a call:** 
   ```bash
   curl -X POST -H "Authorization: X402 ..." <resource_url>
   ```
4. **Spending controls:** Ensure your agent checks the `402 Payment Required` terms before signing any payload.
5. **Smart-account payers:** Use multi-sig or smart accounts for policy-based spending.
