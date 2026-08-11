# x402-facilitator-stellar — conformance spike

**Status: spike.** This exists to answer one question before the SCF RFP proposal commits
to milestones: *can an unmodified canonical x402 client complete a payment against a
facilitator we operate, on Stellar testnet?* It is not a production facilitator and makes
no availability claim.

Licence: Apache-2.0 — permissive OSI-approved, matching upstream `@x402/*` so work here
can be contributed back.

## What it is

A transport shell around `@x402/stellar`'s `ExactStellarScheme`, exposing the standard
facilitator surface:

| Route | Purpose |
|---|---|
| `GET /supported` | Supported kinds, extensions, signers — including the Stellar `extra` block with `areFeesSponsored` |
| `POST /verify` | `{paymentPayload, paymentRequirements}` → `VerifyResponse` |
| `POST /settle` | `{paymentPayload, paymentRequirements}` → `SettleResponse` |
| `GET /healthz` | Liveness |

**What this repo does not do:** implement verification or settlement. `ExactStellarScheme`
already validates auth-entry structure and credential type, expiration against a max
ledger, facilitator safety, absence of sub-invocations, payer-signature status, and that
simulation shows exactly one transfer event matching the expected sender, recipient,
amount and asset. Reimplementing that is what the RFP tells respondents not to do, and it
is the part most dangerous to get subtly wrong.

## Setup

Requires Node ≥20 and the Stellar CLI.

**Three distinct accounts are required.** `ExactStellarScheme` rejects a payment where the
facilitator is party to the transfer, so payer, recipient, and facilitator cannot overlap
— reusing the merchant key as the facilitator key fails verification on the first request.

```bash
stellar keys generate facilitator --network testnet --fund   # if not already done
export FACILITATOR_SECRET=$(stellar keys show facilitator)
npm install
npm start
```

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `FACILITATOR_SECRET` | *required* | `S…` secret for the testnet signer |
| `PORT` | `3402` | |
| `STELLAR_RPC_URL` | package default | Public testnet RPC is fine here; a provider URL is wanted for pubnet |
| `MAX_TX_FEE_STROOPS` | `50000` | Fee ceiling per settlement. Configurable, never hard-wired |
| `FACILITATOR_API_KEYS` | *(unset)* | Comma-separated. Unset = open, which is correct for free testnet and logged at boot |
| `ENABLE_PUBNET` | `false` | Requires `FACILITATOR_SECRET_PUBNET`; refuses to start otherwise |

Pubnet is opt-in behind its own secret on purpose: accidentally running a mainnet
facilitator from a testnet-shaped config loses real money.

## Conformance intent

Acceptance for the real deliverable (RFP §3.6) is tested at the wire level with stock SDK
code, not by reading a claim. This spike targets the subset that can be proven on testnet:

- [ ] Unmodified canonical client completes a payment end-to-end
- [ ] `/supported` emits the Stellar `extra` block including `areFeesSponsored`
- [ ] `payload: {transaction}` accepted verbatim
- [ ] Non-null `reason` on every rejection — including malformed requests and unexpected
      exceptions, which is why neither path returns a bare 500
- [ ] Settled transaction hash published

Out of scope for the spike, required for the deliverable: pubnet, the x402 repo's e2e
suite, and the `upto` scheme.

## Known gaps

- **One signer.** `ExactStellarScheme` accepts an array with a round-robin `selectSigner`,
  plus an optional `feeBumpSigner` that decouples fee payment from sequence-number
  management. That pair is the answer to §3.5's throughput requirement. One signer proves
  conformance; it will not serve bursty agent traffic.
- **No Bazaar.** Discovery and automatic cataloging — the substance of the RFP — are not
  here. This spike is only about proving the payment path.
- **No persistence, metering, or rate limiting.**
