/**
 * Receipt Vault Service — Immutable Transaction Receipt Store
 *
 * Stores cryptographic receipts of every transaction in the Hive ecosystem.
 * Each receipt gets a SHA-256 hash chain and an auto-issued compliance certificate
 * from HiveLaw.
 *
 * Functions: storeReceipt(), getReceipt(), getReceiptsByDid(), verifyReceipt(), getVaultStats()
 */

import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { pool, isPostgresEnabled } from './db.js';

const HIVELAW_URL = process.env.HIVELAW_URL || 'https://hivelaw.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';

// In-memory fallback store
const memoryVault = new Map();

// Self-healing table creation — ensures receipt_vault exists on first use
let tableEnsured = false;
async function ensureVaultTable() {
  if (tableEnsured || !isPostgresEnabled() || !pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS receipt_vault (
        receipt_id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        source_service TEXT NOT NULL,
        amount_usdc NUMERIC(12,4) NOT NULL,
        payer_did TEXT NOT NULL,
        payee_did TEXT,
        endpoint TEXT,
        payload_hash TEXT,
        receipt_hash TEXT NOT NULL,
        compliance_cert_id TEXT,
        metadata JSONB DEFAULT '{}',
        stored_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vault_payer ON receipt_vault(payer_did)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vault_payee ON receipt_vault(payee_did)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vault_service ON receipt_vault(source_service)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vault_stored ON receipt_vault(stored_at)');
    tableEnsured = true;
    console.log('[Receipt Vault] Table ensured');
  } catch (err) {
    console.error('[Receipt Vault] Failed to ensure table:', err.message);
  }
}
/**
 * Generate a SHA-256 receipt hash chaining key transaction fields.
 */
function generateReceiptHash(txId, amount, payerDid, payeeDid, timestamp, payloadHash) {
  const input = `${txId}${amount}${payerDid}${payeeDid || ''}${timestamp}${payloadHash || ''}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Fire-and-forget call to HiveLaw for a compliance certificate.
 * Returns the compliance_cert_id if successful, null otherwise.
 */
async function requestComplianceCert(receipt) {
  try {
    const res = await fetch(`${HIVELAW_URL}/v1/compliance/issue-compliance-stamp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
        'Authorization': `Bearer ${receipt.payer_did}`,
      },
      body: JSON.stringify({
        agent_did: receipt.payer_did,
        output_type: 'financial_transaction',
        output_content: `Transaction receipt: ${receipt.transaction_id} for ${receipt.amount_usdc} USDC from ${receipt.payer_did} to ${receipt.payee_did || 'N/A'}`,
        domain: 'finance',
        risk_context: {
          transaction_type: 'receipt_vault',
          amount_usdc: receipt.amount_usdc,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      return data.data?.stamp_id || data.data?.certificate_id || data.stamp_id || null;
    }
  } catch (err) {
    console.error('[receipt-vault] HiveLaw compliance call failed:', err.message);
  }
  return null;
}

/**
 * Store a cryptographic receipt.
 */
export async function storeReceipt({ transaction_id, source_service, amount_usdc, payer_did, payee_did, endpoint, payload_hash, metadata }) {
  await ensureVaultTable();
  const receipt_id = `rcpt_${uuidv4().replace(/-/g, '')}`;
  const stored_at = new Date().toISOString();
  const receipt_hash = generateReceiptHash(transaction_id, amount_usdc, payer_did, payee_did, stored_at, payload_hash);

  const receipt = {
    receipt_id,
    transaction_id,
    source_service,
    amount_usdc,
    payer_did,
    payee_did: payee_did || null,
    endpoint: endpoint || null,
    payload_hash: payload_hash || null,
    receipt_hash,
    compliance_cert_id: null,
    metadata: metadata || {},
    stored_at,
  };

  // Store in PostgreSQL or memory
  if (isPostgresEnabled()) {
    await pool.query(
      `INSERT INTO receipt_vault (receipt_id, transaction_id, source_service, amount_usdc, payer_did, payee_did, endpoint, payload_hash, receipt_hash, compliance_cert_id, metadata, stored_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [receipt.receipt_id, receipt.transaction_id, receipt.source_service, receipt.amount_usdc, receipt.payer_did, receipt.payee_did, receipt.endpoint, receipt.payload_hash, receipt.receipt_hash, receipt.compliance_cert_id, JSON.stringify(receipt.metadata), receipt.stored_at]
    );
  } else {
    memoryVault.set(receipt_id, receipt);
  }

  // Fire-and-forget: request compliance certificate from HiveLaw
  requestComplianceCert(receipt).then(async (certId) => {
    if (certId) {
      receipt.compliance_cert_id = certId;
      if (isPostgresEnabled()) {
        await pool.query(
          'UPDATE receipt_vault SET compliance_cert_id = $1 WHERE receipt_id = $2',
          [certId, receipt_id]
        ).catch(err => console.error('[receipt-vault] Failed to update compliance cert:', err.message));
      } else {
        const stored = memoryVault.get(receipt_id);
        if (stored) stored.compliance_cert_id = certId;
      }
    }
  });

  return receipt;
}

/**
 * Retrieve a single receipt by ID.
 */
export async function getReceipt(receiptId) {
  await ensureVaultTable();
  if (isPostgresEnabled()) {
    const result = await pool.query('SELECT * FROM receipt_vault WHERE receipt_id = $1', [receiptId]);
    return result.rows[0] || null;
  }
  return memoryVault.get(receiptId) || null;
}

/**
 * List all receipts for a given DID (as payer or payee).
 */
export async function getReceiptsByDid(did, { limit = 50, offset = 0, since, service } = {}) {
  await ensureVaultTable();
  await ensureVaultTable();
  if (isPostgresEnabled()) {
    let query = 'SELECT * FROM receipt_vault WHERE (payer_did = $1 OR payee_did = $1)';
    const params = [did];
    let paramIdx = 2;

    if (since) {
      query += ` AND stored_at >= $${paramIdx}`;
      params.push(since);
      paramIdx++;
    }
    if (service) {
      query += ` AND source_service = $${paramIdx}`;
      params.push(service);
      paramIdx++;
    }

    query += ` ORDER BY stored_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
  }

  // In-memory fallback
  let receipts = Array.from(memoryVault.values())
    .filter(r => r.payer_did === did || r.payee_did === did);

  if (since) {
    const sinceDate = new Date(since);
    receipts = receipts.filter(r => new Date(r.stored_at) >= sinceDate);
  }
  if (service) {
    receipts = receipts.filter(r => r.source_service === service);
  }

  receipts.sort((a, b) => new Date(b.stored_at) - new Date(a.stored_at));
  return receipts.slice(offset, offset + limit);
}

/**
 * Verify a receipt hash against stored data.
 */
export async function verifyReceipt(receiptId, claimedHash) {
  await ensureVaultTable();
  const receipt = await getReceipt(receiptId);
  if (!receipt) {
    return { verified: false, reason: 'receipt_not_found' };
  }

  const verified = receipt.receipt_hash === claimedHash;
  return {
    verified,
    receipt_data: verified ? receipt : undefined,
    reason: verified ? 'hash_match' : 'hash_mismatch',
  };
}

/**
 * Get vault-wide statistics.
 */
export async function getVaultStats() {
  await ensureVaultTable();
  if (isPostgresEnabled()) {
    const [totalResult, usdcResult, didsResult, serviceResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM receipt_vault'),
      pool.query('SELECT COALESCE(SUM(amount_usdc), 0) as total_usdc FROM receipt_vault'),
      pool.query('SELECT COUNT(DISTINCT payer_did) as unique_payers, COUNT(DISTINCT payee_did) as unique_payees FROM receipt_vault'),
      pool.query('SELECT source_service, COUNT(*) as count FROM receipt_vault GROUP BY source_service ORDER BY count DESC'),
    ]);

    return {
      total_receipts: parseInt(totalResult.rows[0].total),
      total_usdc_transacted: parseFloat(usdcResult.rows[0].total_usdc),
      unique_dids: parseInt(didsResult.rows[0].unique_payers) + parseInt(didsResult.rows[0].unique_payees),
      unique_payers: parseInt(didsResult.rows[0].unique_payers),
      unique_payees: parseInt(didsResult.rows[0].unique_payees),
      receipts_by_service: serviceResult.rows.reduce((acc, row) => {
        acc[row.source_service] = parseInt(row.count);
        return acc;
      }, {}),
    };
  }

  // In-memory fallback
  const receipts = Array.from(memoryVault.values());
  const payers = new Set(receipts.map(r => r.payer_did));
  const payees = new Set(receipts.filter(r => r.payee_did).map(r => r.payee_did));
  const byService = {};
  for (const r of receipts) {
    byService[r.source_service] = (byService[r.source_service] || 0) + 1;
  }

  return {
    total_receipts: receipts.length,
    total_usdc_transacted: receipts.reduce((sum, r) => sum + parseFloat(r.amount_usdc), 0),
    unique_dids: new Set([...payers, ...payees]).size,
    unique_payers: payers.size,
    unique_payees: payees.size,
    receipts_by_service: byService,
  };
}
