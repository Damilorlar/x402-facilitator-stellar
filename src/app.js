/**
 * The HTTP surface: /verify, /settle, /supported, /usage, /discovery/resources,
 * /healthz, /health/ready.
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
 *   - every rejection carries a non-null reason code, including transport-level
 *     ones, so an agent can branch on a code instead of parsing prose;
 *   - responses are passed through from the scheme untouched.
 *
 * Separated from server.js so the surface can be built and exercised without
 * binding a port, holding a real signer, or spawning a subprocess. server.js is
 * the process entrypoint and does nothing this file does.
 */
import crypto from 'node:crypto';
import express from 'express';
import { validateForCatalog } from './catalog/validation.js';
import { createAuditLogger } from './audit.js';
import { createReadinessChecker } from './readiness.js';

/**
 * Builds the Express app.
 *
 * Takes its collaborators rather than reaching for module state, which is what
 * makes the surface testable: a test can supply a facilitator that throws, a
 * rate limiter already at its ceiling, or a catalog that rejects a write,
 * without a network, a keypair or a subprocess.
 *
 * `signers` is deliberately not a parameter — no route reads it. The addresses
 * reach the wire through facilitator.getSupported(); server.js keeps them only
 * to print the boot banner.
 *
 * @param {object} config - resolved config from resolveConfig()
 * @param {{verify: Function, settle: Function, getSupported: Function}} facilitator
 * @param {object} rateLimiter - RateLimiter, or a stub with the same surface
 * @param {{upsertResource: Function, listResources: Function}} catalog
 * @param {object} [extras] - optional collaborators: a readiness checker, an
 *   audit writer override, a breaker-state reader
 * @returns {import('express').Express}
 */
