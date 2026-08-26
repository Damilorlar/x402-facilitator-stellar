# Buyer / Agent Guide

1. **Fund a testnet account:** Use the Stellar laboratory or CLI to create and fund a keypair. In this repository, one command creates a fresh funded account and opens the USDC trustline it will need to pay USDC-priced resources:
   ```bash
   npm run fund:testnet
   ```
   (prints credentials as env assignments; see `scripts/fund-testnet-accounts.mjs`).
2. **Trustline check:** If the resource you intend to pay is priced in an issued asset (USDC is the default), **your account needs a trustline for that asset and a balance of it** before the payment can settle. See [Trustlines](#trustlines) below — a buyer without a trustline cannot spend the asset, and the failure surfaces as a generic simulation error, not a friendly "add a trustline" message.
3. **Discover a resource:** Query the Bazaar (`GET /discovery/search`) or use the MCP server.
4. **Pay for a call:** 
   ```bash
   curl -X POST -H "Authorization: X402 ..." <resource_url>
   ```
5. **Spending controls:** Ensure your agent checks the `402 Payment Required` terms before signing any payload.
6. **Smart-account payers:** Use multi-sig or smart accounts for policy-based spending.

## Trustlines

On Stellar an account can only hold — and therefore only spend — an issued asset (USDC, any SEP-41 token) once it has authorized the issuer with a **trustline** (`changeTrust`). Native XLM needs no trustline. The facilitator sponsors the network fee, so the buyer needs **only the payment asset**: the XLM for transaction fees is paid by the facilitator, but the payment asset itself must be trusted *and funded* on your account.

- **Testnet:** `npm run fund:testnet` funds a fresh account and opens the USDC trustline on it in one step. If the seller prices in a different asset, add a trustline for that asset the same way (a `changeTrust` for that issuer).
- **Mainnet:** the same `changeTrust` operation, with the mainnet network passphrase and the issuer of the asset the listing actually prices in. Friendbot does not exist on pubnet — funding comes from an exchange withdrawal or an account that already holds the asset.

The most common first-payment failure on Stellar is a missing trustline on either side of the transfer. When you hit it, the transaction dies in simulation and reads as a generic failure; checking the listing's `asset` and confirming both accounts trust it is the fix.
