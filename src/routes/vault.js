/**
 * Receipt Vault Routes — Immutable Transaction Receipt Store
 *
 * Every transaction in the Hive ecosystem gets an immutable receipt
 * plus an auto-issued compliance certificate from HiveLaw.
 *
 * Endpoints:
 *   POST /store-receipt  — Store a cryptographic receipt ($0.05 USDC)
 *   GET  /receipt/:id    — Retrieve a receipt by ID (free)
 *   GET  /receipts/:did  — List receipts for a DID (free)
 *   POST /verify         — Verify a receipt hash (free)
 *   GET  /stats          — Vault statistics (free)
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import {
  storeReceipt,
  getReceipt,
  getReceiptsByDid,
  verifyReceipt,
  getVaultStats,
} from '../services/receipt-vault.js';
import { emitSpectralReceipt } from '../services/spectral-receipt.js';

const router = Router();

// ─── BOGO Loyalty — every 6th receipt free per DID ─────────────────
// In-memory counter; persistent in PostgreSQL when available
const didReceiptCount = new Map();
const HIVECLEAR_URL = process.env.HIVECLEAR_URL || 'https://hiveclear.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';

async function getReceiptCountForDid(did) {
  if (didReceiptCount.has(did)) return didReceiptCount.get(did);
  // seed from DB if available
  try {
    const { pool, isPostgresEnabled } = await import('../services/db.js');
    if (isPostgresEnabled()) {
      const result = await pool.query(
        `SELECT COUNT(*) AS cnt FROM receipt_vault WHERE payer_did = $1`,
        [did]
      );
      const count = parseInt(result.rows[0]?.cnt || '0', 10);
      didReceiptCount.set(did, count);
      return count;
    }
  } catch { /* fall through */ }
  didReceiptCount.set(did, 0);
  return 0;
}

function incrementReceiptCount(did) {
  const current = didReceiptCount.get(did) || 0;
  didReceiptCount.set(did, current + 1);
  return current + 1;
}

/**
 * Fire-and-forget BOGO chain notification to hiveclear.
 * Loyalty: every 6th receipt from the same DID triggers a free-credit event.
 */
function notifyHiveclearLoyalty(payerDid, receiptId, receiptCount) {
  fetch(`${HIVECLEAR_URL}/v1/loyalty/credit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hive-Internal-Key': HIVE_INTERNAL_KEY,
    },
    body: JSON.stringify({
      did: payerDid,
      source_service: 'hivemind-receipt-vault',
      trigger_receipt_id: receiptId,
      receipt_count: receiptCount,
      loyalty_event: 'every_6th_receipt_free',
      next_free_at: receiptCount + (6 - (receiptCount % 6)),
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(4000),
  }).catch(err => {
    console.error('[vault] BOGO hiveclear notification failed (non-blocking):', err.message);
  });
}

// ─── POST /store-receipt ────────────────────────────────────────────

router.post('/store-receipt', requireDID, requirePayment(0.05, 'Receipt Vault Storage'), async (req, res) => {
  try {
    const { transaction_id, source_service, amount_usdc, payer_did, payee_did, endpoint, payload_hash, metadata } = req.body;

    if (!transaction_id || !source_service || amount_usdc === undefined || !payer_did) {
      return res.status(400).json({
        success: false,
        error: 'transaction_id, source_service, amount_usdc, and payer_did are required.',
      });
    }

    if (typeof amount_usdc !== 'number' || amount_usdc < 0) {
      return res.status(400).json({
        success: false,
        error: 'amount_usdc must be a non-negative number.',
      });
    }

    const receipt = await storeReceipt({
      transaction_id,
      source_service,
      amount_usdc,
      payer_did,
      payee_did,
      endpoint,
      payload_hash,
      metadata,
    });

    // Spectral receipt emission (fire-and-forget)
    emitSpectralReceipt({
      issuer_did: 'did:hive:hivemind',
      event_type: 'receipt_vault_store',
      amount_usd: 0.05,
      payer_did,
      metadata: {
        receipt_id: receipt.receipt_id,
        receipt_hash: receipt.receipt_hash,
        source_service,
        amount_usdc,
      },
    });

    // BOGO loyalty chain: Receipt Vault → hive-receipt → hiveclear
    // Every 6th receipt from the same DID is free (loyalty credit)
    const prevCount = await getReceiptCountForDid(payer_did);
    const newCount = incrementReceiptCount(payer_did);
    const isLoyaltyEvent = newCount % 6 === 0;
    if (isLoyaltyEvent) {
      notifyHiveclearLoyalty(payer_did, receipt.receipt_id, newCount);
    }

    return res.status(201).json({
      success: true,
      data: {
        receipt_id: receipt.receipt_id,
        receipt_hash: receipt.receipt_hash,
        compliance_certificate_id: receipt.compliance_cert_id,
        stored_at: receipt.stored_at,
        spectral_receipt_emitted: true,
      },
      meta: {
        cost_usdc: 0.05,
        note: 'Receipt stored immutably. Compliance certificate issuance is in progress.',
        loyalty: {
          receipts_stored_this_did: newCount,
          next_free_receipt_at: newCount + (6 - (newCount % 6)),
          loyalty_event_triggered: isLoyaltyEvent,
          message: isLoyaltyEvent
            ? '🎉 Loyalty milestone: this was your 6th receipt — a free credit has been queued via hiveclear.'
            : `Your next free receipt is in ${6 - (newCount % 6)} receipt(s). Every 6th receipt is on the house.`,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to store receipt.',
      detail: err.message,
    });
  }
});

// ─── GET /receipt/:receipt_id ───────────────────────────────────────

router.get('/receipt/:receipt_id', requireDID, async (req, res) => {
  try {
    const receipt = await getReceipt(req.params.receipt_id);

    if (!receipt) {
      return res.status(404).json({
        success: false,
        error: `Receipt ${req.params.receipt_id} not found.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: receipt,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve receipt.',
      detail: err.message,
    });
  }
});

// ─── GET /receipts/:did ─────────────────────────────────────────────

router.get('/receipts/:did', requireDID, async (req, res) => {
  try {
    const { did } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const since = req.query.since || undefined;
    const service = req.query.service || undefined;

    const receipts = await getReceiptsByDid(did, { limit, offset, since, service });

    return res.status(200).json({
      success: true,
      data: {
        receipts,
        total_returned: receipts.length,
        query: { did, limit, offset, since, service },
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to list receipts.',
      detail: err.message,
    });
  }
});

// ─── POST /verify ───────────────────────────────────────────────────

router.post('/verify', requireDID, async (req, res) => {
  try {
    const { receipt_id, claimed_hash } = req.body;

    if (!receipt_id || !claimed_hash) {
      return res.status(400).json({
        success: false,
        error: 'receipt_id and claimed_hash are required.',
      });
    }

    const result = await verifyReceipt(receipt_id, claimed_hash);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Verification failed.',
      detail: err.message,
    });
  }
});

// ─── GET /stats ─────────────────────────────────────────────────────

router.get('/stats', requireDID, async (req, res) => {
  try {
    const stats = await getVaultStats();

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to get vault statistics.',
      detail: err.message,
    });
  }
});

export default router;
