/**
 * Process entrypoint.
 *
 * Resolves configuration, builds the facilitator, the rate limiter, the catalog
 * store and the HTTP app, then binds a port. The routes live in app.js so they
 * can be exercised in a test without a listener, a real signer or a subprocess —
 * this file is only the wiring a test has no use for.
 */
import { resolveConfig } from './config.js';
import { buildFacilitator } from './facilitator.js';
import { installRpcRetry } from './rpc-retry.js';
import { RateLimiter } from './rate-limit.js';
import { createRateLimitStore } from './rate-limit-store.js';
import { MemoryCatalogStore } from './catalog/memory.js';
import { createApp } from './app.js';

// Must run before the scheme makes any RPC call. Retries connection-level
// failures only; see rpc-retry.js for what that deliberately excludes. The
// returned handle exposes circuit-breaker state for the readiness probe (#100).
const rpc = installRpcRetry({
  log: msg => console.warn(`  ${msg}`),
  onStateChange: msg => console.warn(`  [Breaker] ${msg}`),
});

const config = resolveConfig();

// Issue #94: limiter state lives behind a store interface. RATE_LIMIT_STORE is
// unset by default -> in-memory Map, exactly the pre-#94 behaviour. Set it to
// 'postgres' (with DATABASE_URL) to share counters across replicas and keep the
// daily fee ceiling alive across restarts. A misconfiguration refuses to start:
// silently falling back to per-process memory would double every limit at two
// replicas and reset the fee ceiling at every deploy — the bug this fixes.
const rateLimitStore = createRateLimitStore();
rateLimitStore.ready?.catch(err => {
  console.error(`[RateLimit] shared store failed to initialise: ${err.message}`);
});

const { facilitator, signers } = buildFacilitator(config);
const rateLimiter = new RateLimiter(config.rateLimits, rateLimitStore);
const catalog = new MemoryCatalogStore(config);
const app = createApp(config, facilitator, rateLimiter, catalog, {
  breakerStates: rpc?.getBreakerStates,
});

app.listen(config.port, () => {
  console.log(`x402 Stellar facilitator listening on :${config.port}`);
  console.log(`  networks : ${config.networks.join(', ')}`);
  for (const network of config.networks) {
    const netConfig = config.perNetwork[network];
    console.log(`  [${network}]`);
    console.log(`    signer : ${signers[network]}`);
    console.log(`    rpc    : ${netConfig.rpcUrl ?? '(package default)'}`);
    console.log(`    max fee: ${netConfig.maxTransactionFeeStroops} stroops`);
  }
  if (config.apiKeys.length === 0) {
    console.log('  auth     : OPEN — no API keys configured (fine for free testnet)');
  } else {
    console.log(`  auth     : ${config.apiKeys.length} API key(s) configured`);
  }
  console.log(`  ratelimit store: ${rateLimitStore.constructor.name}`);
});
