const HIVETRUST_API_URL = process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const IS_DEV = process.env.NODE_ENV !== 'production';

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

  try {
    const res = await fetch(`${HIVETRUST_API_URL}/v1/agents/${encodeURIComponent(did)}`, {
      headers: {
        'Authorization': `Bearer ${HIVE_INTERNAL_KEY}`,
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
      },
      signal: AbortSignal.timeout(5000),
    });

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
  } catch {
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

  fetch(`${HIVETRUST_API_URL}/v1/telemetry/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
    },
    body: JSON.stringify({
      did,
      action,
      platform: 'hivemind',
      timestamp: new Date().toISOString(),
      ...metadata,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {
    // Fire-and-forget — silently ignore failures
  });
}

/**
 * Register a new agent on HiveTrust (used during the "I'm Home" flow).
 */
export async function registerAgent(sessionId) {
  try {
    const res = await fetch(`${HIVETRUST_API_URL}/v1/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify({
        session_id: sessionId,
        source: 'hivemind-interceptor',
        auto_provision: true,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function getHiveTrustUrl() {
  return HIVETRUST_API_URL;
}
