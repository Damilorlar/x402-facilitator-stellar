<div align="center">
  <h1>x402-facilitator-stellar</h1>
  <p><strong>An x402 facilitator for Stellar — verify, settle, supported</strong></p>
  <p>
    <img src="https://img.shields.io/github/actions/workflow/status/accensa/x402-facilitator-stellar/ci.yml?branch=main" alt="CI Status" />
    <img src="https://img.shields.io/badge/status-conformance%20spike-orange.svg" alt="Status: conformance spike" />
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License Apache 2.0" />
    <img src="https://img.shields.io/badge/stellar-testnet-success.svg" alt="Stellar testnet" />
    <img src="https://img.shields.io/badge/x402-v2-blue.svg" alt="x402 v2" />
  </p>
  <p>
    <a href="#conformance"><strong>Conformance</strong></a> ·
    <a href="#documentation"><strong>Documentation</strong></a> ·
    <a href="#known-gaps"><strong>Known Gaps</strong></a> ·
    <a href="https://github.com/accensa"><strong>Accensa org</strong></a> ·
    <a href="https://github.com/x402-foundation/x402"><strong>x402 spec</strong></a>
  </p>
</div>

> Developer infrastructure for x402 on Stellar, built on the Apache-2.0
> [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) package. Independent of
> the merchant back-office in [`accensa-app`](https://github.com/accensa/accensa-app) and
> [`accensa-contracts`](https://github.com/accensa/accensa-contracts) — a seller can use
> those without this, and an agent can use this without those.

> [!WARNING]
> **This is a conformance spike, not a production facilitator.** It exists to answer one
> question: can an unmodified canonical x402 client complete a payment against a
> facilitator we operate on Stellar testnet? **That question is still open** — see
> [Conformance](#conformance) for exactly which boxes are unticked and why. It makes no
> availability claim, is not deployed anywhere you can reach, and has published no settled
> transaction hash.

## The Problem

x402 turns HTTP 402 into a machine-native payment flow: a client requests a resource, the
server replies `402` with terms, the client signs a payment authorization and retries, and
a **facilitator** verifies and settles on-chain before the resource is returned.

The facilitator is the piece a seller cannot easily run themselves. It has to validate
Soroban authorization entries strictly — correctly signed, authorizing exactly the
declared call, asset, amount and recipient, not replayed, not expired — submit the
invocation, and cover the network fee so the buyer needs only the payment asset. Get any
of that subtly wrong and the failure is silent: payments that look settled and are not,
or authorizations that grant more than the payer understood.

## Why Not Reimplement It

`@x402/stellar` already ships `ExactStellarScheme`, which implements the
`SchemeNetworkFacilitator` interface — `verify`, `settle`, `getExtra`, `getSigners` —
and validates:

- auth-entry structure and credential type
- expiration against a maximum ledger
- **facilitator safety** — the facilitator must not be a party to the transfer
- **absence of sub-invocations** — no authorization the payer did not see
- payer signature status, and that no other signatures are pending
- via simulation, that there is **exactly one** transfer event matching the expected
  sender, recipient, amount and asset

None of that is reimplemented here. It is the part most dangerous to get subtly wrong, and
rewriting it would duplicate the package the ecosystem is standardizing on.

**This repo is the transport around it.** `@x402/core` ships no facilitator router — it
gives you `x402Facilitator` with `verify()`, `settle()` and `getSupported()`, and the HTTP
surface is yours to write. That surface, plus configuration, caller authentication and
operational concerns, is what lives here.

## Documentation

Published docs for the whole organisation, including this service, are at
**<https://accensa.github.io/accensa-app/docs/facilitator/overview>**.

In-repo, refer to the [Documentation Hub](docs/README.md) for detailed role-based guides:
- [Seller Guide](docs/SELLER.md)
- [Buyer / Agent Guide](docs/BUYER.md)
- [Operator Guide](docs/OPERATOR.md)

Reference material: [Architecture](docs/ARCHITECTURE.md) ·
[Bazaar discovery](docs/BAZAAR.md) · [MCP server](docs/MCP.md) ·
[Conformance](docs/CONFORMANCE.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Operations](docs/OPERATIONS.md) · [Authentication](docs/AUTHENTICATION.md) ·
[Threat model](docs/THREAT-MODEL.md) · [Audit readiness](docs/AUDIT.md) ·
[Privacy](docs/PRIVACY.md) · [Glossary](docs/GLOSSARY.md)

Sibling repositories in the [Accensa organisation](https://github.com/accensa):
[`accensa-app`](https://github.com/accensa/accensa-app) (merchant dashboard, indexer,
`@accensa/sdk`) and
[`accensa-contracts`](https://github.com/accensa/accensa-contracts) (Soroban receipt
anchoring and refund vault). A seller can use those without this, and an agent can use
this without those.

### Tests

```bash
npm test              # unit tests — no network, no funded account, no .env
npm run lint          # eslint
npm run format:check  # prettier, check only
npm run licenses      # fails on any AGPL in the dependency path
```

All four run in CI on every push and pull request, across Node 20 and 22.

The end-to-end conformance run is separate, because it needs testnet and two
funded accounts:

```bash
FACILITATOR_SECRET=$(stellar keys show facilitator) npm start &
ALICE_SECRET=$(stellar keys show alice) npm run e2e
```

### Privacy and Data Minimisation

The X402 Facilitator handles sensitive transaction and search query data. Our approach is to collect only what is necessary, and to aggressively purge it according to strict retention policies.
For detailed information, see our [Privacy Policy](docs/PRIVACY.md).

## Conformance

Acceptance is tested at the wire level with stock SDK code, not by reading a claim. What
holds today on testnet:

- [x] `/supported` emits the Stellar `extra` block including `areFeesSponsored`
- [x] Every rejection carries a non-null `invalidReason` — across malformed bodies,
      unregistered scheme/network pairs, and scheme-level failures
- [x] The spec's `payload: {transaction}` shape is accepted verbatim
- [ ] An unmodified canonical client completes a payment end-to-end
- [ ] Settled transaction hash published
- [ ] `stellar:pubnet`
- [ ] The x402 repository's e2e suite

**Why the last four are unticked, stated rather than left vague.** The
[conformance workflow](.github/workflows/conformance.yml) runs the upstream
`x402-foundation/x402` e2e suite against this facilitator daily. It has run three times
and passed zero scenarios. The blocker is not this service: `@x402/stellar` resolves the
route's `$0.001` price to Circle's testnet USDC, friendbot funds XLM only, and Circle's
testnet USDC cannot be minted on demand — so every buyer reaches the payment and fails in
simulation with an empty balance:

```
HostError: Error(Contract, #10) "resulting balance is not within the allowed range", 0, -10000
```

Trustlines are now created for payer and payee automatically. A *balance* needs a
pre-funded testnet treasury key supplied as the `TESTNET_USDC_TREASURY_SECRET` repository
secret. Without it the job reports `usdc_ready=false` and **skips the suite rather than
running a matrix that can only fail** — a missing faucet is a prerequisite gap, not a
conformance result about this service. Until that secret exists, treat every box above as
unproven, and see [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md).

Responses use the canonical field names — `VerifyResponse` carries `invalidReason` and
`invalidMessage`; `SettleResponse` carries `errorReason`, `errorMessage`, `transaction`
and `network`. There is no `reason` field, and inventing one produces a service that looks
correct locally and is non-conformant on the wire.

## Known Gaps

- **One signer.** `ExactStellarScheme` accepts an *array* of signers with a round-robin
  `selectSigner`, plus an optional `feeBumpSigner` that decouples fee payment from
  sequence-number management. That pair is how bursty agent traffic avoids sequence
  contention. One signer is enough to prove conformance and not enough to serve load.
- **Bazaar is built but unproven against a second implementation.** Discovery, search and
  automatic cataloging landed on 2026-08-12 and are documented in
  [`docs/BAZAAR.md`](docs/BAZAAR.md): a catalog datastore with migrations,
  `GET /discovery/resources` with the full upstream filter set, `GET /discovery/search`
  with lexical and hybrid (dense-embedding + reranking) retrieval, automatic cataloging
  off the payment path, `EXTENSION-RESPONSES` reporting, and an MCP server
  ([`docs/MCP.md`](docs/MCP.md)). What has *not* happened is any other party's client
  reading this catalog. A search-evaluation harness and judgement set live in `eval/`.
- **No deployment.** There is a `Dockerfile`, a `docker-compose.yml` and
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), but no instance is running at a URL anyone
  can hit. Availability targets and a status page are tracked in
  [#19](https://github.com/accensa/x402-facilitator-stellar/issues/19).
- **No persistence by default.** The catalog has a PostgreSQL schema in `migrations/` and
  uses it when `DATABASE_URL` is set; the settlement path holds nothing durable, tracked
  in [#10](https://github.com/accensa/x402-facilitator-stellar/issues/10).
- **`exact` only.** The `upto` scheme has no Stellar specification yet; design notes in
  [`accensa-contracts/docs/ADR-002`](https://github.com/accensa/accensa-contracts/blob/main/docs/ADR-002-upto-scheme.md).

## Contributing

Issues and pull requests welcome. Given the status above, the most useful contribution is
a conformance failure: point a canonical client at it and report what breaks.

## Contributors

<a href="https://github.com/accensa/x402-facilitator-stellar/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=accensa/x402-facilitator-stellar" />
</a>

## License

Apache-2.0 — see [LICENSE](LICENSE). Chosen to match upstream `@x402/*` so work here can
be contributed back.
