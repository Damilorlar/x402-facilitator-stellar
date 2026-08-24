/**
 * Security headers (#86).
 *
 * Only the headers that do something for a JSON API are asserted: nosniff,
 * HSTS (production only) and the absence of X-Powered-By. CSP is deliberately
 * absent — no documents are served — see app.js.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from './helpers/app.js';

describe('security headers', () => {
  let app;
  before(async () => {
    app = await serve();
  });
  after(() => app.close());

  test('nosniff is set on responses', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('X-Powered-By is not sent', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('HSTS is not sent outside production', async () => {
    const res = await app.get('/healthz');
    assert.equal(res.headers.get('strict-transport-security'), null);
  });
});

describe('security headers: production', () => {
  test('HSTS is sent in production', async () => {
    const app = await serve({ nodeEnv: 'production' });
    try {
      const res = await app.get('/healthz');
      assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
    } finally {
      await app.close();
    }
  });
});
