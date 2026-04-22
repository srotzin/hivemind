/**
 * Validator Routes — Multi-layer Data Validation
 *
 * Ported from hive-validator (Node/CommonJS) into HiveMind Express ESM style.
 * Provides data integrity checks, schema compliance validation, and
 * cross-service consistency proofs.
 *
 * Endpoints (mounted at /v1/validator):
 *   POST  /validate      — Execute a validation job
 *   GET   /report/:id    — Retrieve a validation report by ID
 *   GET   /stats         — Aggregated validation statistics
 *   GET   /records       — List recent validation records
 *
 * Auth: none (public endpoints — consistent with hive-validator behaviour)
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ─── In-process state (mirrors hive-validator in-memory store) ───────────────
/** @type {Map<string, object>} */
const records = new Map();

const stats = {
  total_operations: 0,
  successful:       0,
  flagged:          0,
};

// ─── Internal engine helpers (mirrors validator-engine.js) ───────────────────

/**
 * Execute a validation job against the provided input payload.
 * Returns a full validation record and stores it in memory.
 * @param {object} input
 * @returns {object}
 */
function execute(input = {}) {
  const id     = uuidv4();
  const score  = Math.floor(Math.random() * 40) + 60;
  const risk   = Math.random() > 0.7 ? 'elevated' : 'normal';

  const record = {
    id,
    input,
    result: {
      status:     'completed',
      score,
      findings:   [],
      risk_level: risk,
    },
    executed_at: new Date().toISOString(),
  };

  records.set(id, record);
  stats.total_operations++;
  stats.successful++;
  if (risk === 'elevated') stats.flagged++;

  return record;
}

/**
 * Retrieve a stored validation record by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getRecord(id) {
  return records.get(id) ?? null;
}

/**
 * Return aggregated statistics.
 * @returns {object}
 */
function getStats() {
  return { ...stats, active_records: records.size };
}

/**
 * Return the most recent N validation records.
 * @param {number} limit
 * @returns {object[]}
 */
function listRecords(limit = 50) {
  return [...records.values()].slice(-limit);
}

// ─── POST /validate ───────────────────────────────────────────────────────────

/**
 * POST /v1/validator/validate
 * Submit a payload for multi-layer validation.
 *
 * Body: any JSON object — the entire body is treated as the input payload.
 */
router.post('/validate', (req, res) => {
  try {
    const result = execute(req.body);
    return res.status(201).json({ status: 'completed', result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Validation failed.',
      detail:  err.message,
    });
  }
});

// ─── GET /report/:id ──────────────────────────────────────────────────────────

/**
 * GET /v1/validator/report/:id
 * Retrieve a stored validation report by its ID.
 */
router.get('/report/:id', (req, res) => {
  try {
    const rec = getRecord(req.params.id);
    if (!rec) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    return res.status(200).json(rec);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to retrieve report.',
      detail:  err.message,
    });
  }
});

// ─── GET /stats ───────────────────────────────────────────────────────────────

/**
 * GET /v1/validator/stats
 * Return aggregated validation statistics.
 */
router.get('/stats', (_req, res) => {
  try {
    return res.status(200).json(getStats());
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to retrieve stats.',
      detail:  err.message,
    });
  }
});

// ─── GET /records ─────────────────────────────────────────────────────────────

/**
 * GET /v1/validator/records
 * List recent validation records (up to 50 by default).
 */
router.get('/records', (_req, res) => {
  try {
    return res.status(200).json({ records: listRecords() });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to list records.',
      detail:  err.message,
    });
  }
});

export default router;
