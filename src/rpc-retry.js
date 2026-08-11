/**
 * Makes Soroban RPC reachable from Node, and retries connection-level failures.
 *
 * `@stellar/stellar-sdk` reaches Soroban RPC through the global `fetch`, so
 * wrapping it here covers every RPC call the scheme makes — simulate, send and
 * poll — without reaching inside `ExactStellarScheme`.
 *
 * WHY THIS EXISTS — two distinct problems, one wrapper.
 *
 * 1. IPv6 dead-ends. `soroban-testnet.stellar.org` advertises AAAA records
 *    (Cloudflare). On an IPv4-only host those addresses fail with ENETUNREACH,
 *    and Node's built-in fetch does not reliably fall back to the A records —
 *    every request times out, while `curl` to the same host succeeds every
 *    time because it falls back immediately. Forcing `family: 4` on the
 *    connector removes the dead path. This is not exotic: any machine without
 *    working IPv6 hits it, which makes it a self-hosting footgun worth handling
 *    in the code rather than in a troubleshooting note.
 *
 * 2. Transient timeouts on top of that, retried below.
 *
 * WHAT IS AND IS NOT RETRIED. Only failures raised *before* a response is
 * received — connection timeouts and resets. Once the server has answered,
 * whatever it said stands: an RPC error, a rejected simulation or a failed
 * settlement is returned unchanged. Retrying those would convert a real failure
 * into a flaky success, which is precisely the class of bug this repo exists to
 * avoid.
 *
 * ON RESUBMISSION SAFETY. A retry can in principle resend `sendTransaction`.
 * That is safe here for two reasons: a connection-level failure means the
 * request most likely never arrived, and a Soroban transaction is identified by
 * its hash, so a genuine duplicate is rejected as such by the network rather
 * than settling twice. It is not a substitute for idempotency keys in a
 * production facilitator, and should be revisited alongside the durable
 * settlement-status store this spike does not have.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const RETRYABLE = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Installs the retrying wrapper over the global fetch.
 *
 * @param {object} [options]
 * @param {number} [options.attempts] - total attempts including the first
 * @param {number} [options.baseDelayMs] - linear backoff step
 * @param {(msg: string) => void} [options.log]
 */
export function installRpcRetry({
  attempts = 5,
  baseDelayMs = 800,
  log = () => {},
  forceIpv4 = process.env.RPC_FORCE_IPV4 !== 'false',
} = {}) {
  const builtinFetch = globalThis.fetch;

  // undici's fetch is used rather than the built-in one because only the former
  // accepts a dispatcher. Note the npm `undici` and Node's bundled copy are
  // separate module instances, so `setGlobalDispatcher` from the package does
  // NOT affect `globalThis.fetch` — the dispatcher has to travel with the call.
  let call = builtinFetch;
  if (forceIpv4) {
    const { Agent, fetch: undiciFetch } = require('undici');
    const agent = new Agent({ connect: { family: 4 } });
    call = (input, init) => undiciFetch(input, { ...init, dispatcher: agent });
  }

  globalThis.fetch = async function retryingFetch(input, init) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await call(input, init);
      } catch (err) {
        const code = err?.cause?.code ?? err?.code;
        if (!RETRYABLE.has(code) || attempt === attempts) {
          lastError = err;
          break;
        }
        lastError = err;
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        log(`rpc ${code} on ${url} — retry ${attempt}/${attempts - 1}`);
        await new Promise(r => setTimeout(r, baseDelayMs * attempt));
      }
    }
    throw lastError;
  };
}
