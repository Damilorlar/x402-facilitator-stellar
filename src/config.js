/**
 * Configuration, resolved once at boot so a misconfiguration fails at start
 * rather than on the first payment.
 */

import crypto from 'node:crypto';

/** CAIP-2 identifiers. Both are committed deliverables in the RFP, not one or the other. */
export const TESTNET = 'stellar:testnet';
export const PUBNET = 'stellar:pubnet';

/**
 * Networks this instance serves.
 *
 * Defaults to testnet only. Pubnet requires an explicit opt-in *and* its own
 * signer secret, because the failure mode of accidentally running a mainnet
 * facilitator with a testnet-shaped config is losing real money.
 */
export function resolveConfig(env = process.env) {
  const secret = env.FACILITATOR_SECRET;
  if (!secret) {
    throw new Error(
      'FACILITATOR_SECRET is required (S... testnet secret key). ' +
        'Generate one with: stellar keys generate facilitator --network testnet --fund',
    );
  }
  if (!secret.startsWith('S')) {
    throw new Error('FACILITATOR_SECRET must be a Stellar secret key (starts with S).');
  }

  /**
   * Per-network configuration.
   *
   * Signer, RPC endpoint and fee ceiling are all network-specific and are kept
   * that way deliberately: sharing any of them is how a testnet key ends up
   * submitting to pubnet, or how a pubnet scheme ends up simulating against a
   * testnet endpoint.
   */
  const networks = [TESTNET];
  const perNetwork = {
    [TESTNET]: {
      secret,
      rpcUrl: env.STELLAR_RPC_URL,
      maxTransactionFeeStroops: Number(env.MAX_TX_FEE_STROOPS ?? 50_000),
    },
  };

  const rawApiKeys = (env.FACILITATOR_API_KEYS ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  const apiKeys = rawApiKeys.map((keyStr, index) => {
    let id = `key_${index}`;
    let secretPart = keyStr;
    const colonIdx = keyStr.indexOf(':');
    if (colonIdx > 0) {
      id = keyStr.substring(0, colonIdx);
      secretPart = keyStr.substring(colonIdx + 1);
    }
    return {
      id,
      hash: crypto.createHash('sha256').update(secretPart).digest(),
    };
  });

  // Parse Rate Limits
  const parseLimits = str => {
    const limits = {
      verifyRpm: 60,
      settleRpm: 10,
      settleRph: 100,
      settleRpd: 1000,
      feeSpd: 5000000,
      catalogRpm: 10,
    };
    if (!str) return limits;
    str.split(',').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k === 'verify_rpm') limits.verifyRpm = Number(v);
      if (k === 'settle_rpm') limits.settleRpm = Number(v);
      if (k === 'settle_rph') limits.settleRph = Number(v);
      if (k === 'settle_rpd') limits.settleRpd = Number(v);
      if (k === 'fee_spd') limits.feeSpd = Number(v);
      if (k === 'catalog_rpm') limits.catalogRpm = Number(v);
    });
    return limits;
  };

  const rateLimits = {
    global: parseLimits(env.RATE_LIMIT_GLOBAL),
    keys: {},
  };

  for (const k of Object.keys(env)) {
    if (k.startsWith('RATE_LIMIT_') && k !== 'RATE_LIMIT_GLOBAL') {
      const keyId = k.substring(11); // remove RATE_LIMIT_
      rateLimits.keys[keyId] = parseLimits(env[k]);
    }
  }

  if (env.ENABLE_PUBNET === 'true') {
    if (!env.FACILITATOR_SECRET_PUBNET) {
      throw new Error(
        'ENABLE_PUBNET=true but FACILITATOR_SECRET_PUBNET is unset. ' +
          'Refusing to serve pubnet with the testnet signer.',
      );
    }
    if (!env.STELLAR_RPC_URL_PUBNET) {
      throw new Error(
        'ENABLE_PUBNET=true but STELLAR_RPC_URL_PUBNET is unset. ' +
          'Refusing to serve pubnet with the default public endpoint.',
      );
    }
    networks.push(PUBNET);
    perNetwork[PUBNET] = {
      secret: env.FACILITATOR_SECRET_PUBNET,
      rpcUrl: env.STELLAR_RPC_URL_PUBNET,
      maxTransactionFeeStroops: Number(env.MAX_TX_FEE_STROOPS_PUBNET ?? 50_000),
    };
  }

  /**
   * Express `trust proxy` setting, from TRUST_PROXY.
   *
   * Behind a TLS terminator or load balancer, Express's default (off) makes
   * req.ip the proxy's address, which collapses every open-mode caller into a
   * single rate-limit bucket. The value must be specific — a hop count, a list
   * of proxy addresses, or an Express preset like "loopback" — never "true",
   * which trusts the leftmost X-Forwarded-For entry the client wrote itself.
   *
   * Unset means off, which is correct for docker-compose and local development
   * where the port is published directly with no proxy in front.
   */
  const rawTrustProxy = env.TRUST_PROXY?.trim();
  let trustProxy;
  if (rawTrustProxy) {
    if (/^(true|false|yes|no)$/i.test(rawTrustProxy)) {
      throw new Error(
        'TRUST_PROXY must be a hop count, a comma-separated proxy list, or an Express ' +
          `preset (loopback, linklocal, uniquelocal) — got "${rawTrustProxy}". ` +
          '"true" is forbidden: it trusts client-supplied X-Forwarded-For entries.',
      );
    }
    if (/^\d+$/.test(rawTrustProxy)) {
      trustProxy = Number(rawTrustProxy);
    } else {
      trustProxy = rawTrustProxy
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
  }

  /**
   * CORS policy.
   *
   * Origins allowed to call this service from browser JavaScript. Empty means
   * the public read routes fall back to `*` (they carry no credential worth
   * protecting) while the authenticated payment routes get no CORS grant at
   * all — see app.js for why the two route classes are decided separately.
   */
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  return {
    port: Number(env.PORT ?? 3402),

    /**
     * Deployment environment. Unset in the Docker image by default; only used
     * here to decide whether a local .env file is loaded and whether HSTS is
     * sent. Never gate error-detail behaviour on it — see app.js.
     */
    nodeEnv: env.NODE_ENV ?? 'development',
    cors: { allowedOrigins: corsAllowedOrigins },
    networks,
    perNetwork,
    trustProxy,

    /** Optional shared stores. Unset means in-memory, single-instance. */
    redisUrl: env.REDIS_URL || null,
    databaseUrl: env.DATABASE_URL || null,

    /**
     * Redlock nodes (#116): comma-separated independent Redis masters. Quorum
     * needs a majority, so three or more is the intended shape. Empty means
     * in-process locking only (single instance).
     */
    redisNodes: (env.REDIS_NODES ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),

    /**
     * Kafka (#117). Brokers unset means webhooks are delivered directly,
     * fire-and-forget, still off the critical path but without durability.
     */
    kafka: {
      brokers: (env.KAFKA_BROKERS ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
      clientId: env.KAFKA_CLIENT_ID ?? 'x402-facilitator-stellar',
      topic: env.KAFKA_WEBHOOK_TOPIC ?? 'x402-webhook-delivery',
      groupId: env.KAFKA_WEBHOOK_GROUP_ID ?? 'x402-webhook-dispatchers',
    },

    /** Default webhook receiver (#117); events may carry their own url. */
    webhookUrl: env.WEBHOOK_URL || null,

    /**
     * Caller authentication. Unset means open, which is correct for a free
     * testnet instance and wrong for anything else — so the server logs loudly
     * when it is unset (RFP §3.1: the mechanism must be documented and
     * configurable).
     */
    apiKeys,
    rateLimits,
    embeddingsUrl: env.EMBEDDINGS_URL || null,
    enableReranking: env.ENABLE_RERANKING === 'true',
    shutdownGraceMs: Number(env.SHUTDOWN_GRACE_MS ?? 15_000),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 30_000),
  };
}
