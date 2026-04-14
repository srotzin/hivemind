import { Router } from 'express';
import { pool, isPostgresEnabled } from '../services/db.js';
import { trackFunnelEvent } from './global-hive.js';

const router = Router();

const HIVEMIND_SERVICE_KEY = process.env.HIVEMIND_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';

function isAuthorized(req) {
  // Accept DID or internal key
  const authHeader = req.headers.authorization;
  const hasDID = authHeader && authHeader.startsWith('Bearer did:hive:');
  const didHeader = req.headers['x-hivetrust-did'];
  const hasDidHeader = didHeader && didHeader.startsWith('did:hive:');

  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  const hasInternalKey = HIVEMIND_SERVICE_KEY && internalKey === HIVEMIND_SERVICE_KEY;

  return hasDID || hasDidHeader || hasInternalKey;
}

/**
 * POST /v1/funnel/track
 * Record a funnel event.
 * Body: { event, did?, source?, metadata? }
 * Auth: DID or HIVE_INTERNAL_KEY
 */
router.post('/track', async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Authentication required. Provide DID or HIVE_INTERNAL_KEY.' });
    }

    const { event, did, source, metadata } = req.body;
    const validEvents = ['discovery', '402_hit', 'registration', 'first_memory', 'first_transaction'];

    if (!event || !validEvents.includes(event)) {
      return res.status(400).json({
        success: false,
        error: `Invalid event. Must be one of: ${validEvents.join(', ')}`,
      });
    }

    await trackFunnelEvent(event, did || null, source || 'api', metadata || {});

    return res.status(201).json({
      success: true,
      data: { event, did, source, tracked_at: new Date().toISOString() },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to track event.', detail: err.message });
  }
});

/**
 * GET /v1/funnel/stats
 * Funnel conversion statistics.
 * Auth: DID or HIVE_INTERNAL_KEY
 */
router.get('/stats', async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    if (isPostgresEnabled()) {
      const result = await pool.query('SELECT * FROM hivemind.funnel_stats WHERE id = 1');
      const stats = result.rows[0] || {
        discovery_count: 0,
        hit_402_count: 0,
        registration_count: 0,
        first_memory_count: 0,
        first_transaction_count: 0,
      };

      const discovery = stats.discovery_count || 0;
      const registration = stats.registration_count || 0;
      const transaction = stats.first_transaction_count || 0;

      return res.status(200).json({
        success: true,
        data: {
          discovery_count: discovery,
          hit_402_count: stats.hit_402_count || 0,
          registration_count: registration,
          first_memory_count: stats.first_memory_count || 0,
          first_transaction_count: transaction,
          conversion_rates: {
            discovery_to_402: discovery > 0 ? parseFloat(((stats.hit_402_count || 0) / discovery * 100).toFixed(2)) : 0,
            discovery_to_registration: discovery > 0 ? parseFloat((registration / discovery * 100).toFixed(2)) : 0,
            registration_to_transaction: registration > 0 ? parseFloat((transaction / registration * 100).toFixed(2)) : 0,
          },
          last_updated: stats.last_updated,
        },
      });
    }

    // In-memory fallback — no persistent tracking
    return res.status(200).json({
      success: true,
      data: {
        discovery_count: 0,
        hit_402_count: 0,
        registration_count: 0,
        first_memory_count: 0,
        first_transaction_count: 0,
        conversion_rates: {
          discovery_to_402: 0,
          discovery_to_registration: 0,
          registration_to_transaction: 0,
        },
        last_updated: null,
        note: 'Funnel tracking requires PostgreSQL. Running in-memory mode.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get funnel stats.', detail: err.message });
  }
});

export default router;
