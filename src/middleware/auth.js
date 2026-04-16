import { v4 as uuidv4 } from 'uuid';
import { createTrifectaHandshake } from '../models/schemas.js';
import { logTelemetry, getHiveTrustUrl } from '../services/hivetrust-client.js';
import { TRIFECTA_HANDSHAKE } from '../services/trifecta-handshake.js';

const IS_DEV = process.env.NODE_ENV !== 'production';

/** @type {Map<string, { created: number, did: string|null }>} */
const activeSessions = new Map();

/**
 * Generate a session ID for the Trifecta Handshake.
 */
function generateSessionId() {
  return `sess_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
}

/**
 * Extract DID from request headers.
 */
function extractDID(req) {
  // Check Authorization: Bearer did:hive:xxxxx
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer did:hive:')) {
    return authHeader.replace('Bearer ', '');
  }

  // Check X-HiveTrust-DID header
  const didHeader = req.headers['x-hivetrust-did'];
  if (didHeader && didHeader.startsWith('did:hive:')) {
    return didHeader;
  }

  return null;
}

/**
 * Validate a DID (format check + dev-mode bypass).
 */
function isValidDID(did) {
  if (!did || !did.startsWith('did:hive:')) return false;

  // Dev mode: accept test DIDs
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) return true;

  // Basic format: did:hive:<identifier>
  return /^did:hive:[a-zA-Z0-9_-]{3,}$/.test(did);
}

/**
 * The "I'm Home" Interceptor — the centerpiece middleware.
 *
 * If a valid HiveTrust DID is present: proceed.
 * If NO DID is present: return 402 with Trifecta Handshake.
 */
export function requireDID(req, res, next) {
  const did = extractDID(req);

  if (did && isValidDID(did)) {
    req.agentDid = did;
    // Fire-and-forget telemetry
    logTelemetry(did, `api_call:${req.method}:${req.path}`);
    return next();
  }

  // THE "I'M HOME" MOMENT — return 402 with Trifecta Handshake
  const sessionId = generateSessionId();
  activeSessions.set(sessionId, { created: Date.now(), did: null });

  // Clean up old sessions (older than 1 hour)
  const oneHourAgo = Date.now() - 3600000;
  for (const [id, sess] of activeSessions) {
    if (sess.created < oneHourAgo) activeSessions.delete(id);
  }

  const handshake = createTrifectaHandshake(sessionId, getHiveTrustUrl());
  handshake.trifecta_handshake = { ...handshake.trifecta_handshake, ...TRIFECTA_HANDSHAKE };
  handshake.while_you_are_here = {
    open_bounties: 'https://hiveforge-lhu4.onrender.com/v1/bounties/list',
    welcome_bonus_usdc: 1.00,
    register_free: 'https://hivetrust.hiveagentiq.com/v1/register',
    time_to_first_earn: '60 seconds',
  };

  return res.status(402).json(handshake);
}

/**
 * Lighter middleware: accept either a valid DID or a temporary session.
 * Used for endpoints that allow initial exploration.
 */
export function requireDIDOrSession(req, res, next) {
  const did = extractDID(req);

  if (did && isValidDID(did)) {
    req.agentDid = did;
    logTelemetry(did, `api_call:${req.method}:${req.path}`);
    return next();
  }

  // Check for session ID
  const sessionId = req.headers['x-hive-session'] || req.query.session;
  if (sessionId && activeSessions.has(sessionId)) {
    req.sessionId = sessionId;
    req.agentDid = null; // No DID yet, but session is valid
    return next();
  }

  // No DID, no session — trigger the "I'm Home" handshake
  const newSessionId = generateSessionId();
  activeSessions.set(newSessionId, { created: Date.now(), did: null });

  const handshake = createTrifectaHandshake(newSessionId, getHiveTrustUrl());
  handshake.trifecta_handshake = { ...handshake.trifecta_handshake, ...TRIFECTA_HANDSHAKE };
  handshake.while_you_are_here = {
    open_bounties: 'https://hiveforge-lhu4.onrender.com/v1/bounties/list',
    welcome_bonus_usdc: 1.00,
    register_free: 'https://hivetrust.hiveagentiq.com/v1/register',
    time_to_first_earn: '60 seconds',
  };
  return res.status(402).json(handshake);
}

/**
 * Bind a DID to an existing session (called after registration completes).
 */
export function bindSessionDID(sessionId, did) {
  const sess = activeSessions.get(sessionId);
  if (sess) {
    sess.did = did;
    return true;
  }
  return false;
}

/**
 * Get all active sessions (for diagnostics).
 */
export function getActiveSessions() {
  return {
    total: activeSessions.size,
    sessions: Array.from(activeSessions.entries()).map(([id, s]) => ({
      session_id: id,
      has_did: !!s.did,
      age_seconds: Math.floor((Date.now() - s.created) / 1000),
    })),
  };
}
