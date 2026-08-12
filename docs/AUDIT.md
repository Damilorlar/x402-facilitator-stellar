# Audit-Readiness Package

## Proposed Scope
The scope of the audit includes the HTTP transport, configuration, authentication, and operational concerns implemented in this repository (`x402-facilitator-stellar`).

**Out of Scope (Upstream):** 
The core verification and settlement logic is explicitly **out of scope**. This includes auth-entry structure validation, expiration checks, facilitator safety checks, and simulation of the Stellar transfer. These are handled by the Apache-2.0 `ExactStellarScheme` from `@x402/stellar`, which should be audited separately.

## Trust Boundaries
- **External Network (Untrusted):** Buyer agents, resource servers, and Bazaar search clients.
- **API Boundary (Verified):** Requests matching valid API keys (if configured) or passing rate limits.
- **Upstream RPC (Trusted but Unreliable):** The Stellar RPC endpoint.
- **Database (Trusted):** The persistent store for logs, settlement records, and the Bazaar catalog.

## Security-Relevant Invariants
An auditor should attempt to break the following invariants:
1. The facilitator never settles an authorization where it is a party to the transfer.
2. A single request cannot consume more than `MAX_TX_FEE_STROOPS` in sponsored fees.
3. Replayed or duplicated `verify` / `settle` payloads are rejected.
4. API keys cannot be bypassed or brute-forced via timing attacks.
5. Catalog entries cannot contain cross-site scripting (XSS) payloads or path traversals.

## Known Issues and Accepted Risks
- **Single Signer Contention:** Currently, only a single signer is used. Under high load, sequence number contention may occur. This is an accepted risk for this conformance spike.
- **RPC Outage Dependency:** The service will fail if the upstream Stellar RPC goes down.
- **Database Access:** Operators with physical access to the DB can view settlement history up to the retention limit.

## Dependencies and Licensing
- Built on `@x402/stellar` (Apache-2.0).
- All dependencies are MIT or Apache-2.0. CI explicitly checks for the absence of AGPL or other viral licenses.
