import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisRateLimiter } from '../src/redis-rate-limit.js';

/**
 * Minimal ioredis stand-in: real INCR/EXPIRE/GET semantics against a Map, so
 * the atomic-counter and TTL behaviour is exercised without a server.
 */
function fakeRedis() {
  const store = new Map(); // key -> { value, ttl }
  return {
    store,
    status: 'ready',
    on: () => {},
    async incr(key) {
      const entry = store.get(key) ?? { value: 0, expiresAt: Infinity };
      entry.value += 1;
      store.set(key, entry);
      return entry.value;
    },
    async expire(key, seconds) {
      const entry = store.get(key);
      if (entry) entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry || entry.expiresAt < Date.now()) return null;
      return String(entry.value);
    },
  };
}

function limiterConfig() {
  return {
    global: {
      verifyRpm: 2,
      settleRpm: 1,
      settleRph: 10,
      settleRpd: 100,
      feeSpd: 1e9,
      catalogRpm: 1,
    },
    keys: {},
  };
}

test('redis limiter counts in shared buckets with a TTL', async () => {
  const client = fakeRedis();
  const limiter = new RedisRateLimiter(limiterConfig(), { client });

  await limiter.recordVerify({ ip: '10.1.1.1' });
  await limiter.recordVerify({ ip: '10.1.1.1' });

  // A second instance sharing the same Redis sees the same counter.
  const otherInstance = new RedisRateLimiter(limiterConfig(), { client });
  const check = await otherInstance.checkVerify({ ip: '10.1.1.1' });
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'rate_limit_exceeded');
  assert.equal(check.remaining, 0);

  // Buckets were written to Redis, not the local Map.
  assert.ok([...client.store.keys()].every(k => k.startsWith('ratelimit:')));
});

test('redis limiter keeps distinct IPs in distinct buckets', async () => {
  const limiter = new RedisRateLimiter(limiterConfig(), { client: fakeRedis() });
  await limiter.recordVerify({ ip: '10.0.0.1' });
  await limiter.recordVerify({ ip: '10.0.0.1' });
  assert.equal((await limiter.checkVerify({ ip: '10.0.0.1' })).allowed, false);
  assert.equal((await limiter.checkVerify({ ip: '10.0.0.2' })).allowed, true);
});

test('redis limiter degrades to memory when Redis fails', async () => {
  const warnings = [];
  const client = fakeRedis();
  client.incr = async () => {
    throw new Error('LOADING Redis is loading');
  };
  const limiter = new RedisRateLimiter(limiterConfig(), {
    client,
    warn: m => warnings.push(m),
  });

  // The operation still succeeds — per-instance accuracy, but no outage.
  await limiter.recordVerify({ ip: '10.2.2.2' });
  assert.equal((await limiter.checkVerify({ ip: '10.2.2.2' })).allowed, true);
  assert.equal(limiter.degraded, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /per-instance/);
});
