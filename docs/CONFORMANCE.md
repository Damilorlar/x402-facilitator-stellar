# Conformance

Conformance here is judged at the wire level: stock SDK code is pointed at this
service rather than a claim being read. The strongest available form of that is
the **x402 project's own end-to-end suite**, unmodified, run against our
facilitator — a suite we wrote can be unconsciously shaped to fit what we built;
the upstream one cannot.

This document records how that suite is invoked, what it requires, and what it
found. It is the artifact; the CI job is the automation that keeps it honest.

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
before any scenario executed, because the upstream *servers* failed to start:

```
Error: Cannot find module '/…/e2e/servers/typescript/node_modules/@x402/express/dist/cjs/index.js'
[servers/typescript/http/express] Process exited with code 1 during startup
```

That is the `pnpm install` vs `pnpm install:all` gap described above — an
install-procedure problem in the environment the harness was run in, not a
finding about this facilitator. **It is recorded here rather than omitted**,
because a conformance document that lists only what passed is one that was not
looked at hard enough.

So the honest statement today is: **this facilitator is accepted by the upstream
harness as a conforming external facilitator and passes its health gate; whether
an unmodified upstream client completes a payment against it is untested.** The
scheduled CI job exists to answer that, and this section will be updated with
its first result — pass or fail.

### Acceptance items

| Item | State | Evidence |
|---|---|---|
| Canonical client completes a payment, testnet | ⬜ | pending first CI run |
| Canonical client completes a payment, pubnet | ⬜ | blocked on #17 |
| `/supported` emits `extra.areFeesSponsored` | ✅ | asserted by `test/app.test.js`; visible in the boot output above |
| `payload: {transaction}` accepted verbatim | ✅ | `test/app.test.js` |
| Upstream e2e suite, testnet | 🟡 | facilitator accepted and healthy; payment path pending |
| Upstream e2e suite, pubnet | ⬜ | blocked on #17 |
| Non-null reason on every rejection | ✅ | `test/app.test.js`, across four malformed-body shapes on both routes |
| Settled tx hash published per network per scheme | ⬜ | #18 |
| `__check_auth` smart-account payer | ⬜ | #13 |

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
