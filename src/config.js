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

  const networks = [TESTNET];
  const perNetwork = {
    [TESTNET]: {
      secret,
      rpcUrl: env.STELLAR_RPC_URL,
      maxTransactionFeeStroops: Number(env.MAX_TX_FEE_STROOPS ?? 50_000),
    },
  };

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

  return {
    port: Number(env.PORT ?? 3402),
    networks,
    perNetwork,

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
