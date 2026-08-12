/**
 * The HTTP surface: /verify, /settle, /supported.
 *
 * @x402/core ships no facilitator router — it gives you x402Facilitator with
 * verify(), settle() and getSupported(), and the transport is yours. This file
 * is that transport and nothing else.
 *
 * Conformance is judged at the wire level (RFP §3.6): reviewers point stock SDK
 * code at the deliverable rather than read a conformance claim. So the rules
 * here are narrow and deliberate:
 *
 *   - the spec's `payload: {transaction}` shape is accepted verbatim, unwrapped
 *     and un-renamed;
 *   - every rejection carries a non-null `reason`, including transport-level
 *     ones, so an agent can branch on a code instead of parsing prose;
 *   - responses are passed through from the scheme untouched.
 */
import crypto from 'node:crypto';
import express from 'express';
import { resolveConfig } from './config.js';
import { buildFacilitator } from './facilitator.js';
import { installRpcRetry } from './rpc-retry.js';
import { RateLimiter } from './rate-limit.js';

// Must run before the scheme makes any RPC call. Retries connection-level
// failures only; see rpc-retry.js for what that deliberately excludes.
installRpcRetry({ log: msg => console.warn(`  ${msg}`) });

const config = resolveConfig();
const { facilitator, signers } = buildFacilitator(config);
const rateLimiter = new RateLimiter(config.rateLimits);

const app = express();
app.use(express.json({ limit: '256kb' }));

/**
 * Caller authentication.
 *
 * Unset means open. That is the correct default for a free testnet instance —
 * the RFP requires testnet be usable without friction — and it is documented
 * rather than silent: the server logs at boot when it is running open.
 */
function requireApiKey(req, res, next) {
  if (config.apiKeys.length === 0) return next();
  
  const authHeader = req.get('authorization');
  if (!authHeader) {
    return res.status(401).json({ error: 'unauthorized', reason: 'missing_auth_header' });
  }

  let presentedKey = '';
  if (authHeader.startsWith('Bearer ')) {
    presentedKey = authHeader.substring(7);
  } else if (!authHeader.includes(' ')) {
    presentedKey = authHeader;
  } else {
    return res.status(401).json({ error: 'unauthorized', reason: 'malformed_auth_header' });
  }

  if (!presentedKey || presentedKey.includes(' ')) {
    return res.status(401).json({ error: 'unauthorized', reason: 'malformed_auth_header' });
  }

  const presentedHash = crypto.createHash('sha256').update(presentedKey).digest();

  for (const apiKey of config.apiKeys) {
    if (presentedHash.length === apiKey.hash.length && crypto.timingSafeEqual(presentedHash, apiKey.hash)) {
      req.keyId = apiKey.id;
      return next();
    }
  }

  return res.status(401).json({ error: 'unauthorized', reason: 'invalid_api_key' });
}

/**
 * Require API key for usage (no open mode allowed for this).
 */
function requireApiKeyStrict(req, res, next) {
  if (config.apiKeys.length === 0) {
    return res.status(401).json({ error: 'unauthorized', reason: 'open_mode_usage_forbidden' });
  }
  requireApiKey(req, res, next);
}

function handleRateLimit(res, checkResult) {
  if (checkResult) {
    res.set('RateLimit-Limit', checkResult.limit);
    res.set('RateLimit-Remaining', checkResult.remaining);
    res.set('RateLimit-Reset', checkResult.resetAt);
    if (!checkResult.allowed) {
      res.set('Retry-After', Math.max(1, checkResult.resetAt - Math.floor(Date.now() / 1000)));
      return res.status(429).json({ error: 'rate_limited', reason: checkResult.reason });
    }
  }
}

/**
 * Both /verify and /settle take {paymentPayload, paymentRequirements}.
 * Returning a non-null reason on a malformed body matters as much as on a
 * failed verification — a null reason anywhere is an acceptance failure.
 */
function readPaymentBody(req, res) {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  if (!paymentPayload || !paymentRequirements) {
    res.status(400).json({
      isValid: false,
      invalidReason: 'invalid_request',
      invalidMessage: 'body must contain paymentPayload and paymentRequirements',
    });
    return null;
  }
  return { paymentPayload, paymentRequirements };
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/**
 * GET /supported
 *
 * Must emit the Stellar `extra` block including areFeesSponsored — an explicit
 * acceptance item. getSupported() assembles it from the registered schemes, so
 * it is passed through rather than hand-built.
 */
app.get('/supported', (_req, res) => {
  res.json(facilitator.getSupported());
});

app.get('/usage', requireApiKeyStrict, (req, res) => {
  res.json(rateLimiter.getUsage(req.keyId));
});

app.post('/verify', requireApiKey, async (req, res) => {
  const check = rateLimiter.checkVerify(req);
  if (!check.allowed) return handleRateLimit(res, check);

  const body = readPaymentBody(req, res);
  if (!body) return;
  try {
    rateLimiter.recordVerify(req);
    handleRateLimit(res, check);
    const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
    res.json(result);
  } catch (err) {
    // An exception must not become a 500 with an empty body: to a client that
    // is indistinguishable from the service being down, and it carries no
    // reason code. Shape it like a verification failure instead.
    //
    // Note ExactStellarScheme already absorbs its own internal exceptions and
    // returns invalidReason "unexpected_verify_error" rather than throwing, so
    // this path only catches failures above the scheme — an unregistered
    // scheme/network pair, for instance. A distinct code keeps the two
    // distinguishable to a client.
    res.status(200).json({
      isValid: false,
      invalidReason: 'facilitator_error',
      invalidMessage: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/settle', requireApiKey, async (req, res) => {
  const check = rateLimiter.checkSettle(req);
  if (!check.allowed) return handleRateLimit(res, check);

  const body = readPaymentBody(req, res);
  if (!body) return;
  try {
    const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
    rateLimiter.recordSettle(req, result.success ? result.transactionFeeStroops || 0 : 0);
    handleRateLimit(res, check);
    res.json(result);
  } catch (err) {
    // SettleResponse requires `transaction` and `network` even on failure, so
    // a client can attribute the failure without correlating out of band.
    res.status(200).json({
      success: false,
      errorReason: 'facilitator_error',
      errorMessage: err instanceof Error ? err.message : String(err),
      transaction: '',
      network: req.body?.paymentRequirements?.network,
    });
  }
});

app.listen(config.port, () => {
  console.log(`x402 Stellar facilitator listening on :${config.port}`);
  console.log(`  networks : ${config.networks.join(', ')}`);
  for (const [network, address] of Object.entries(signers)) {
    console.log(`  signer   : ${network} -> ${address}`);
  }
  console.log(`  rpc      : ${config.rpcUrl ?? '(package default)'}`);
  console.log(`  max fee  : ${config.maxTransactionFeeStroops} stroops`);
  if (config.apiKeys.length === 0) {
    console.log('  auth     : OPEN — no API keys configured (fine for free testnet)');
  } else {
    console.log(`  auth     : ${config.apiKeys.length} API key(s) configured`);
  }
});
