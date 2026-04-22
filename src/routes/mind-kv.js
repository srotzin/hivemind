/**
 * Mind KV Routes — Sovereign Agent Key-Value Memory Store
 *
 * Ported from hive-memory (Python/FastAPI) to Node/Express.
 * Provides a simple DID-scoped key-value store with optional
 * AES-256-GCM encryption, TTL support, tagging, export, and
 * zero-knowledge proof generation.
 *
 * Endpoints (mounted at /v1/mind/kv):
 *   POST   /store           — Store or upsert a key-value entry
 *   GET    /retrieve/:key   — Retrieve a single entry by key
 *   GET    /list            — List all entries for the authenticated DID
 *   DELETE /:key            — Delete an entry by key
 *   GET    /export          — Export all entries (encrypted blobs)
 *   POST   /proof           — Generate an HMAC proof for an entry
 *
 * Auth: requireDID (X-HiveTrust-DID or Authorization: Bearer did:hive:…)
 */

import { Router } from 'express';
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import { requireDID } from '../middleware/auth.js';
import { pool, isPostgresEnabled } from '../services/db.js';

const router = Router();

// ─── Pricing constants (mirrors hive-memory Python service) ──────────────────
const PRICE_STORE_PER_KB    = 0.0001;   // USDC per KB stored
const PRICE_RETRIEVE_PER_KB = 0.00005;  // USDC per KB retrieved

// ─── In-memory fallback store (keyed by DID → key → record) ─────────────────
/** @type {Map<string, Map<string, object>>} */
const _mem = new Map();

// ─── AES-256-GCM helpers ─────────────────────────────────────────────────────

/**
 * Derive a 32-byte AES key from a DID using SHA-256.
 * @param {string} did
 * @returns {Buffer}
 */
function deriveKey(did) {
  return createHash('sha256').update(did, 'utf8').digest();
}

/**
 * Encrypt a JSON-serialisable value with AES-256-GCM keyed to the DID.
 * Returns a base64 string: nonce(12B) || ciphertext || tag(16B).
 * @param {string} did
 * @param {*} value
 * @returns {string}
 */
function encryptValue(did, value) {
  const key    = deriveKey(did);
  const nonce  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(did, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag       = cipher.getAuthTag(); // 16 bytes
  return Buffer.concat([nonce, encrypted, tag]).toString('base64');
}

/**
 * Decrypt a base64 blob produced by encryptValue.
 * @param {string} did
 * @param {string} blob64
 * @returns {*}
 */
function decryptValue(did, blob64) {
  const key      = deriveKey(did);
  const blob     = Buffer.from(blob64, 'base64');
  const nonce    = blob.subarray(0, 12);
  const tag      = blob.subarray(blob.length - 16);
  const ctxt     = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(did, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ctxt), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Compute a deterministic memory_id from DID + key (UUID-v5-style via SHA-1).
 * @param {string} did
 * @param {string} key
 * @returns {string}
 */
function memoryId(did, key) {
  const h = createHash('sha1').update(`${did}:${key}`).digest('hex');
  // Lay out as a UUID: xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * Cost in USDC for a given byte count at the specified rate.
 * @param {number} sizeBytes
 * @param {number} ratePerKb
 * @returns {number}
 */
function sizeCost(sizeBytes, ratePerKb) {
  const kb = Math.max(1, Math.ceil(sizeBytes / 1024));
  return Math.round(kb * ratePerKb * 1e8) / 1e8;
}

// ─── DB table bootstrap ───────────────────────────────────────────────────────

let _tableEnsured = false;

/**
 * Ensure the hive_memory table exists (non-destructive / idempotent).
 * Called lazily on first access.
 */
async function ensureTable() {
  if (!isPostgresEnabled()) return false;
  if (_tableEnsured) return true;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hive_memory (
        did        TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        encrypted  BOOLEAN NOT NULL DEFAULT TRUE,
        tags       TEXT[] NOT NULL DEFAULT '{}',
        size_bytes INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        PRIMARY KEY (did, key)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hive_memory_did ON hive_memory(did)');
    _tableEnsured = true;
    return true;
  } catch (e) {
    console.error('[mind-kv] ensureTable failed:', e.message);
    return false;
  }
}

// ─── POST /store ──────────────────────────────────────────────────────────────

/**
 * POST /v1/mind/kv/store
 * Store or upsert a key-value entry scoped to the authenticated DID.
 *
 * Body: { key, value, encrypted?: boolean, tags?: string[], ttl_seconds?: number }
 */
router.post('/store', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const {
      key,
      value,
      encrypted   = true,
      tags        = [],
      ttl_seconds,
    } = req.body;

    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'key is required and must be a non-empty string.',
      });
    }
    if (value === undefined || value === null) {
      return res.status(400).json({ success: false, error: 'value is required.' });
    }

    const plainJson   = JSON.stringify(value);
    const sizeBytes   = Buffer.byteLength(plainJson, 'utf8');
    const storedValue = encrypted ? encryptValue(did, value) : plainJson;
    const now         = new Date();
    const expiresAt   = ttl_seconds ? new Date(now.getTime() + ttl_seconds * 1000) : null;
    const mid         = memoryId(did, key);

    if (isPostgresEnabled()) {
      await ensureTable();
      const existing = await pool.query(
        'SELECT created_at FROM hive_memory WHERE did=$1 AND key=$2',
        [did, key]
      );
      const createdAt = existing.rows[0]?.created_at ?? now;
      await pool.query(`
        INSERT INTO hive_memory
          (did, key, value, encrypted, tags, size_bytes, created_at, updated_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (did, key) DO UPDATE
          SET value=$3, encrypted=$4, tags=$5, size_bytes=$6, updated_at=$8, expires_at=$9
      `, [did, key, storedValue, encrypted, tags, sizeBytes, createdAt, now, expiresAt]);
    } else {
      if (!_mem.has(did)) _mem.set(did, new Map());
      const didStore  = _mem.get(did);
      const createdAt = didStore.get(key)?.created_at ?? now;
      didStore.set(key, {
        value:      storedValue,
        encrypted,
        tags,
        size_bytes: sizeBytes,
        created_at: createdAt,
        updated_at: now,
        expires_at: expiresAt,
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        stored:    true,
        memory_id: mid,
        did,
        key,
        size_bytes: sizeBytes,
        expires_at: expiresAt,
        cost_usdc:  sizeCost(sizeBytes, PRICE_STORE_PER_KB),
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to store memory.',
      detail:  err.message,
    });
  }
});

