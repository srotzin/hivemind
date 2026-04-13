import { pool, isPostgresEnabled } from '../services/db.js';

/**
 * Rate tier limits (requests per minute).
 */
const TIER_LIMITS = {
  unregistered: 10,
  starter: 100,
  builder: 1000,
  enterprise: 10000,
};

/**
 * Map HiveTrust trust levels to rate limit tiers.
 */
function getTier(did) {
  // If no DID, treat as unregistered
  if (!did) return 'unregistered';
  // Test DIDs in dev mode get builder tier
  if (process.env.NODE_ENV !== 'production' && did.startsWith('did:hive:test_agent_')) {
    return 'builder';
  }
  return 'starter'; // Default tier; could be enhanced with ledger lookup
}

/**
 * Rate limiting middleware using sliding window with PostgreSQL.
 * Falls through (no limiting) if DATABASE_URL is not set.
 */
export function rateLimit(req, res, next) {
  if (!isPostgresEnabled()) {
    return next();
  }

  const did = req.agentDid || req.headers['x-hivetrust-did'] || req.ip;
  const tier = getTier(req.agentDid);
  const limit = TIER_LIMITS[tier] || TIER_LIMITS.unregistered;

  // Current minute bucket
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());

  pool.query(
    `INSERT INTO public.rate_limits (did, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (did, window_start)
     DO UPDATE SET request_count = public.rate_limits.request_count + 1
     RETURNING request_count`,
    [did, windowStart]
  ).then(result => {
    const count = result.rows[0].request_count;

    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.set('X-RateLimit-Reset', String(Math.ceil((windowStart.getTime() + 60000) / 1000)));

    if (count > limit) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded.',
        tier,
        limit_per_minute: limit,
        current_count: count,
        retry_after_seconds: Math.ceil((windowStart.getTime() + 60000 - Date.now()) / 1000),
      });
    }

    next();
  }).catch(() => {
    // If rate limit check fails, allow the request through
    next();
  });
}
