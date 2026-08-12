/**
 * Process entrypoint.
 *
 * Resolves configuration, builds the facilitator, the rate limiter and the HTTP
 * app, then binds a port. The routes live in app.js so they can be exercised in
 * a test without a listener, a real signer or a subprocess — this file is only
 * the wiring a test has no use for.
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
const app = createApp(config, facilitator, rateLimiter);

const catalog = new MemoryCatalogStore();

app.get('/discovery/resources', async (req, res) => {
  let extensions;
  if (req.query.extensions) {
    extensions = Array.isArray(req.query.extensions)
      ? req.query.extensions
      : req.query.extensions.split(',');
  }

  const params = {
    type: req.query.type,
    payTo: req.query.payTo,
    scheme: req.query.scheme,
    network: req.query.network,
    extensions,
    limit: req.query.limit,
    offset: req.query.offset,
  };

  try {
    const result = await catalog.listResources(params);
    let parsedLimit = parseInt(params.limit, 10);
    if (isNaN(parsedLimit)) parsedLimit = 20;

    let parsedOffset = parseInt(params.offset, 10);
    if (isNaN(parsedOffset)) parsedOffset = 0;

    res.json({
      x402Version: 2,
      items: result.items,
      pagination: {
        limit: Math.min(Math.max(1, parsedLimit), 100),
        offset: Math.max(0, parsedOffset),
        total: result.total,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
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
});
