/**
 * Redaction for anything the transport logs.
 *
 * Nothing here logs a full request body today, and it should stay that way —
 * paymentPayload can carry transaction XDR and paymentRequirements can carry
 * a payer's own metadata. But request *headers* are exactly the kind of
 * thing an incident-response "log everything at the edge" instinct reaches
 * for, and Authorization is exactly the header that would leak an API key if
 * it ever gets there unredacted. This module is the single choke point for
 * that: redact() before you log, not per call site.
 *
 * Hand-written rather than pulling in pino: the repo is deliberate about its
 * dependency surface (see #68's reasoning and the licence-check job in CI),
 * and a redaction rulebook of a handful of key names doesn't need a logging
 * framework — swap console.* for pino later if structured/leveled logging
 * becomes a real need, and reuse REDACTED_KEY_NAMES / redact() as its
 * `redact` option.
 */

const REDACTED_KEY_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return REDACTED_KEY_NAMES.has(lower) || lower.endsWith('_secret') || lower.endsWith('-secret');
}

/**
 * Deep-clones a plain object, masking sensitive keys as '***' and leaving
 * everything else untouched. Safe to call on headers, query params, or any
 * plain object before it reaches console.*.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '***' : redact(val);
    }
    return out;
  }
  return value;
}

/**
 * Request logging middleware: logs one line per request with redacted headers,
 * after the response finishes. Never touches req.body — see the module comment.
 *
 * Speaks the Node http.IncomingMessage/ServerResponse pair rather than any
 * framework's decorated request, so the same function serves whatever transport
 * wraps it (Express called it directly; the Fastify transport passes
 * request.raw / reply.raw).
 */
function pathOf(req) {
  // Node's raw request carries the URL with querystring; Express decorates
  // `path`. Prefer stripping the query off the raw URL, fall back to `path`.
  if (typeof req.url === 'string') {
    return req.url.split('?')[0];
  }
  return typeof req.path === 'string' ? req.path : '';
}

export function requestLogger(log = msg => console.log(msg)) {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      log(
        JSON.stringify({
          method: req.method,
          path: pathOf(req),
          status: res.statusCode,
          durationMs,
          headers: redact(req.headers),
        }),
      );
    });
    next?.();
  };
}
