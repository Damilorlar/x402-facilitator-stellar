# Conformance

Conformance here is judged at the wire level: stock SDK code is pointed at this
service rather than a claim being read. The strongest available form of that is
the **x402 project's own end-to-end suite**, unmodified, run against our
facilitator — a suite we wrote can be unconsciously shaped to fit what we built;
the upstream one cannot.

This document records how that suite is invoked, what it requires, and what it
found. It is the artifact; the CI job is the automation that keeps it honest.

<!-- conformance-facilitator-sha: 8c7ccfc -->
<!-- conformance-anchor-date: 2026-08-26 -->
<!-- conformance-staleness-threshold: 50 -->

> **Staleness anchor.** The two HTML comments above record the facilitator commit
> this report was last reconciled against (`conformance-facilitator-sha`), the
> date that reconciliation happened (`conformance-anchor-date`), and how many
> commits main is allowed to advance past it before CI fails the report as stale
> (`conformance-staleness-threshold`). They are parsed by
> `scripts/check-conformance-staleness.mjs` — keep the key names exactly as
> written. When you refresh this report, update the SHA to the current `main`
> HEAD and the date; that resets the counter.

---

## 0. What was run, exactly

A conformance claim without versions is not reproducible. Everything in this
report was produced by the following inputs — pin them before trusting the
conclusions:

| Input | Value |
|---|---|
| Facilitator commit that produced the settled txs | `71743e1` |
| Report last reconciled against | `8c7ccfc` (`main`) on 2026-08-26 |
| Date of the run recorded below | 2026-08-14 |
| Network / scheme | `stellar:testnet` / `exact` |
| Canonical client | `x402-foundation/x402` TypeScript `http/fetch` client, upstream `main` (unpinned at run time; the CI job now pins and records the upstream SHA) |
| `@x402/stellar` (verify / settle — not reimplemented here) | declared `^2.21.0` (see `package.json`) |
| `@x402/core` | declared `^2.21.0` |
| `@x402/extensions` (bazaar) | declared `^2.23.0` |
| `@stellar/stellar-sdk` | declared `^16.2.0` |

The declared semver ranges are the versions the run resolved against; the locked
resolutions live in `package-lock.json` and are what CI installs via `npm ci`.

---

## 0b. Settled transaction hashes (per network, per scheme)

Clickable `stellar.expert` links a reviewer can verify independently. These are
the canonical acceptance artifact — a published, settled, on-chain transaction
hash is the thing a reviewer checks instead of this prose.

