/**
 * In-memory sliding-window (or fixed-window) rate limiter and usage meter.
 */
export class RateLimiter {
  constructor(config) {
    this.config = config;
    this.store = new Map(); // Map<string, { count, resetAt }>
  }

  _getKeyConfig(keyId) {
    return this.config.keys[keyId] || this.config.global;
  }

  _getBucketId(ownerId, type, windowSec) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSec);
    return `${ownerId}:${type}:${windowStart}:${windowSec}`;
  }

  _increment(ownerId, type, windowSec, amount = 1) {
    const bucketId = this._getBucketId(ownerId, type, windowSec);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSec);
    const resetAt = windowStart + windowSec;

    let bucket = this.store.get(bucketId);
    if (!bucket) {
      bucket = { count: 0, resetAt };
      this.store.set(bucketId, bucket);
    }
    bucket.count += amount;

    // cleanup old buckets periodically (simple approach: every request we might sweep, but for now just rely on TTL logic if persistence is added, or sweep manually)
    if (Math.random() < 0.05) this._sweep(now);

    return bucket;
  }

  _check(ownerId, type, windowSec, limit, amount = 1) {
    const bucketId = this._getBucketId(ownerId, type, windowSec);
    const bucket = this.store.get(bucketId) || { count: 0, resetAt: Math.floor(Date.now() / 1000) + windowSec };
    if (bucket.count + amount > limit) {
      return { allowed: false, limit, remaining: 0, resetAt: bucket.resetAt };
    }
    return { allowed: true, limit, remaining: limit - bucket.count - amount, resetAt: bucket.resetAt };
  }

  _sweep(now) {
    for (const [id, bucket] of this.store.entries()) {
      if (bucket.resetAt <= now) {
        this.store.delete(id);
      }
    }
  }

  checkVerify(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    const res = this._check(ownerId, 'verify', 60, limits.verifyRpm);
    if (!res.allowed) res.reason = 'rate_limit_exceeded';
    return res;
  }

  recordVerify(req) {
    const ownerId = req.keyId || req.ip;
    this._increment(ownerId, 'verify', 60, 1);
  }

  checkSettle(req) {
    const ownerId = req.keyId || req.ip;
    const limits = this._getKeyConfig(req.keyId);
    
    // Check all three limits for settle
    const checks = [
      this._check(ownerId, 'settle', 60, limits.settleRpm),
      this._check(ownerId, 'settle', 3600, limits.settleRph),
      this._check(ownerId, 'settle', 86400, limits.settleRpd),
    ];
    
    for (const c of checks) {
      if (!c.allowed) return { ...c, reason: 'rate_limit_exceeded' };
    }
    
    // Check fee limit
    // We can't strictly check fee before settlement unless we assume maxTransactionFeeStroops.
    // We will check if the current consumed + 0 is > limits.feeSpd (or maxTransactionFeeStroops).
    const feeCheck = this._check(ownerId, 'fee', 86400, limits.feeSpd, 0); // just checking current
    if (!feeCheck.allowed) return { ...feeCheck, reason: 'fee_ceiling_exceeded' };

    // Return the tightest limit for headers
    return checks.reduce((tightest, current) => 
      (current.remaining < tightest.remaining ? current : tightest)
    );
  }

  recordSettle(req, feeCharged) {
    const ownerId = req.keyId || req.ip;
    this._increment(ownerId, 'settle', 60, 1);
    this._increment(ownerId, 'settle', 3600, 1);
    this._increment(ownerId, 'settle', 86400, 1);
    if (feeCharged) {
      this._increment(ownerId, 'fee', 86400, feeCharged);
    }
  }

  getUsage(keyId) {
    const ownerId = keyId; // IP usage is not exposed via GET /usage, only key usage
    const getCount = (type, windowSec) => {
      const bucketId = this._getBucketId(ownerId, type, windowSec);
      return this.store.get(bucketId)?.count || 0;
    };
    return {
      verify_rpm: getCount('verify', 60),
      settle_rpm: getCount('settle', 60),
      settle_rph: getCount('settle', 3600),
      settle_rpd: getCount('settle', 86400),
      fee_spd: getCount('fee', 86400),
    };
  }
}
