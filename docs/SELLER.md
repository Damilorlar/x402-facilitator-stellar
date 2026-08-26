# Seller Guide

1. **Add X402 to an existing Express API:** Add the `@x402/core` middleware to intercept requests.
2. **Choose an asset and price:** If you price in an issued asset (USDC is the default), **establish a trustline for it first** — see [Trustlines](#trustlines) below. This is the step developers coming from other chains most often miss, and it is the most common way the first x402 payment fails.
3. **Declare discovery metadata:** Provide metadata on your endpoints using our Stellar-shaped SDK helpers:
   
   *Before:*
   ```javascript
   // Manual declaration without helpers (error-prone stroop conversion)
   app.get('/api/resource', x402({
       pricing: { amount: '25000000', asset: 'XLM' },
       network: 'stellar:testnet',
       scheme: 'exact'
   }), (req, res) => { /* ... */ });
   ```
   
   *After:*
   ```javascript
   // With discovery helpers
   import { createStellarDiscoveryResource } from 'x402-facilitator-stellar/sdk';
   
   app.get('/api/resource/{id}', x402(createStellarDiscoveryResource({
       routeTemplate: '/api/resource/{id}',
       parameters: { id: 'The resource ID' },
       pricing: { amount: '2.5', asset: 'XLM' }
   })), (req, res) => { /* ... */ });
   ```
   
   Amounts are given as **decimal strings** (e.g. `'2.5'`), never JavaScript numbers, and must have **at most 7 decimal places** — Stellar amounts are 7-decimal fixed point (stroops). `toStroops` rejects anything finer than a stroop rather than silently rounding your price, and rejects numbers outright because they have usually lost precision before conversion. A non-numeric or over-precise amount fails validation with a structured message, not a low-level parse error.
   
   You can also validate your metadata offline without making payments:
   ```bash
   npx validate-discovery metadata.json
   ```
4. **Verify listing:** Check the Bazaar endpoint to ensure you are listed.
5. **Troubleshooting:**
   - *Error: Trustline missing.* Establish a trustline for the asset your endpoint prices in — see below.
   - *Error: Invalid signature.* Ensure the agent signs with the correct private key.

## Trustlines

### What a trustline is, and why Stellar needs one

On Stellar, an account can only hold an asset issued by someone else if it has first authorized that issuer with a **trustline** — a `changeTrust` operation declaring "I accept this asset from this issuer, up to this limit". It is how Stellar prevents an account from being flooded with worthless tokens it never agreed to hold. It applies to every issued asset (USDC, and any other SEP-41 token), **but not to the native asset XLM**, which needs no trustline.

This matters for x402 in two directions, and both are easy to get wrong:

- **The seller (you) must trust the payment asset.** A payment into your account fails if you have no trustline for the asset it is priced in — the seller without a trustline cannot be paid. This is the one you control.
- **The buyer must trust it too.** The payer needs a trustline *and a balance* of the asset to spend it. You cannot fix that for them, but you can state it plainly in your listing's pricing so an agent knows what it must hold.

### Who needs which trustline

| Party | Trustline needed? | Notes |
|---|---|---|
| Seller / payee | **Yes, for the priced asset** (USDC by default) | Without it, settlements to you fail. |
| Buyer / payer | **Yes, for the priced asset** | Needs a trustline and a balance; it cannot spend what it cannot hold. |
| Facilitator | No | It only sponsors fees in XLM and is never a party to the transfer. |
| Anyone paying in XLM | No | Native XLM needs no trustline. |

### Establishing a trustline

**Testnet — one command.** The repository ships a helper that funds fresh testnet accounts *and* opens a USDC trustline on each:

```bash
npm run fund:testnet
```

It creates three accounts (client, server/payee, facilitator), funds them via Friendbot, and runs a `changeTrust` for testnet USDC on each — then prints the credentials as env assignments (`--json` for machine-readable, `--github-env` for CI). See `scripts/fund-testnet-accounts.mjs`.

For an existing account (e.g. the one your example server uses), run the USDC-preparation helper, which adds trustlines to the payer and payee accounts it is pointed at:

```bash
CLIENT_STELLAR_PRIVATE_KEY=<payer secret> \
SERVER_STELLAR_ADDRESS=<payee address> \
SERVER_STELLAR_PRIVATE_KEY=<payee secret> \
npm run prepare:testnet-usdc
```

`TESTNET_USDC_TREASURY_SECRET` funds the payer's balance; without it the script reports `usdc_ready=false` honestly (trustlines are useless without a balance). See `scripts/prepare-testnet-usdc.mjs`. The [HTTP seller example](../examples/http-seller/README.md) demonstrates the same setup.

**Mainnet.** The mechanism is identical but the funding is not: Friendbot does not exist on pubnet. You create the trustline with the same `changeTrust` operation, from an account that already holds XLM to pay the transaction fee, using the mainnet network passphrase (`Networks.PUBLIC`). Because pubnet USDC is issued by a different issuer (Circle's production issuer), make sure the asset code+issuer pair you trust matches the one your listing prices in. Funding is yours to arrange — an exchange withdrawal or another account that already holds the asset. The scripts above are testnet-only by construction; pubnet trustlines are a deliberate, separate operational step.

### What the failure looks like (and what the facilitator can and cannot tell you)

A missing trustline is **not currently named at the point of failure**. The transaction dies in Soroban simulation with a host error like `Error(Contract, #13) "trustline entry is missing for account"`, and the upstream `ExactStellarScheme` reports that as a generic `invalid_exact_stellar_payload_simulation_failed` (see `docs/REASONS.md`) — the transport passes scheme results through untouched, and it does not have a distinct `trustline_missing` code. A developer hitting this sees "simulation failed" and has to know to check trustlines.

That is exactly why the prerequisite is documented here and in the examples rather than left to the error message: **establish the trustline before the first payment**, and you never meet this failure mode. Detecting and naming it distinctly at failure time is a potential follow-up, but the safe path is the one this guide documents — set it up up front.