// ─── GET /retrieve/:key ──────────────────────────────────────────────────────

/**
 * GET /v1/mind/kv/retrieve/:key
 * Retrieve a single entry by key for the authenticated DID.
 */
router.get('/retrieve/:key', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const { key } = req.params;
    const now = new Date();

    let record = null;

    if (isPostgresEnabled()) {
      await ensureTable();
      const result = await pool.query(
        'SELECT * FROM hive_memory WHERE did=$1 AND key=$2',
        [did, key]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: `Memory key '${key}' not found.`,
        });
      }
      record = result.rows[0];
      if (record.expires_at && now > new Date(record.expires_at)) {
        await pool.query('DELETE FROM hive_memory WHERE did=$1 AND key=$2', [did, key]);
        return res.status(404).json({
          success: false,
          error: `Memory key '${key}' has expired.`,
        });
      }
    } else {
      record = _mem.get(did)?.get(key) ?? null;
      if (!record) {
        return res.status(404).json({
          success: false,
          error: `Memory key '${key}' not found.`,
        });
      }
      if (record.expires_at && now > new Date(record.expires_at)) {
        _mem.get(did)?.delete(key);
        return res.status(404).json({
          success: false,
          error: `Memory key '${key}' has expired.`,
        });
      }
    }

    const value = record.encrypted
      ? decryptValue(did, record.value)
      : JSON.parse(record.value);

    const sizeBytes = record.size_bytes
      ?? Buffer.byteLength(JSON.stringify(value), 'utf8');

    return res.status(200).json({
      success: true,
      data: {
        key,
        value,
        created_at: record.created_at,
        updated_at: record.updated_at,
        tags:       record.tags,
        size_bytes: sizeBytes,
        cost_usdc:  sizeCost(sizeBytes, PRICE_RETRIEVE_PER_KB),
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to retrieve memory.',
      detail:  err.message,
    });
  }
});

// ─── GET /list ────────────────────────────────────────────────────────────────

/**
 * GET /v1/mind/kv/list
 * List entry metadata (no values) for the authenticated DID.
 *
 * Query params: tags (comma-separated), limit (default 50, max 500), offset (default 0)
 */
