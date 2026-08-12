/**
 * Wires @x402/stellar's ExactStellarScheme into an x402Facilitator.
 *
 * Deliberately thin. ExactStellarScheme already implements verify and settle —
 * including auth-entry structure and credential-type checks, expiration against
 * a max ledger, facilitator-safety (the facilitator must not be party to the
 * transfer), rejection of sub-invocations, payer-signature status, and
 * simulation-event validation that exactly one transfer event matches the
 * expected sender, recipient, amount and asset.
 *
 * None of that is reimplemented here. Reimplementing it is what the RFP tells
 * respondents not to do, and it is also the part most dangerous to get subtly
 * wrong.
 */
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import { createEd25519Signer } from '@x402/stellar';
import { TESTNET, PUBNET } from './config.js';

/**
 * Builds the facilitator.
 *
 * One scheme instance per network rather than one shared across both: the
 * signer, the RPC endpoint and the fee ceiling are all network-specific, and
 * sharing them is how a testnet key ends up submitting to pubnet.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @returns {{ facilitator: x402Facilitator, signers: Record<string,string> }}
 */
export function buildFacilitator(config) {
  const facilitator = new x402Facilitator();
  const signers = {};

  for (const network of config.networks) {
    const netConfig = config.perNetwork[network];

    // createEd25519Signer yields a FacilitatorStellarSigner — address,
    // signAuthEntry, signTransaction.
    const signer = createEd25519Signer(netConfig.secret, network);
    signers[network] = signer.address;

    const scheme = new ExactStellarScheme([signer], {
      // areFeesSponsored defaults true and is surfaced through getExtra() into
      // /supported. Left at the default: the spec currently only supports true,
      // and advertising false while sponsoring would be a conformance failure.
      rpcConfig: netConfig.rpcUrl ? { url: netConfig.rpcUrl } : undefined,
      maxTransactionFeeStroops: netConfig.maxTransactionFeeStroops,

      // NOTE for the real build, not this spike: ExactStellarScheme accepts an
      // *array* of signers with a round-robin selectSigner, and an optional
      // feeBumpSigner that decouples fee payment from sequence-number
      // management. That pair is the answer to RFP §3.5's throughput and
      // sequence-contention requirement. One signer is enough to prove
      // conformance; it is not enough to serve bursty agent traffic.
    });

    facilitator.register(network, scheme);
  }

  return { facilitator, signers };
}

export { TESTNET, PUBNET };
