import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limit.js';

test('rate limiter honors global limits', async () => {
  const config = {
    global: { verifyRpm: 2, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const req = { keyId: 'test_key' };

  // Verify
  assert.equal((await limiter.checkVerify(req)).allowed, true);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, true);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, false);

  // Settle
  assert.equal((await limiter.checkSettle(req)).allowed, true);
  await limiter.recordSettle(req, 500);
  assert.equal((await limiter.checkSettle(req)).allowed, false); // RPM exceeded

  // Check usage
  const usage = await limiter.getUsage('test_key');
  assert.equal(usage.verify_rpm, 2);
  assert.equal(usage.settle_rpm, 1);
  assert.equal(usage.fee_spd, 500);
});

test('rate limiter honors per-key overrides', async () => {
  const config = {
    global: { verifyRpm: 1, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    keys: {
      test_key: { verifyRpm: 5, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    },
  };
  const limiter = new RateLimiter(config);
  const req = { keyId: 'test_key' };

  await limiter.recordVerify(req);
  await limiter.recordVerify(req);
  assert.equal((await limiter.checkVerify(req)).allowed, true); // Since limit is 5
});

test('rate limiter halts on fee ceiling', async () => {
  const config = {
    global: { verifyRpm: 10, settleRpm: 10, settleRph: 10, settleRpd: 10, feeSpd: 500 },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const req = { keyId: 'test_key' };

  assert.equal((await limiter.checkSettle(req)).allowed, true);
  await limiter.recordSettle(req, 400);
  assert.equal((await limiter.checkSettle(req)).allowed, true);

  // Checking doesn't increment, but if we assume the next transaction could be up to max fee?
  // Our implementation checks if current consumed > limit.
  // Wait, current consumed is 400. limit is 500. So allowed = true.
  // Next settlement consumes 200.
  await limiter.recordSettle(req, 200);

  // Now consumed is 600. Next check should fail.
  const res = await limiter.checkSettle(req);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, 'fee_ceiling_exceeded');
});

test('rate limiter falls back to IP in open mode', async () => {
  const config = {
    global: { verifyRpm: 1, settleRpm: 1, settleRph: 10, settleRpd: 100, feeSpd: 1000 },
    keys: {},
  };
  const limiter = new RateLimiter(config);
  const req1 = { ip: '192.168.1.1' };
  const req2 = { ip: '192.168.1.2' };

  assert.equal((await limiter.checkVerify(req1)).allowed, true);
  await limiter.recordVerify(req1);
  assert.equal((await limiter.checkVerify(req1)).allowed, false);

  // req2 should still be allowed since it's a different IP
  assert.equal((await limiter.checkVerify(req2)).allowed, true);
});