router.get('/list', requireDID, async (req, res) => {
  try {
    const did    = req.agentDid;
    const now    = new Date();
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const tagFilter = req.query.tags
      ? req.query.tags.split(',').map(t => t.trim()).filter(Boolean)
      : null;

    let entries = [];
    let total   = 0;

    if (isPostgresEnabled()) {
      await ensureTable();
      const params = [did, now];
      let whereExtra = '';
      if (tagFilter && tagFilter.length > 0) {
        params.push(tagFilter);
        whereExtra = ` AND tags && $${params.length}::text[]`;
      }
      const countRes = await pool.query(
        `SELECT COUNT(*) FROM hive_memory WHERE did=$1 AND (expires_at IS NULL OR expires_at > $2)${whereExtra}`,
        params
      );
      total = parseInt(countRes.rows[0].count, 10);

      const listParams = [...params, limit, offset];
      const listRes = await pool.query(
        `SELECT key, tags, size_bytes, created_at, updated_at, encrypted, expires_at
         FROM hive_memory
         WHERE did=$1 AND (expires_at IS NULL OR expires_at > $2)${whereExtra}
         ORDER BY updated_at DESC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      );
      entries = listRes.rows;
    } else {
      const didStore = _mem.get(did) ?? new Map();
      for (const [k, record] of didStore.entries()) {
        if (record.expires_at && now > new Date(record.expires_at)) continue;
        if (tagFilter && !tagFilter.some(t => record.tags.includes(t))) continue;
        entries.push({
          key:        k,
          tags:       record.tags,
          size_bytes: record.size_bytes,
          created_at: record.created_at,
          updated_at: record.updated_at,
          encrypted:  record.encrypted,
          expires_at: record.expires_at ?? null,
        });
      }
      entries.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      total   = entries.length;
      entries = entries.slice(offset, offset + limit);
    }

    return res.status(200).json({
      success: true,
      data: { did, total, limit, offset, entries },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to list memory entries.',
      detail:  err.message,
    });
  }
});

// ─── DELETE /:key ─────────────────────────────────────────────────────────────

/**
 * DELETE /v1/mind/kv/:key
 * Delete an entry by key for the authenticated DID.
 */
router.delete('/:key', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const { key } = req.params;
    let deleted = false;

    if (isPostgresEnabled()) {
      await ensureTable();
      const result = await pool.query(
        'DELETE FROM hive_memory WHERE did=$1 AND key=$2',
        [did, key]
      );
      deleted = result.rowCount > 0;
    } else {
      const didStore = _mem.get(did);
      if (didStore?.has(key)) {
        didStore.delete(key);
        deleted = true;
      }
    }

    return res.status(200).json({
      success: true,
      data: { deleted, key, did },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to delete memory entry.',
      detail:  err.message,
    });
  }
});

// ─── GET /export ──────────────────────────────────────────────────────────────

/**
 * GET /v1/mind/kv/export
 * Export all non-expired entries for the authenticated DID.
 * Values are always returned as AES-256-GCM encrypted blobs.
 */
router.get('/export', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const now = new Date();
    let rawRecords = [];

    if (isPostgresEnabled()) {
      await ensureTable();
      const result = await pool.query(
        'SELECT * FROM hive_memory WHERE did=$1 AND (expires_at IS NULL OR expires_at > $2)',
        [did, now]
      );
      rawRecords = result.rows;
    } else {
      const didStore = _mem.get(did) ?? new Map();
      for (const [k, record] of didStore.entries()) {
        if (record.expires_at && now > new Date(record.expires_at)) continue;
        rawRecords.push({ key: k, ...record });
      }
    }

    const entries = rawRecords.map(r => ({
      key:            r.key,
      // Always export as encrypted blob — re-encrypt if stored as plaintext
      encrypted_blob: r.encrypted
        ? r.value
        : encryptValue(did, JSON.parse(r.value)),
      tags:       r.tags,
      size_bytes: r.size_bytes,
      created_at: r.created_at,
      updated_at: r.updated_at,
      expires_at: r.expires_at ?? null,
    }));

    return res.status(200).json({
      success: true,
      data: {
        did,
        exported_at: now,
        entry_count: entries.length,
        note:        'All entries are AES-256-GCM encrypted. Decryption requires your DID.',
        entries,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to export memory entries.',
      detail:  err.message,
    });
  }
});

// ─── POST /proof ──────────────────────────────────────────────────────────────

/**
 * POST /v1/mind/kv/proof
 * Generate an HMAC-SHA256 proof of existence for an entry.
 *
 * Body: { did?, key, proof_type? }
 * The requesting DID must match body.did when body.did is provided.
 */
router.post('/proof', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const { did: bodyDid, key, proof_type = 'hmac-sha256' } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, error: 'key is required.' });
    }
    if (bodyDid && bodyDid !== did) {
      return res.status(403).json({
        success: false,
        error:   'DID mismatch — body.did must match authenticated DID.',
      });
    }

    const now = new Date();
    let record = null;

    if (isPostgresEnabled()) {
      await ensureTable();
      const result = await pool.query(
        'SELECT updated_at FROM hive_memory WHERE did=$1 AND key=$2 AND (expires_at IS NULL OR expires_at > $3)',
        [did, key, now]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: `Memory key '${key}' not found.`,
        });
      }
      record = result.rows[0];
    } else {
      record = _mem.get(did)?.get(key) ?? null;
      if (!record || (record.expires_at && now > new Date(record.expires_at))) {
        return res.status(404).json({
          success: false,
          error: `Memory key '${key}' not found.`,
        });
      }
    }

    // HMAC-SHA256 proof — mirrors hive-memory SHA-256 proof approach
    const proofInput = `${did}:${key}:${proof_type}:${record.updated_at}`;
    const proofHash  = createHmac('sha256', deriveKey(did))
      .update(proofInput)
      .digest('hex');

    return res.status(200).json({
      success: true,
      data: {
        proof_type,
        did,
        key,
        proof_hash: proofHash,
        verified:   true,
        timestamp:  now,
        aleo_note:  'Phase 1: HMAC proof. Phase 2: Full Aleo ZK proof on HiveZK network.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:   'Failed to generate proof.',
      detail:  err.message,
    });
  }
});

export default router;
