# Privacy, User Tracking, and Data Minimisation Policy

This document outlines our approach to user tracking, data minimisation, and data retention within the X402 Facilitator service. Our goal is to collect only what is strictly necessary to operate the service and nothing more.

## 1. What is Collected

Data collection is strictly scoped by subsystem:

- **Request Logs**: We collect timestamps, endpoint paths, response status codes, and latency metrics. IP addresses are used only transiently for rate limiting. *(Note: Request logging is not yet implemented. See [Issue #7](https://github.com/accensa/x402-facilitator-stellar/issues/7))*
- **Settlement Records**: For successful settlements, we store transaction identifiers (hashes), amounts, seller endpoints, and the payer's Stellar account ID necessary for refund routing. *(Note: Durable storage of settlement records is not yet implemented. See [Issue #10](https://github.com/accensa/x402-facilitator-stellar/issues/10))*
- **Catalog Entries (The Bazaar)**: Seller endpoints, offered resources, prices, and descriptive metadata as submitted by the seller.
- **Search Queries**: Search terms used in the Bazaar are recorded for query evaluation and quality improvement (hybrid search ranking). *(Note: Search query collection is not yet implemented. See [Issue #25](https://github.com/accensa/x402-facilitator-stellar/issues/25))*
- **Usage Counters**: Aggregated metrics on request volumes, settlement success rates, and active seller counts.

## 2. What is Deliberately Not Collected

We do not collect or retain the following (this is verifiable in our codebase):

- **IP Addresses**: Not retained beyond transient rate-limiting memory windows.
- **Agent Fingerprinting**: No cross-request tracking of user-agents or browser fingerprints.
- **Query-to-Payer Linking**: Search queries are *never* linked to a payer's identity, IP, or settlement records.
- **Auth-Entry Material**: No secrets, auth tokens, or exact cryptographic signatures are recorded in our application logs.

## 3. Search-Query Handling

Search queries submitted to the Bazaar are highly sensitive as they reveal user intent. 
- Queries are temporarily retained for evaluating search performance (e.g., hybrid retrieval accuracy).
- They are **never linked to a payer's identity**.
- Queries are aggregated and anonymized before being used for any search tuning.
- All raw query data is subject to our strict 30-day retention policy.

*(Note: Search query retention and anonymization controls are pending the implementation of query collection. See [Issue #50](https://github.com/accensa/x402-facilitator-stellar/issues/50) and [Issue #25](https://github.com/accensa/x402-facilitator-stellar/issues/25))*

## 4. The Public Catalog Tension

The Bazaar acts as a **public catalog**. When a seller registers their endpoint and pricing, this metadata is intentionally published and indexed to allow buyers to discover resources. 

We acknowledge the tension between building a useful, discoverable catalog and a seller's potential expectation of privacy regarding their pricing. 
- **By registering with the Bazaar, sellers explicitly opt-in to having their endpoint and pricing metadata published.** 
- If a seller requires private pricing or unlisted endpoints, they should operate outside the public Bazaar index.
- We may publish aggregate statistics (e.g., average prices for resource categories), but these are always aggregated so a single seller's activity cannot be reconstructed.

## 5. Access Control

Operator access to settlement and query data is strictly limited:
- Only authorized operators have read access to the production database for debugging and support purposes.
- All access to this data is logged and periodically audited.

*(Note: The production database and access audit logging are not yet implemented. See [Issue #10](https://github.com/accensa/x402-facilitator-stellar/issues/10) and [Issue #50](https://github.com/accensa/x402-facilitator-stellar/issues/50))*

## 6. Self-Hosting as the Privacy Answer

If an operator or a consortium does not wish to share this data with our hosted instance, **self-hosting is a fully supported alternative**. 
You can run your own instance of the X402 Facilitator. By doing so, you retain complete physical and logical control over all request logs, settlement records, and search queries within your environment.

## 7. Retention Periods and Enforcement

We adhere to the following retention periods:
- **Request Logs**: 7 days.
- **Search Queries**: 30 days.
- **Settlement Records**: 90 days (retained longer for dispute resolution and refund processing).

### Enforcement

These retention periods represent the policy the service commits to. The automated deletion job (`scripts/data_retention_job.js`) to enforce these periods is not yet implemented. This work is currently tracked in [Issue #50](https://github.com/accensa/x402-facilitator-stellar/issues/50).
