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
import { MemoryCatalogStore } from './catalog/memory.js';
import { createApp } from './app.js';

// Must run before the scheme makes any RPC call. Retries connection-level
// failures only; see rpc-retry.js for what that deliberately excludes.
installRpcRetry({ log: msg => console.warn(`  ${msg}`) });

const config = resolveConfig();
const { facilitator, signers } = buildFacilitator(config);
const rateLimiter = new RateLimiter(config.rateLimits);
const catalog = new MemoryCatalogStore();
const app = createApp(config, facilitator, rateLimiter, catalog);

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
});
