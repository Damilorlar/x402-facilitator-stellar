/**
 * Configuration, resolved once at boot so a misconfiguration fails at start
 * rather than on the first payment.
 */

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
export function resolveNetworks(env = process.env) {
  const networks = [TESTNET];
  if (env.ENABLE_PUBNET === 'true') {
    if (!env.FACILITATOR_SECRET_PUBNET) {
      throw new Error(
        'ENABLE_PUBNET=true but FACILITATOR_SECRET_PUBNET is unset. ' +
          'Refusing to serve pubnet with the testnet signer.',
      );
    }
    networks.push(PUBNET);
  }
  return networks;
}

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

  return {
    port: Number(env.PORT ?? 3402),
    secret,
    secretPubnet: env.FACILITATOR_SECRET_PUBNET,
    networks: resolveNetworks(env),

    /**
     * Custom RPC URL. Optional on testnet — @x402/stellar defaults to the
     * public endpoint. On pubnet a provider URL should be supplied, since the
     * public endpoint is not something to run an availability target against.
     */
    rpcUrl: env.STELLAR_RPC_URL,

    /**
     * Fee ceiling the facilitator will pay per settlement, in stroops.
     * @x402/stellar defaults to 50_000 (0.005 XLM). Configurable rather than
     * hard-wired, per RFP §3.1.
     */
    maxTransactionFeeStroops: Number(env.MAX_TX_FEE_STROOPS ?? 50_000),

    /**
     * Caller authentication. Unset means open, which is correct for a free
     * testnet instance and wrong for anything else — so the server logs loudly
     * when it is unset (RFP §3.1: the mechanism must be documented and
     * configurable).
     */
    apiKeys: (env.FACILITATOR_API_KEYS ?? '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean),
  };
}
