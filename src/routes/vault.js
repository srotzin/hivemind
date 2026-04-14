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

const router = Router();

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

    return res.status(201).json({
      success: true,
      data: {
        receipt_id: receipt.receipt_id,
        receipt_hash: receipt.receipt_hash,
        compliance_certificate_id: receipt.compliance_cert_id,
        stored_at: receipt.stored_at,
      },
      meta: {
        cost_usdc: 0.05,
        note: 'Receipt stored immutably. Compliance certificate issuance is in progress.',
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
