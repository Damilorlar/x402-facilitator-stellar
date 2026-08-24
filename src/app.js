/**
 * The HTTP surface: /verify, /settle, /supported, /usage, /discovery/resources.
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
import { validatePaymentBody } from './request-validation.js';
import { requestLogger } from './logger.js';

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
 * @param {{keyFor: Function, begin: Function, complete: Function}} [idempotency]
 *   optional idempotency store for /settle; absent means in-memory only
 * @returns {import('express').Express}
 */
export function createApp(config, facilitator, rateLimiter, catalog, idempotency) {
  const app = express();
  // Client IP resolution. Unset leaves Express's default (off), correct where
  // the port is published directly — local development and docker-compose.
  // Never "true": that trusts the leftmost X-Forwarded-For entry the client
  // wrote itself. See docs/DEPLOYMENT.md for the topology per environment.
  if (config.trustProxy !== undefined) {
    app.set('trust proxy', config.trustProxy);
  }
  app.use(express.json({ limit: '256kb' }));
  // Redacts Authorization/cookie/*_secret before anything hits the log — see
  // src/logger.js. Never logs the body: paymentPayload/paymentRequirements
  // are validated, not logged, transport-wide.
  app.use(requestLogger());

  /**
   * Security headers (#86), hand-set rather than via helmet.
   *
   * helmet's value is its defaults for a document-serving app; this service
   * returns JSON to programmatic clients and serves no HTML, no cookies and no
   * user-supplied markup, so only three headers do real work here:
   *
   *   - X-Content-Type-Options: nosniff — stops a JSON response being
   *     reinterpreted as something else by a browser.
   *   - Strict-Transport-Security — meaningful for a hosted mainnet deployment
   *     handling payment authorizations; conditional on NODE_ENV=production so
   *     a local HTTP dev server cannot poison a browser's view of localhost.
   *   - X-Powered-By — suppressed below; Express advertising itself is free
   *     reconnaissance.
   *
   * Deliberately NOT set:
   *   - Content-Security-Policy — defends against content injection into
   *     documents; no documents are served. If the OpenAPI work adds a Swagger
   *     UI page, that changes the calculus and CSP (plus helmet wholesale)
   *     should be revisited then.
   *   - X-Frame-Options / frame-ancestors — nothing here is framable; there is
   *     no HTML to clickjack.
   */
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (config.nodeEnv === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Headers a browser client must be able to read but which are not
  // CORS-safelisted response headers: without naming them in
  // Access-Control-Expose-Headers they are invisible to browser JavaScript,
  // which would leave the Bazaar cataloguing outcome unreadable from a browser.
  const EXPOSED_HEADERS = [
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'Retry-After',
    'EXTENSION-RESPONSES',
  ].join(', ');

  /**
   * CORS (#76), decided per route class rather than globally, because the two
   * classes have opposite risk profiles:
   *
   *   - Public reads (/supported, GET /discovery/resources,
   *     /discovery/search) are unauthenticated and carry no credential worth
   *     protecting, so they default to `*`: a browser-based agent, catalog
   *     explorer or seller checking their own listing needs these.
   *   - Authenticated routes (/verify, /settle, /usage, POST
   *     /discovery/resources) carry an API key. A permissive policy there
   *     invites any web page to send a caller's key somewhere it should not
   *     go, so the default is no grant at all: origins must be explicitly
   *     allowlisted via CORS_ALLOWED_ORIGINS.
   *
   * Authorization is not a safelisted request header, so every browser call to
   * the payment routes triggers a preflight that must be answered with the
   * right Allow-Headers or the request silently fails — hence OPTIONS handling
   * on both classes, mounted before the auth middleware.
   *
   * Hand-set rather than the cors package: the per-class split means the
   * package's single global config would be fought, and three headers add no
   * dependency surface worth paying for.
   */
  function cors(policy) {
    return (req, res, next) => {
      res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);

      const origin = req.get('origin');
      const allowlisted = origin && config.cors.allowedOrigins.includes(origin);
      let granted;
      if (policy === 'public') {
        granted = allowlisted ? origin : config.cors.allowedOrigins.length === 0 ? '*' : false;
      } else {
        // Never default-open anything authenticated.
        granted = allowlisted ? origin : false;
      }

      res.setHeader('Vary', 'Origin');

      if (granted) {
        res.setHeader('Access-Control-Allow-Origin', granted);
      }

      if (req.method === 'OPTIONS') {
        // Answer the preflight even when the origin is not granted: the 204
        // carries no ACAO, so the browser still blocks the actual request —
        // which is the enforcement point, not the preflight status.
        res.setHeader(
          'Access-Control-Allow-Methods',
          policy === 'public' ? 'GET, OPTIONS' : 'POST, OPTIONS',
        );
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
      }

      return next();
    };
  }

  /**
   * Catalogs a resource declared in a payment, off the hot path.
   *
   * Cataloging must never delay or fail a payment: the work is enqueued and the
   * payment response returns immediately. A cataloging failure is logged, never
   * surfaced as a payment failure.
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
            await catalog.upsertResource(validation.resource, source);
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
      if (
        presentedHash.length === apiKey.hash.length &&
        crypto.timingSafeEqual(presentedHash, apiKey.hash)
      ) {
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
   *
   * Validation itself lives in request-validation.js: this only shapes the
   * rejection into the response the calling route would otherwise have sent,
   * since /verify and /settle disagree on what a failure body looks like
   * (isValid/invalidReason vs. success/errorReason/transaction/network).
   */
  function readPaymentBody(req, res, route = 'verify') {
    const result = validatePaymentBody(req.body, config);
    if (!result.valid) {
      if (route === 'settle') {
        res.status(400).json({
          success: false,
          errorReason: result.reason,
          errorMessage: result.message,
          transaction: '',
          network: req.body?.paymentRequirements?.network,
        });
      } else {
        res.status(400).json({
          isValid: false,
          invalidReason: result.reason,
          invalidMessage: result.message,
        });
      }
      return null;
    }
    return {
      paymentPayload: result.paymentPayload,
      paymentRequirements: result.paymentRequirements,
    };
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  /**
   * GET /supported
   *
   * Must emit the Stellar `extra` block including areFeesSponsored — an explicit
   * acceptance item. getSupported() assembles it from the registered schemes, so
   * it is passed through rather than hand-built.
   */
  app.get('/supported', cors('public'), (_req, res) => {
    res.json(facilitator.getSupported());
  });

  app.get('/usage', requireApiKeyStrict, async (req, res) => {
    res.json(await rateLimiter.getUsage(req.keyId));
  });

  app.post('/verify', cors('authenticated'), requireApiKey, async (req, res) => {
    const check = await rateLimiter.checkVerify(req);
    if (!check.allowed) return handleRateLimit(res, check);

    const body = readPaymentBody(req, res);
    if (!body) return;
    try {
      await rateLimiter.recordVerify(req);
      handleRateLimit(res, check);
      const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
      if (result.isValid) {
        await processCataloging(req, body, res, 'payment');
      }
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

  app.post('/settle', cors('authenticated'), requireApiKey, async (req, res) => {
    const check = await rateLimiter.checkSettle(req);
    if (!check.allowed) return handleRateLimit(res, check);

    const body = readPaymentBody(req, res, 'settle');
    if (!body) return;

    // Exact-once settlement: a repeated idempotency key replays the recorded
    // response instead of touching the chain again. The key is client-supplied
    // when present and derived from the request body otherwise.
    const replay = idempotency ? await idempotency.begin(idempotency.keyFor(req)) : null;
    if (replay?.replayed) {
      handleRateLimit(res, check);
      return res.status(replay.statusCode).json(replay.response);
    }

    try {
      const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
      await rateLimiter.recordSettle(req, result.success ? result.transactionFeeStroops || 0 : 0);
      handleRateLimit(res, check);
      if (result.success) {
        await processCataloging(req, body, res, 'payment');
      }
      if (idempotency && replay) {
        await idempotency.complete(replay.key, 200, result);
      }
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

  /**
   * Manual registration, the secondary path.
   *
   * Automatic cataloging off the payment path is the primary one — anything
   * that requires a seller to act after being paid gets skipped.
   */
  app.post('/discovery/resources', cors('authenticated'), requireApiKey, async (req, res) => {
    const body = readPaymentBody(req, res);
    if (!body) return;

    const check = await rateLimiter.checkCatalog(req);
    if (!check.allowed) return handleRateLimit(res, check);

    const validation = validateForCatalog(body.paymentPayload, body.paymentRequirements);
    if (validation.hardDrop) {
      return res.status(400).json({ error: 'invalid_resource', reason: validation.reason });
    }

    await rateLimiter.recordCatalog(req);
    try {
      const entry = await catalog.upsertResource(validation.resource, 'manual');
      res.json({ ok: true, resource: entry, softDrops: validation.softDrops });
    } catch (err) {
      res.status(400).json({ error: 'catalog_error', reason: err.message });
    }
  });

  app.get('/discovery/resources', cors('public'), async (req, res) => {
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

  app.get('/discovery/search', cors('public'), async (req, res) => {
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

  /**
   * Preflight routes (#76).
   *
   * Express 5 does not answer OPTIONS itself, so each CORS-enabled path gets
   * one explicitly. The cors() middleware sees the OPTIONS method and replies
   * 204 — carrying ACAO only when the origin is granted — before auth
   * middleware ever runs, which matters because a preflight cannot carry the
   * API key.
   */
  app.options('/supported', cors('public'));
  app.options('/discovery/search', cors('public'));
  app.options('/discovery/resources', cors('authenticated'));
  app.options('/verify', cors('authenticated'));
  app.options('/settle', cors('authenticated'));

  /**
   * 404 (#78). Every rejection carries a non-null reason code, transport-level
   * ones included — an unknown route is no exception.
   */
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', reason: 'route_not_found' });
  });

  /**
   * The one error boundary (#78), registered last so Express 5 forwards both
   * thrown errors and rejected promises from async handlers to it. The
   * route-level catch blocks above are left alone: they encode deliberate
   * decisions (/verify answers 200 with isValid: false rather than a 500,
   * because to a client a 500 is indistinguishable from the service being
   * down); this boundary only catches what escapes them.
   *
   * The response shape is matched to the route, not flattened into a generic
   * {error} — /verify failures look like verification failures, /settle
   * failures carry transaction and network so a client can attribute the
   * failure without correlating out of band.
   *
   * Stack traces go to the server log only, never the wire, and that is not
   * gated on NODE_ENV — which is unset in the Docker image.
   */
  app.use((err, req, res, _next) => {
    console.error(`[Error] ${err?.type ?? err?.name ?? 'Error'}: ${err?.message}`);

    let status = 500;
    let code = 'internal_error';
    if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'malformed_json';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'payload_too_large';
    }
    const message = err instanceof Error ? err.message : String(err);

    if (req.path === '/verify') {
      return res.status(status).json({
        isValid: false,
        invalidReason: code,
        invalidMessage: message,
      });
    }
    if (req.path === '/settle') {
      return res.status(status).json({
        success: false,
        errorReason: code,
        errorMessage: message,
        transaction: '',
        network: req.body?.paymentRequirements?.network,
      });
    }
    return res.status(status).json({ error: code, reason: code });
  });

  return app;
}