| Network | Scheme | Transaction | Ledger | Settled |
|---|---|---|---|---|
| `stellar:testnet` | `exact` | [`5f1bd15a…5558`](https://stellar.expert/explorer/testnet/tx/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558) | 4134781 | 2026-08-14T08:15:33Z |
| `stellar:testnet` | `exact` | [`ff798145…0590`](https://stellar.expert/explorer/testnet/tx/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590) | 4134928 | 2026-08-14T08:27:49Z |
| `stellar:pubnet` | `exact` | — | — | blocked on #17, see §4 |

`pubnet` has no settled hash because this service is not yet deployed there
([#17](https://github.com/accensa/x402-facilitator-stellar/issues/17)). A stale
report with a missing row is honest; a report that invented one would not be.

---

## 1. Where the suite lives, and what shape it is

`x402-foundation/x402` → [`e2e/`](https://github.com/x402-foundation/x402/tree/main/e2e).

It is **not** a test file you point at a URL. It is a matrix harness that spawns
components — clients, resource servers and facilitators — and runs every valid
combination of the ones you select. Layout is `role/language/transport/component`.

The parts that matter to us:

| Path | What it is |
|---|---|
| `e2e/test.ts` | Entry point, run via `pnpm test` |
| `e2e/config/mechanisms_<id>.json` | Source of truth per network — env, CAIP-2 identity, routes |
| `e2e/facilitators/{typescript,go,python}` | The reference facilitators the suite ships |
| `e2e/facilitators/external-proxies/` | **Where a third-party facilitator plugs in.** Gitignored upstream |
| `e2e/src/proxy-base.ts` | Spawns a component and waits for a ready line on stdout |

### Stellar is a first-class family upstream

From [`e2e/config/mechanisms_stellar.json`](https://github.com/x402-foundation/x402/blob/main/e2e/config/mechanisms_stellar.json):

```json
{
  "env": {
    "SERVER_STELLAR_ADDRESS":         { "required": true, "roles": ["server"] },
    "CLIENT_STELLAR_PRIVATE_KEY":     { "required": true, "roles": ["client"] },
    "FACILITATOR_STELLAR_PRIVATE_KEY":{ "required": true, "roles": ["facilitator"] }
  },
  "testnet": { "caip2": "stellar:testnet", "rpcUrlDefault": "https://soroban-testnet.stellar.org" },
  "mainnet": { "caip2": "stellar:pubnet",  "rpcUrlDefault": "https://mainnet.sorobanrpc.com" },
  "routes": {
    "/exact/stellar": { "scheme": "exact", "sdks": ["typescript"], "price": { "usd": "$0.001" }, "extensions": ["bazaar"] }
  }
}
```

Three things worth reading off that:

- the paid route is **`/exact/stellar` at $0.001**, `exact` scheme, TypeScript SDKs only;
- it declares the **`bazaar` extension**, so the discovery work in this repo is on
  the same path the suite exercises;
- `stellar:pubnet` is already defined upstream, so pubnet conformance is a
  configuration change rather than an upstream contribution.

## 2. How an external facilitator plugs in

`e2e/facilitators/external-proxies/` is the documented, supported place for a
facilitator whose implementation does not live in the x402 repository. Upstream
gitignores the directory, so **the component lives here and is copied in at run
time**. It is in [`e2e/accensa-proxy/`](../e2e/accensa-proxy).

Two mismatches have to be bridged, and both are declarations rather than changes
to the service:

| Harness expects | This service does | Bridge |
|---|---|---|
| the literal string `Facilitator listening` on stdout (case-sensitive, `src/proxy-base.ts`) | prints `x402 Stellar facilitator listening on :PORT` — lowercase `f`, so it misses | `run.sh` waits for readiness and then emits the expected line |
| health at `/health` | serves `/healthz` | `test.config.json` declares `endpoints: [{ "path": "/healthz", "health": true }]` |

**The proxy does not proxy.** It starts this service on the port the harness
assigns and gets out of the way, so the harness talks straight to our HTTP
surface. An adapter that reshaped requests or responses would make the entire
exercise worthless — the thing under test is the wire format.

### Accounts

Three distinct funded testnet accounts are required, and that is not stylistic:
`ExactStellarScheme` rejects any payment where the facilitator is a party to the
transfer, so payer, recipient and facilitator must be three different keys or
verification fails on the first request.

[`scripts/fund-testnet-accounts.mjs`](../scripts/fund-testnet-accounts.mjs)
generates and friendbot-funds them per run and prints them as env assignments.
Fresh accounts rather than repository secrets: three funded keys stored in CI
configuration forever, rotated by nobody, is a worse arrangement than generating
them for the ninety seconds they are needed. There is deliberately no pubnet
path in that script — friendbot does not exist there, and pubnet conformance is
a separate, deliberate operational step.

## 3. Running it

```bash
git clone --depth 1 https://github.com/x402-foundation/x402.git
cd x402/e2e

pnpm install:all          # NOT `pnpm install` — see the note below

mkdir -p facilitators/external-proxies/accensa
cp /path/to/x402-facilitator-stellar/e2e/accensa-proxy/* facilitators/external-proxies/accensa/

node /path/to/x402-facilitator-stellar/scripts/fund-testnet-accounts.mjs > .env
echo "ACCENSA_FACILITATOR_DIR=/path/to/x402-facilitator-stellar" >> .env

pnpm test --testnet --families=stellar --facilitators=accensa --min -v
```

> **`pnpm install` is not sufficient.** `install:all` is `pnpm install && ./setup.sh`,
> and `setup.sh` is what builds the workspace `@x402/*` packages the spawned
> servers import. With `pnpm install` alone the harness starts, selects scenarios
> and boots facilitators, then every server fails with
> `Cannot find module '@x402/express/dist/cjs/index.js'`. Node **22 or newer** is
> also required: the repo pins `pnpm@11.1.1`, which needs `node:sqlite`.

Selecting `--facilitators=accensa` runs only ours. Without it the harness also
starts its own reference facilitators, and a failure in one of those aborts the
run before ours is exercised — which is a property of the harness, not evidence
about this service.

## 4. Results

### 2026-08-14 — first payments settled on testnet; 1 of 5 server components passes

The previous section closed by saying this one would be written with the first
real result, pass or fail. It is both.

**Two runs, `71743e1` against upstream `main`, twelve minutes apart.** Each
settled exactly one payment on Stellar testnet, and each failed four scenarios.

#### What passed — and it is the headline claim of this repository

An **unmodified canonical client** (`typescript/http/fetch`) requested a
paywalled route, received a `402` with terms, signed a payment authorization,
retried, and this facilitator verified it and settled it on-chain. The fee was
paid by the facilitator's own account, so `areFeesSponsored` is not just
advertised in `/supported` — it is what happened.

| Run | Transaction | Ledger | Settled |
|---|---|---|---|
| 1 | [`5f1bd15a…5558`](https://stellar.expert/explorer/testnet/tx/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558) | 4134781 | 2026-08-14T08:15:33Z |
| 2 | [`ff798145…0590`](https://stellar.expert/explorer/testnet/tx/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590) | 4134928 | 2026-08-14T08:27:49Z |

Both return `"successful": true` from Horizon. Check them yourself:

```bash
curl -s https://horizon-testnet.stellar.org/transactions/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558 \
  | jq '{successful, ledger, created_at}'
```

#### What failed — four of five, and it is structural

| Server component | Run 1 | Run 2 | Failure |
|---|---|---|---|
| `typescript/http/next` | ✅ (5th) | ✅ (3rd) | — |
| `typescript/http/express` | ❌ | ❌ | `Payment response header not found` |
| `typescript/http/fastify` | ❌ | ❌ | `Payment response header not found` |
| `typescript/http/hono` | ❌ | ❌ | `402 facilitator_error` |
| `typescript/mcp` | ❌ | ❌ | `402 facilitator_error` |

The two runs are reported together because the harness ordered the combinations
differently in each, and that difference is the only useful control available.
`next` passed from position 5 and again from position 3, while the same four
failed in both. **So this is not flakiness, not USDC propagation lag, and not
the treasury draining** — the first hypothesis after run 1 was that only the
last combination passed because the payer's balance needed time to propagate,
and run 2 disproves it.

Exactly one settlement occurs per run, so the four failures never reached the
chain at all. The one structural difference visible from outside is the route:
`next` is exercised at `/api/exact/stellar/withX402`, the other four at
`/exact/stellar` and `exact_stellar`.

#### Why this cannot be diagnosed further today

The facilitator produced **four lines of output across an entire run** — three
startup banners and an exit code:

```
[facilitators/external-proxies/accensa] stdout: x402 Stellar facilitator listening on :4027
[facilitators/external-proxies/accensa] stdout:   networks : stellar:testnet
[facilitators/external-proxies/accensa] stdout: Facilitator listening on :4027
[facilitators/external-proxies/accensa] Process exited with code 143
```

No request log, no verify or settle outcome, no rejection reason. Two of the
four failures return upstream's `facilitator_error`, which means *this service
returned an error* — and there is no record of what it was. Whether the other
two are ours or upstream's is likewise unknowable from here.

That makes [#7](https://github.com/accensa/x402-facilitator-stellar/issues/7)
(structured logging, request correlation, `/metrics`) the blocking item for this
document, not a nice-to-have. It is tracked against these runs in
[#64](https://github.com/accensa/x402-facilitator-stellar/issues/64).

#### A Bazaar finding, on the passing scenario

```
[Catalog] Hard drop: invalid_routeTemplate
[x402] extension responses: {"bazaar":{"status":"rejected","code":"invalid_routeTemplate"}}
```

Upstream's server registers wildcard `*` route templates; this repo's catalog
validation hard-drops them. This is the **first time another party's client has
touched this catalog**, and the listing was rejected. Filed as
[#65](https://github.com/accensa/x402-facilitator-stellar/issues/65).

### 2026-08-12 — integration verified, payment path not yet exercised

Run locally against `x402-foundation/x402@main`, Stellar family, testnet.

**What is proven:**

| | |
|---|---|
| The harness discovers our facilitator as an external component | ✅ |
| It is selected into the scenario matrix (`facilitator(accensa-stellar-v2)`) | ✅ |
| It boots under the harness on an assigned port | ✅ |
| The ready-line bridge works | ✅ `Facilitator listening on :4027` |
| The harness health check passes | ✅ `Facilitator health check 1/10: ✅` |
| Five server/facilitator combinations are built against it | ✅ express, fastify, hono, next, mcp |

```
🏛️ Starting facilitator: accensa on port 4027
[facilitators/external-proxies/accensa] stdout: x402 Stellar facilitator listening on :4027
[facilitators/external-proxies/accensa] stdout: Facilitator listening on :4027
 🔍 Facilitator health check 1/10: ✅
  ✅ Facilitator accensa ready at http://localhost:4027

🔧 Server/Facilitator combinations: 5
   • typescript/http/express + accensa: 1 test(s)
   • typescript/mcp + accensa: 1 test(s)
   • typescript/http/next + accensa: 1 test(s)
   • typescript/http/hono + accensa: 1 test(s)
   • typescript/http/fastify + accensa: 1 test(s)
```

**What is not yet proven, and why.** No payment completed. The run stopped
before any scenario executed. Two causes, both in how the harness was invoked
rather than in this service:

1. `--facilitators=accensa` was omitted, so the harness also started its own
   reference facilitator, which died on a missing `@x402/aptos` and aborted the
   whole run before any of our scenarios executed.
2. `pnpm install` was used instead of `pnpm install:all`, so the upstream
   *servers* could not start either:

```
Error: Cannot find module '/…/e2e/servers/typescript/node_modules/@x402/express/dist/cjs/index.js'
[servers/typescript/http/express] Process exited with code 1 during startup
```

Both are invocation problems in the environment the harness was run in, not
findings about this facilitator. **They are recorded here rather than omitted**,
because a conformance document that lists only what passed is one that was not
looked at hard enough — and because the next person to run this will hit exactly
these two things.

So the honest statement today is: **this facilitator is accepted by the upstream
harness as a conforming external facilitator and passes its health gate; whether
an unmodified upstream client completes a payment against it is untested.** The
scheduled CI job exists to answer that, and this section will be updated with
its first result — pass or fail.

### Acceptance items

Current as of 2026-08-14.

| Item | State | Evidence |
|---|---|---|
| Canonical client completes a payment, testnet | ✅ | [`5f1bd15a…`](https://stellar.expert/explorer/testnet/tx/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558) and [`ff798145…`](https://stellar.expert/explorer/testnet/tx/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590), both `successful` on Horizon |
| Canonical client completes a payment, pubnet | ⬜ | blocked on #17 |
| `/supported` emits `extra.areFeesSponsored` | ✅ | `test/app.test.js`; and observed — the facilitator paid the fee on both settlements above |
| `payload: {transaction}` accepted verbatim | ✅ | `test/app.test.js` |
| Upstream e2e suite, testnet | 🟡 | **1 of 5 server components passes.** `next` ✅; `express`, `fastify`, `hono`, `mcp` ❌ — reproducible across two runs, see above and #64 |
| Upstream e2e suite, pubnet | ⬜ | blocked on #17 |
| Non-null reason on every rejection | ✅ | `test/app.test.js`, across four malformed-body shapes on both routes |
| Settled tx hash published per network per scheme | 🟡 | testnet `exact` published above; pubnet blocked on #17. #18 |
| Bazaar listing accepted by a third-party client | ❌ | first attempt rejected `invalid_routeTemplate`, #65 |
| `__check_auth` smart-account payer | ⬜ | #13 |
| Structured logs sufficient to diagnose a failure | ❌ | four lines per run; #7, blocking #64 |

## 5. Automation

[`.github/workflows/conformance.yml`](../.github/workflows/conformance.yml) runs
this daily and on demand, separately from `ci.yml`.

Separate on purpose: the job depends on testnet, on friendbot and on a
third-party repository at whatever state its main branch is in today. Any of
those can be down without anything being wrong with this service, and a red
build nobody believes is worse than no build. It publishes the full output as an
artifact, records the upstream SHA it tested against, and fails loudly rather
than going quietly amber.

## 6. Reproducing this yourself

Everything above is reproducible from a clean clone with the commands in §3. The
only inputs are a network connection and Node 22+; the accounts fund themselves.
If you get a different result, that is a bug report worth filing — the README
says a conformance failure is the most useful contribution to this repo, and it
means it.

### 6a. Verify the settled transactions yourself (two read-only commands)

You do not need to run the suite to trust the headline claim. These two commands
hit Stellar's public Horizon API and report what the chain says — no clone, no
account, no secret:

```bash
# Run 1 — was it settled, and was it successful?
curl -s https://horizon-testnet.stellar.org/transactions/5f1bd15aec8ca3c6390689ed7fed82506f6c3d8eb8ed325a05a8b83974925558 \
  | jq '{successful, ledger, created_at}'

# Run 2 — same question, independent hash
curl -s https://horizon-testnet.stellar.org/transactions/ff798145681ad66e20f39f60d91895e993bc8033bbc78847aa5ddf0ee1e70590 \
  | jq '{successful, ledger, created_at}'
```

Both return `"successful": true`. For the same data through the explorer UI, open
the `stellar.expert` links in §0b. Either path lets a third party confirm the
transactions without asking us for anything.

### 6b. Reproduce the full run

```bash
git clone --depth 1 https://github.com/x402-foundation/x402.git
cd x402/e2e
pnpm install:all
mkdir -p facilitators/external-proxies/accensa
cp /path/to/x402-facilitator-stellar/e2e/accensa-proxy/* facilitators/external-proxies/accensa/
node /path/to/x402-facilitator-stellar/scripts/fund-testnet-accounts.mjs > .env
echo "ACCENSA_FACILITATOR_DIR=/path/to/x402-facilitator-stellar" >> .env
pnpm test --testnet --families=stellar --facilitators=accensa --min -v
```

The `conformance.yml` workflow runs this nightly and publishes the full output as
an artifact, so the linked evidence in §4 is regenerated rather than asserted.
