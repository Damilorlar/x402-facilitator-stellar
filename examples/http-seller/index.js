import express from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme as ExactStellarServer } from '@x402/stellar/exact/server';
import fs from 'node:fs';

const NETWORK = 'stellar:testnet';
// Default testnet XLM SAC
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PRICE_STROOPS = '2500'; // 0.00025 XLM

// Determine facilitator URL
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'http://localhost:3402';
const PORT = Number(process.env.PORT || 3401);

/**
 * 1. Helper to setup and fund a testnet keypair if one is not provided
 */
async function setupMerchantAccount() {
  const envSecret = process.env.MERCHANT_SECRET;
  if (envSecret) {
    const kp = Keypair.fromSecret(envSecret);
    console.log(`Using configured MERCHANT_SECRET. Address: ${kp.publicKey()}`);
    return kp.publicKey();
  }

  const keyPath = '.merchant-secret';
  let secret;
  if (fs.existsSync(keyPath)) {
    secret = fs.readFileSync(keyPath, 'utf8').trim();
    const kp = Keypair.fromSecret(secret);
    console.log(`Using existing merchant account from ${keyPath}. Address: ${kp.publicKey()}`);
    return kp.publicKey();
  }

  console.log('No merchant account configured. Generating a new one and funding via friendbot...');
  const kp = Keypair.random();
  secret = kp.secret();

  try {
    const res = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(kp.publicKey())}`,
    );
    if (!res.ok) {
      throw new Error(`Friendbot failed with status ${res.status}`);
    }
    await res.json();
    console.log(`Successfully funded ${kp.publicKey()} via Friendbot.`);
    fs.writeFileSync(keyPath, secret);
    console.log(`Saved secret to ${keyPath} for future runs.`);
    return kp.publicKey();
  } catch (err) {
    console.error(`Failed to fund testnet account: ${err.message}`);
    process.exit(1);
  }
}

/**
 * 2. Main server setup
 */
async function main() {
  const merchantAddress = await setupMerchantAccount();

  // Create x402 resource server
  const resourceServer = new x402ResourceServer([
    new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
  ]);

  // Register the stellar scheme
  resourceServer.register(NETWORK, new ExactStellarServer());

  // Log successful settlements
  resourceServer.onAfterSettle(async ctx => {
    if (ctx.result.success) {
      console.log(`[x402] Payment successful: ${ctx.result.transaction} from ${ctx.result.payer}`);
    }
  });

  // Setup the HTTP bindings and discovery metadata
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    '/api/joke': {
      // Discovery metadata required by Bazaar (#29)
      title: 'Dad Joke Generator',
      description: 'Generates a random, completely unpredictable dad joke.',
      extensions: ['bazaar'],
      iconUrl: 'https://cdn-icons-png.flaticon.com/512/3260/3260838.png',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              'Optional category (e.g. "programming", "animals"). Ignored in this example.',
          },
        },
      },
      // Pricing rules
      accepts: {
        scheme: 'exact',
        price: { asset: XLM_SAC, amount: PRICE_STROOPS },
        network: NETWORK,
        payTo: merchantAddress,
      },
    },
  });

  const app = express();

  // Apply x402 middleware
  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  // The actual endpoint implementation
  const jokes = [
    'Why do programmers prefer dark mode? Because light attracts bugs.',
    'I told my doctor that I broke my arm in two places. He told me to stop going to those places.',
    "Why don't skeletons fight each other? They don't have the guts.",
    'What do you call fake spaghetti? An impasta.',
    'Why did the scarecrow win an award? Because he was outstanding in his field!',
  ];

  app.get('/api/joke', (req, res) => {
    const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
    res.json({
      joke: randomJoke,
      timestamp: new Date().toISOString(),
    });
  });

  // Start listening
  app.listen(PORT, () => {
    console.log(`\n🚀 Paid API running at http://localhost:${PORT}/api/joke`);
    console.log(
      `Try a free preview by opening it in your browser (you'll see a 402 Payment Required response).`,
    );
  });
}

main().catch(console.error);
