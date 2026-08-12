#!/usr/bin/env node
/**
 * Generates and friendbot-funds the three testnet accounts the upstream x402 e2e
 * suite needs for the Stellar family, and prints them as env assignments.
 *
 * WHY GENERATE RATHER THAN STORE. The suite needs a client key, a server payee
 * address and a facilitator key. Holding those as long-lived repository secrets
 * means three funded keys sitting in CI configuration forever, rotated by
 * nobody, for a job that does not need them to persist for even one minute
 * longer than the run. Friendbot makes fresh accounts free, so the run creates
 * its own and throws them away.
 *
 * Three distinct accounts is not a stylistic choice: ExactStellarScheme rejects
 * any payment where the facilitator is a party to the transfer, so payer,
 * recipient and facilitator must be three different keys or verification fails
 * on the first request.
 *
 * Testnet only, by construction — friendbot does not exist on pubnet, and this
 * script has no pubnet path on purpose. Pubnet conformance needs real funded
 * accounts and is a deliberate, separate operational step.
 *
 * Usage:
 *   node scripts/fund-testnet-accounts.mjs              # prints env assignments
 *   node scripts/fund-testnet-accounts.mjs --json       # prints JSON
 *   node scripts/fund-testnet-accounts.mjs --github-env # appends to $GITHUB_ENV
 */
import { appendFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { installRpcRetry } from '../src/rpc-retry.js';

// friendbot.stellar.org is behind Cloudflare and advertises AAAA records. On an
// IPv4-only host Node's built-in fetch times out against it while curl -4
// succeeds — the same dead-end src/rpc-retry.js exists to fix for Soroban RPC,
// and it bites here for exactly the same reason. Reuse it rather than writing a
// second IPv4 connector.
installRpcRetry({ log: msg => console.error(`  ${msg}`) });

const FRIENDBOT = process.env.FRIENDBOT_URL ?? 'https://friendbot.stellar.org';
const ATTEMPTS = Number(process.env.FRIENDBOT_ATTEMPTS ?? 5);

/**
 * Funds one account, retrying transport failures.
 *
 * Friendbot is a free public service and is periodically rate limited or
 * briefly unavailable. A conformance run that fails because friendbot hiccuped
 * reports a facilitator problem that does not exist, so this retries rather
 * than letting a funding blip masquerade as a conformance failure.
 */
async function fund(publicKey, label) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`);
      if (res.ok) {
        console.error(`  funded ${label.padEnd(11)} ${publicKey}`);
        return;
      }
      // 400 with op_already_exists means someone funded it first, which is fine.
      const body = await res.text();
      if (res.status === 400 && body.includes('op_already_exists')) {
        console.error(`  exists ${label.padEnd(11)} ${publicKey}`);
        return;
      }
      lastError = new Error(`friendbot ${res.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < ATTEMPTS) {
      const delay = 2000 * attempt;
      console.error(`  retry  ${label} in ${delay}ms — ${lastError.message.slice(0, 80)}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(
    `could not fund ${label} (${publicKey}) after ${ATTEMPTS} attempts: ${lastError?.message}`,
  );
}

const roles = ['client', 'server', 'facilitator'];
const keys = Object.fromEntries(roles.map(role => [role, Keypair.random()]));

console.error(`Funding three testnet accounts via ${FRIENDBOT}`);
// Sequential rather than parallel: friendbot rate limits, and three accounts is
// not worth the flakiness that concurrency buys here.
for (const role of roles) {
  await fund(keys[role].publicKey(), role);
}

const env = {
  // The suite's own names, from e2e/config/mechanisms_stellar.json.
  CLIENT_STELLAR_PRIVATE_KEY: keys.client.secret(),
  SERVER_STELLAR_ADDRESS: keys.server.publicKey(),
  FACILITATOR_STELLAR_PRIVATE_KEY: keys.facilitator.secret(),
  // What our own facilitator reads. Deliberately the same key as the one the
  // suite is told about, so the proxy and the service it fronts are one signer.
  FACILITATOR_SECRET: keys.facilitator.secret(),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(env, null, 2));
} else if (process.argv.includes('--github-env')) {
  const target = process.env.GITHUB_ENV;
  if (!target) {
    console.error('--github-env given but GITHUB_ENV is unset');
    process.exit(2);
  }
  appendFileSync(
    target,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
  console.error('Wrote 4 variables to $GITHUB_ENV');
} else {
  for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
}
