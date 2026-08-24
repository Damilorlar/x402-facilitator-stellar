/**
 * Redis-backed rate limiter for multi-instance deployments.
 *
 * The in-memory RateLimiter keeps one Map per process. Behind a load balancer
 * every instance has its own counters, so limits are effectively multiplied by
 * the instance count and usage reporting is per-node. This subclass moves the
 * buckets into Redis with a TTL equal to the window, so all instances share one
 * counter set and stale buckets expire on their own.
 *
 * Graceful degradation: if Redis is unreachable at boot or fails mid-flight,
 * operations fall back to the in-memory parent implementation and a warning is
 * logged once per outage. Rate limiting degrades to per-instance accuracy; it
 * never takes the service down.
 */
import { RateLimiter } from './rate-limit.js';

export class RedisRateLimiter extends RateLimiter {
  /**
   * @param {object} config - same shape as RateLimiter
   * @param {object} options
   * @param {object} [options.client] - an ioredis-compatible client. Injected
   *   in tests; when omitted, ioredis is imported lazily.
   * @param {string} options.redisUrl - redis:// connection URL
   * @param {Function} [options.warn] - warning sink, defaults to console.warn
   */
  constructor(config, { client, redisUrl, warn = msg => console.warn(msg) } = {}) {
    super(config);
    this.redis = client ?? null;
    this.warn = warn;
    this.degraded = false;
    this.external = Boolean(client);
    if (!this.redis && redisUrl) {
      // Lazy import so the process still boots if the optional dependency is
      // missing entirely — it then runs fully in memory.
      import('ioredis')
        .then(({ default: Redis }) => {
          this.redis = new Redis(redisUrl);
          this.redis.on('error', err => this._degrade(`Redis error: ${err.message}`));
          this.redis.on('ready', () => this._recover());
        })
        .catch(err => this._degrade(`Redis unavailable (${err.message}); using in-memory buckets`));
    }
  }

  _degrade(message) {
    if (!this.degraded) {
      this.degraded = true;
      this.warn(`[RateLimit] ${message} — rate limits are now per-instance`);
    }
  }

  _recover() {
    if (this.degraded) {
      this.degraded = false;
      this.warn('[RateLimit] Redis reconnected — shared buckets restored');
    }
  }

  /** Runs fn against Redis; falls back to the in-memory path on any failure. */
  async _withRedis(fn, fallback) {
    if (!this.redis || this.degraded || this.redis.status === 'end') return fallback();
    try {
      return await fn(this.redis);
    } catch (err) {
      this._degrade(`Redis operation failed: ${err.message}`);
      return fallback();
    }
  }

  async _incrementAsync(ownerId, type, windowSec, amount = 1) {
    const bucketId = `ratelimit:${this._getBucketId(ownerId, type, windowSec)}`;
    const now = Math.floor(Date.now() / 1000);
    const resetAt = now - (now % windowSec) + windowSec;
    return this._withRedis(
      async redis => {
        // Atomic counter with TTL: INCR then set expiry only on first hit.
        const count = await redis.incr(bucketId);
        if (count === 1) await redis.expire(bucketId, windowSec + 1);
        return { count, resetAt };
      },
      () => {
        super._increment(ownerId, type, windowSec, amount);
        const bucket = this.store.get(bucketId.replace('ratelimit:', ''));
        return { count: bucket?.count ?? amount, resetAt };
      },
    );
  }

  async _checkAsync(ownerId, type, windowSec, limit, amount = 1) {
    const bucketId = `ratelimit:${this._getBucketId(ownerId, type, windowSec)}`;
    const now = Math.floor(Date.now() / 1000);
    const resetAt = now - (now % windowSec) + windowSec;
    return this._withRedis(
      async redis => {
        const count = Number((await redis.get(bucketId)) ?? 0);
        if (count + amount > limit) return { allowed: false, limit, remaining: 0, resetAt };
        return { allowed: true, limit, remaining: limit - count - amount, resetAt };
      },
      () => {
        const res = this._check(ownerId, type, windowSec, limit, amount);
        return { ...res, resetAt };
      },
    );
  }

  // The public surface becomes async; app.js already awaits nothing on these,
  // but Promise-wrapping keeps callers uniform.

  checkVerify(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    return this._checkAsync(ownerId, 'verify', 60, limits.verifyRpm).then(res => {
      if (!res.allowed) res.reason = 'rate_limit_exceeded';
      return res;
    });
  }

  async recordVerify(req) {
    const ownerId = req.keyId || req.ip;
    await this._incrementAsync(ownerId, 'verify', 60, 1);
  }

  async checkSettle(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const checks = [
      await this._checkAsync(ownerId, 'settle', 60, limits.settleRpm),
      await this._checkAsync(ownerId, 'settle', 3600, limits.settleRph),
      await this._checkAsync(ownerId, 'settle', 86400, limits.settleRpd),
    ];
    for (const c of checks) {
      if (!c.allowed) return { ...c, reason: 'rate_limit_exceeded' };
    }
    const feeCheck = await this._checkAsync(ownerId, 'fee', 86400, limits.feeSpd, 0);
    if (!feeCheck.allowed) return { ...feeCheck, reason: 'fee_ceiling_exceeded' };
    return checks.reduce((tightest, current) =>
      current.remaining < tightest.remaining ? current : tightest,
    );
  }

  async recordSettle(req, feeCharged) {
    const ownerId = req.keyId || req.ip;
    await this._incrementAsync(ownerId, 'settle', 60, 1);
    await this._incrementAsync(ownerId, 'settle', 3600, 1);
    await this._incrementAsync(ownerId, 'settle', 86400, 1);
    if (feeCharged) await this._incrementAsync(ownerId, 'fee', 86400, feeCharged);
  }

  checkCatalog(req) {
    const ownerId = req.ip;
    const limits = this._getKeyConfig(undefined);
    return this._checkAsync(ownerId, 'catalog', 60, limits.catalogRpm).then(res => {
      if (!res.allowed) res.reason = 'catalog_rate_limited';
      return res;
    });
  }

  async recordCatalog(req) {
    const ownerId = req.ip;
    await this._incrementAsync(ownerId, 'catalog', 60, 1);
  }

  async getUsage(keyId) {
    const ownerId = keyId;
    const types = [
      ['verify_rpm', 'verify', 60],
      ['settle_rpm', 'settle', 60],
      ['settle_rph', 'settle', 3600],
      ['settle_rpd', 'settle', 86400],
      ['fee_spd', 'fee', 86400],
    ];
    const counts = {};
    for (const [name, type, windowSec] of types) {
      counts[name] = await this._withRedis(
        async redis =>
          Number(
            (await redis.get(`ratelimit:${this._getBucketId(ownerId, type, windowSec)}`)) ?? 0,
          ),
        () => this.store.get(this._getBucketId(ownerId, type, windowSec))?.count || 0,
      );
    }
    return counts;
  }
}
