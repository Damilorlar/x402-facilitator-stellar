# Seller Guide

1. **Add X402 to an existing Express API:** Add the `@x402/core` middleware to intercept requests.
2. **Choose an asset and price:** Setup a trustline for USDC receipt. (See our demo-merchant example).
3. **Declare discovery metadata:** Provide metadata on your endpoints.
4. **Verify listing:** Check the Bazaar endpoint to ensure you are listed.
5. **Troubleshooting:**
   - *Error: Trustline missing.* Ensure you have an active trustline for the asset.
   - *Error: Invalid signature.* Ensure the agent signs with the correct private key.
