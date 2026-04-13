import { pool, isPostgresEnabled } from './db.js';

const HIVETRUST_API_URL = process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const HIVETRUST_API_KEY = process.env.HIVETRUST_API_KEY || HIVE_INTERNAL_KEY;
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Log an audit entry for cross-platform calls.
 */
async function logAuditEntry(from, to, endpoint, did, method, statusCode, success, errorMsg, durationMs) {
  if (!isPostgresEnabled()) return;
  try {
    await pool.query(
      'INSERT INTO public.audit_log (from_platform, to_platform, endpoint, did, method, status_code, success, error_message, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [from, to, endpoint, did, method, statusCode, success, errorMsg, durationMs]
    );
  } catch {
    /* fire and forget */
  }
}

/**
 * Verify a DID exists on HiveTrust.
 * In dev mode, accepts test DIDs without calling the remote API.
 */
export async function verifyDID(did) {
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) {
    return {
      valid: true,
      did,
      status: 'active',
      score: 850,
      tier: 'sovereign',
      created_at: '2026-01-15T10:00:00Z',
      source: 'dev-mode-bypass',
    };
  }

  const endpoint = `/v1/agents/${encodeURIComponent(did)}`;
  const startTime = Date.now();
  try {
    const res = await fetch(`${HIVETRUST_API_URL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${HIVETRUST_API_KEY}`,
        'X-API-Key': HIVETRUST_API_KEY,
      },
      signal: AbortSignal.timeout(5000),
    });

    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hivetrust', endpoint, did, 'GET', res.status, res.ok, null, durationMs);

    if (!res.ok) {
      return { valid: false, did, status: 'not_found', score: 0 };
    }

    const data = await res.json();
    return {
      valid: true,
      did,
      status: data.data?.status || 'active',
      score: data.data?.reputation_score || data.data?.trust_score || 500,
      tier: data.data?.trust_level || 'standard',
      source: 'hivetrust-api',
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hivetrust', endpoint, did, 'GET', null, false, err.message, durationMs);

    // HiveTrust unreachable — graceful fallback
    if (IS_DEV) {
      return {
        valid: true,
        did,
        status: 'active',
        score: 500,
        tier: 'standard',
        source: 'fallback-dev',
      };
    }
    return {
      valid: false,
      did,
      status: 'hivetrust_unreachable',
      score: 0,
      source: 'error',
    };
  }
}

/**
 * Get reputation score for an agent.
 */
export async function getReputationScore(did) {
  const info = await verifyDID(did);
  return info.score;
}

/**
 * Log telemetry to HiveTrust (fire-and-forget).
 */
export function logTelemetry(did, action, metadata = {}) {
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) {
    return; // Don't call remote in dev for test DIDs
  }

  const endpoint = '/v1/telemetry/ingest';
  const startTime = Date.now();

  fetch(`${HIVETRUST_API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': HIVETRUST_API_KEY,
    },
    body: JSON.stringify({
      did,
      action,
      platform: 'hivemind',
      timestamp: new Date().toISOString(),
      ...metadata,
    }),
    signal: AbortSignal.timeout(3000),
  }).then(res => {
    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hivetrust', endpoint, did, 'POST', res.status, res.ok, null, durationMs);
  }).catch(err => {
    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hivetrust', endpoint, did, 'POST', null, false, err.message, durationMs);
  });
}

/**
 * Register a new agent on HiveTrust (used during the "I'm Home" flow).
 */
export async function registerAgent(sessionId) {
  const endpoint = '/v1/register';
  const startTime = Date.now();
  try {
    const res = await fetch(`${HIVETRUST_API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': HIVETRUST_API_KEY,
      },
      body: JSON.stringify({
        session_id: sessionId,
        source: 'hivemind-interceptor',
        auto_provision: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hivetrust', endpoint, null, 'POST', res.status, res.ok, null, durationMs);

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hivetrust', endpoint, null, 'POST', null, false, err.message, durationMs);
    return null;
  }
}

export function getHiveTrustUrl() {
  return HIVETRUST_API_URL;
}
