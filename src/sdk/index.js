import { validateDiscoveryDeclaration } from './validation.js';
export { validateDiscoveryDeclaration };

const STELLAR_DECIMALS = 7;

export function toStroops(amount) {
    if (!amount) return '0';
    const [intPart = '0', fracPart = ''] = String(amount).split('.');
    const paddedFrac = fracPart.padEnd(STELLAR_DECIMALS, '0').slice(0, STELLAR_DECIMALS);
    return BigInt(intPart + paddedFrac).toString();
}

/**
 * Creates a discovery resource declaration with Stellar-shaped ergonomics.
 * Validates the input and converts human-readable amounts to stroops.
 */
export function createStellarDiscoveryResource(params) {
    const errors = validateDiscoveryDeclaration(params);
    if (errors.length > 0) {
        throw new Error("Invalid discovery declaration:\n - " + errors.join('\n - '));
    }
    
    return {
        ...params,
        network: params.network || 'stellar:testnet',
        scheme: params.scheme || 'exact',
        pricing: {
            ...params.pricing,
            amount: toStroops(params.pricing.amount)
        }
    };
}