export function createApp(config, facilitator, rateLimiter, catalog, extras = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const audit = extras.audit ?? createAuditLogger();

  // Readiness defaults to a real checker over the resolved config. A bare test
  // config carries no networks, in which case the probe reports honestly that
  // it has nothing to check rather than pretending to be ready.
  const readiness =
    extras.readiness ??
    (Array.isArray(config.networks)
      ? createReadinessChecker(config, {
          breakerStates: extras.breakerStates ?? (() => null),
          catalog,
        })
      : null);

  /**
   * Catalogs a resource declared in a payment, off the hot path.
   *
   * Cataloging must never delay or fail a payment: the expensive work is
   * enqueued and the payment response returns immediately. A cataloging failure
   * is logged, never surfaced as a payment failure.
   */
  async function processCataloging(req, body, res, source = 'payment') {
    const validation = validateForCatalog(body.paymentPayload, body.paymentRequirements);
    const outcome = {};

    if (validation.hardDrop) {
      if (validation.reason === 'missing_or_invalid_discovery_extension') {
        outcome.status = 'not attempted';
      } else {
        outcome.status = 'rejected';
        outcome.code = validation.reason;
        console.warn(`[Catalog] Hard drop: ${validation.reason}`);
      }
    } else {
      const checkResult = await rateLimiter.checkCatalog(req);
      if (!checkResult.allowed) {
        outcome.status = 'rejected';
        outcome.code = 'catalog_rate_limited';
        outcome.reason = checkResult.reason;
        console.warn(`[Catalog] Rate limit exceeded for IP ${req.ip}`);
        // Audited as a rejection but never allowed to shape the payment
        // response: the 429/headers belong to the payment limiter, not here.
        audit('rate_limit_rejected', {
          actor: req.keyId ?? `ip:${req.ip}`,
          route: 'catalog',
          reason: checkResult.reason,
          outcome_override: outcome.code,
        });
      } else {
        if (validation.softDrops.length > 0) {
          outcome.status = 'partially landed';
          outcome.code = 'catalog_partial';
          outcome.reason = `Dropped fields: ${validation.softDrops.join(', ')}`;
          console.warn(
            `[Catalog] Soft drops for ${validation.resource.url}: ${validation.softDrops.join(', ')}`,
          );
        } else {
          outcome.status = 'landed';
          outcome.code = 'catalog_success';
        }

        await rateLimiter.recordCatalog(req);

        // Off the hot path. Cataloging must never delay or fail a payment.
        Promise.resolve().then(async () => {
          try {
            const existing = await catalog.getResource?.(
              validation.resource.url,
              validation.resource.toolName ?? null,
            );
            await catalog.upsertResource(validation.resource, source);
            // A public listing being created or overwritten is public state
            // changing — recorded so a spoofed listing can be investigated
            // after the fact.
            audit('catalog_write', {
              actor: req.keyId ?? `ip:${req.ip}`,
              source,
              url: validation.resource.url,
              tool_name: validation.resource.toolName ?? null,
              overwritten: Boolean(existing),
            });
          } catch (err) {
            console.warn(`[Catalog] Async cataloging failed: ${err.message}`);
          }
        });
      }
    }

    res.setHeader(
      'EXTENSION-RESPONSES',
      Buffer.from(JSON.stringify({ bazaar: outcome })).toString('base64'),
    );
  }

  /**
   * Caller authentication.
   *
   * Unset means open. That is the correct default for a free testnet instance —
   * the RFP requires testnet be usable without friction — and it is documented
   * rather than silent: the server logs at boot when it is running open.
   */
  function requireApiKey(req, res, next) {
    if (config.apiKeys.length === 0) return next();

    const reject = reason => {
      // The presented key material itself is deliberately never recorded.
      audit('auth_failure', { actor: `ip:${req.ip}`, reason });
      return res.status(401).json({ error: 'unauthorized', reason });
    };

    const authHeader = req.get('authorization');
    if (!authHeader) return reject('missing_auth_header');

    let presentedKey = '';
    if (authHeader.startsWith('Bearer ')) {
      presentedKey = authHeader.substring(7);
    } else if (!authHeader.includes(' ')) {
      presentedKey = authHeader;
    } else {
      return reject('malformed_auth_header');
    }

    if (!presentedKey || presentedKey.includes(' ')) {
      return reject('malformed_auth_header');
    }

    const presentedHash = crypto.createHash('sha256').update(presentedKey).digest();

    for (const apiKey of config.apiKeys) {
      if (
        presentedHash.length === apiKey.hash.length &&
        crypto.timingSafeEqual(presentedHash, apiKey.hash)
      ) {
        req.keyId = apiKey.id;
        return next();
      }
    }

    return reject('invalid_api_key');
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

  /** Rate-limit rejections are auditable: they are abuse signals, not noise. */
  function rejectRateLimited(req, res, route, checkResult, extra = {}) {
    audit('rate_limit_rejected', {
      actor: req.keyId ?? `ip:${req.ip}`,
      route,
      reason: checkResult.reason,
      ...extra,
    });
    return handleRateLimit(res, checkResult);
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
   * GET /health/ready — the readiness probe (#100).
   *
   * Unlike /healthz this CAN fail: 503 names which check failed for which
   * network. Result is cached and bounded by its own timeout — see
   * src/readiness.js. Catalogue trouble is reported but never fails readiness:
   * a cataloguing failure must never fail a payment.
   */
  app.get('/health/ready', async (_req, res) => {
    if (!readiness) {
      return res.status(503).json({
        ok: false,
        status: 'not_ready',
        reason: 'readiness_not_configured',
      });
    }
    try {
      const report = await readiness.check();
      res.status(report.ok ? 200 : 503).json(report);
    } catch (err) {
      res.status(503).json({ ok: false, status: 'not_ready', error: err.message });
    }
  });

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

  app.get('/usage', requireApiKeyStrict, async (req, res) => {
    res.json(await rateLimiter.getUsage(req.keyId));
  });

  app.post('/verify', requireApiKey, async (req, res) => {
    const check = await rateLimiter.checkVerify(req);
    if (!check.allowed) return rejectRateLimited(req, res, '/verify', check);

    const body = readPaymentBody(req, res);
    if (!body) return;
    try {
      await rateLimiter.recordVerify(req);
      handleRateLimit(res, check);
      const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
      audit('verification', {
        actor: req.keyId ?? `ip:${req.ip}`,
        outcome: result.isValid ? 'valid' : 'invalid',
        invalid_reason: result.invalidReason ?? null,
        network: body.paymentRequirements.network,
      });
      if (result.isValid) {
        await processCataloging(req, body, res, 'payment');
      }
      res.json(result);
    } catch (err) {
      // An exception must not become a 500 with an empty body: to a client that
      // is indistinguishable from the service being down, and it carries no
      // reason code. Shape it like a verification failure instead.
      //
      // An open RPC breaker gets its own code so a caller can tell "the chain
      // is unreachable" from "your payment was rejected" (#105, #6).
      const invalidReason =
        err?.code === 'RPC_BREAKER_OPEN' ? 'soroban_rpc_unreachable' : 'facilitator_error';
      if (invalidReason !== 'facilitator_error') {
        audit('rpc_unreachable', { actor: req.keyId ?? `ip:${req.ip}`, op: 'verify' });
      }
      res.status(200).json({
        isValid: false,
        invalidReason,
        invalidMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post('/settle', requireApiKey, async (req, res) => {
    const check = await rateLimiter.checkSettle(req);
    if (!check.allowed) return rejectRateLimited(req, res, '/settle', check);

    const body = readPaymentBody(req, res);
    if (!body) return;
    try {
      const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
      await rateLimiter.recordSettle(req, result.success ? result.transactionFeeStroops || 0 : 0);
      handleRateLimit(res, check);
      if (result.success) {
        await processCataloging(req, body, res, 'payment');
      }
      // Settlements are THE auditable record: which authenticated caller moved
      // money, and the transaction hash to reconstruct it by.
      audit('settlement', {
        actor: req.keyId ?? `ip:${req.ip}`,
        outcome: result.success ? 'settled' : 'failed',
        transaction: result.transaction || null,
        network: result.network ?? body.paymentRequirements.network,
        fee_stroops: result.success ? result.transactionFeeStroops || 0 : 0,
        error_reason: result.errorReason ?? null,
      });
      res.json(result);
    } catch (err) {
      // SettleResponse requires `transaction` and `network` even on failure, so
      // a client can attribute the failure without correlating out of band.
      const errorReason =
        err?.code === 'RPC_BREAKER_OPEN' ? 'soroban_rpc_unreachable' : 'facilitator_error';
      if (errorReason === 'soroban_rpc_unreachable') {
        audit('rpc_unreachable', { actor: req.keyId ?? `ip:${req.ip}`, op: 'settle' });
      }
      res.status(200).json({
        success: false,
        errorReason,
        errorMessage: err instanceof Error ? err.message : String(err),
        transaction: '',
        network: req.body?.paymentRequirements?.network,
      });
    }
  });

  /**
   * Manual registration, the secondary path.
   *
   * Automatic cataloging off the payment path is the primary one — anything
   * that requires a seller to act after being paid gets skipped.
   */
  app.post('/discovery/resources', requireApiKey, async (req, res) => {
    const body = readPaymentBody(req, res);
    if (!body) return;

    const check = await rateLimiter.checkCatalog(req);
    if (!check.allowed) return rejectRateLimited(req, res, '/discovery/resources', check);

    const validation = validateForCatalog(body.paymentPayload, body.paymentRequirements);
    if (validation.hardDrop) {
      return res.status(400).json({ error: 'invalid_resource', reason: validation.reason });
    }

    await rateLimiter.recordCatalog(req);
    try {
      const existing = await catalog.getResource?.(
        validation.resource.url,
        validation.resource.toolName ?? null,
      );
      const entry = await catalog.upsertResource(validation.resource, 'manual');
      audit('catalog_write', {
        actor: req.keyId ?? `ip:${req.ip}`,
        source: 'manual',
        url: validation.resource.url,
        tool_name: validation.resource.toolName ?? null,
        overwritten: Boolean(existing),
      });
      res.json({ ok: true, resource: entry, softDrops: validation.softDrops });
    } catch (err) {
      res.status(400).json({ error: 'catalog_error', reason: err.message });
    }
  });

  app.get('/discovery/resources', async (req, res) => {
    let extensions;
    if (req.query.extensions) {
      extensions = Array.isArray(req.query.extensions)
        ? req.query.extensions
        : req.query.extensions.split(',');
    }

    const params = {
      type: req.query.type,
      payTo: req.query.payTo,
      scheme: req.query.scheme,
      network: req.query.network,
      extensions,
      limit: req.query.limit,
      offset: req.query.offset,
    };

    try {
      const result = await catalog.listResources(params);
      let parsedLimit = parseInt(params.limit, 10);
      if (isNaN(parsedLimit)) parsedLimit = 20;

      let parsedOffset = parseInt(params.offset, 10);
      if (isNaN(parsedOffset)) parsedOffset = 0;

      res.json({
        x402Version: 2,
        items: result.items,
        pagination: {
          limit: Math.min(Math.max(1, parsedLimit), 100),
          offset: Math.max(0, parsedOffset),
          total: result.total,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  app.get('/discovery/search', async (req, res) => {
    if (!req.query.query) {
      return res.status(400).json({ error: 'invalid_request', reason: 'query is required' });
    }

    let extensions;
    if (req.query.extensions) {
      extensions = Array.isArray(req.query.extensions)
        ? req.query.extensions
        : req.query.extensions.split(',');
    }

    const params = {
      query: req.query.query,
      type: req.query.type,
      payTo: req.query.payTo,
      scheme: req.query.scheme,
      network: req.query.network,
      extensions,
      limit: req.query.limit,
      cursor: req.query.cursor,
    };

    try {
      const result = await catalog.search(params);
      res.json({
        x402Version: 2,
        resources: result.resources,
        partialResults: result.partialResults,
        pagination: result.pagination,
      });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  return app;
}
