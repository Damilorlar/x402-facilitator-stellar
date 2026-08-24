/**
 * Client IP resolution tests (issue #111).
 *
 * These exercise the real app over a real socket, because req.ip is decided by
 * Express's trust proxy machinery at connection time — not reachable through a
 * stub. The rate limiter is the observer: buckets keyed on req.ip are what a
 * wrong identity breaks first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';
import { serve, testConfig, stubFacilitator, stubCatalog, VALID_BODY } from './helpers/app.js';

function oneVerifyLimit() {
  return new RateLimiter({
    global: { verifyRpm: 1, settleRpm: 10, settleRph: 100, settleRpd: 1000, feeSpd: 1e9 },
    keys: {},
  });
}

test('forged X-Forwarded-For does not change the resolved IP when no proxy is trusted', async () => {
  const instance = await serve({
    config: { ...testConfig(), trustProxy: undefined },
    facilitator: stubFacilitator(),
    rateLimiter: oneVerifyLimit(),
    catalog: stubCatalog(),
  });
  try {
    // Two requests claiming two different client IPs. With trust proxy off,
    // both resolve to the socket address and share one bucket.
    const first = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.ok(first.status !== 429, `first request should pass, got ${first.status}`);

    const second = await instance.post('/verify', VALID_BODY, {
      'x-forwarded-for': '198.51.100.9',
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).reason, 'rate_limit_exceeded');
  } finally {
    await instance.close();
  }
});

test('with a trusted proxy, different client IPs get different rate-limit buckets', async () => {
  const instance = await serve({
    config: { ...testConfig(), trustProxy: 1 },
    facilitator: stubFacilitator(),
    rateLimiter: oneVerifyLimit(),
    catalog: stubCatalog(),
  });
  try {
    const a1 = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.ok(a1.status !== 429, `client A first request should pass, got ${a1.status}`);

    // A different client IP must land in its own bucket.
    const b1 = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '198.51.100.9' });
    assert.ok(b1.status !== 429, `client B should have an independent bucket, got ${b1.status}`);

    // ...and client A is now out of budget.
    const a2 = await instance.post('/verify', VALID_BODY, { 'x-forwarded-for': '203.0.113.7' });
    assert.equal(a2.status, 429);

    // Even a forged XFF beyond one trusted hop is not believed: with
    // TRUST_PROXY=1 only the immediate connection peer is trusted, so the
    // leftmost entry stays attacker-controlled noise.
    const forged = await instance.post('/verify', VALID_BODY, {
      'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    });
    assert.equal(forged.status, 429);
  } finally {
    await instance.close();
  }
});
