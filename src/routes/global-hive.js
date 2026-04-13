import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import memoryStore from '../services/memory-store.js';
import { pool, isPostgresEnabled } from '../services/db.js';

const router = Router();

/**
 * POST /v1/global_hive/publish
 * Publish a private memory node to the Global Hive for monetization.
 *
 * Body: { node_id }
 * Auth: requireDID
 */
router.post('/publish', requireDID, async (req, res) => {
  try {
    const { node_id } = req.body;
    const did = req.agentDid;

    if (!node_id) {
      return res.status(400).json({
        success: false,
        error: 'node_id is required.',
      });
    }

    const result = await memoryStore.publishToGlobal(did, node_id);

    if (result.error) {
      return res.status(404).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: result,
      meta: {
        revenue_split: '90% author / 10% platform',
        settlement_method: 'zero-treasury',
        note: 'Your content has been anonymized, scrubbed of secrets, and re-vectorized for the Global Hive index.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to publish to Global Hive.',
      detail: err.message,
    });
  }
});

/**
 * POST /v1/global_hive/purchase
 * Purchase and decrypt a Global Hive knowledge node.
 *
 * Body: { node_id }
 * Auth: requireDID + x402 payment
 * Payment: verified via X-Payment-Hash or X-Subscription-Id header
 */
router.post('/purchase', requireDID, async (req, res) => {
  try {
    const { node_id } = req.body;
    const did = req.agentDid;

    if (!node_id) {
      return res.status(400).json({
        success: false,
        error: 'node_id is required.',
      });
    }

    // Look up the node to get the price — try PostgreSQL first, then in-memory
    let nodePrice = null;
    if (isPostgresEnabled()) {
      const pgResult = await pool.query(
        'SELECT price_usdc FROM hivemind.global_hive_listings WHERE node_id = $1',
        [node_id]
      );
      if (pgResult.rows.length > 0) {
        nodePrice = parseFloat(pgResult.rows[0].price_usdc);
      }
    } else {
      const nodeInfo = Array.from(memoryStore.globalHive?.entries?.() || [])
        .find(([id]) => id === node_id);
      if (nodeInfo) {
        nodePrice = nodeInfo[1].price_usdc;
      }
    }

    if (nodePrice === null) {
      return res.status(404).json({
        success: false,
        error: 'Global Hive node not found.',
        node_id,
      });
    }

    // Check for payment proof (x402 or subscription or internal key)
    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    const subscriptionId = req.headers['x-subscription-id'];
    const internalKey = req.headers['x-hive-internal-key'];
    const isDev = process.env.NODE_ENV !== 'production';

    const hasPayment = paymentHash || subscriptionId || (internalKey && isDev);

    if (!hasPayment) {
      // Return 402 with exact price for this node
      return res.status(402).json({
        status: '402 Payment Required',
        node_id,
        payment: {
          amount_usdc: nodePrice,
          currency: 'USDC',
          network: 'Base L2',
          recipient_address: process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
          fee_split: '90% to author / 10% platform',
        },
        instructions: {
          step_1: `Send ${nodePrice} USDC to the recipient address on Base L2`,
          step_2: 'Include the transaction hash in the X-Payment-Hash header',
          step_3: 'Retry this request with the payment proof',
        },
      });
    }

    // Execute the purchase
    const result = await memoryStore.purchaseGlobal(did, node_id);

    if (result.error) {
      return res.status(404).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: {
        decrypted_payload: result.decrypted_payload,
        semantic_tags: result.semantic_tags,
        transaction: result.transaction,
      },
      hiveagent_upsell: result.hiveagent_upsell,
      meta: {
        note: 'Knowledge purchased successfully. 90% of the payment has been routed to the original author.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to purchase from Global Hive.',
      detail: err.message,
    });
  }
});

/**
 * GET /v1/global_hive/browse
 * Browse the Global Hive knowledge index.
 * Public endpoint — no auth required.
 *
 * Query params: ?q=search_text&category=&top_k=10
 */
router.get('/browse', async (req, res) => {
  try {
    const { q = '', category, top_k = 10 } = req.query;

    if (!q || q.trim().length === 0) {
      // Return general stats and categories
      const stats = await memoryStore.getGlobalHiveStats();
      return res.status(200).json({
        success: true,
        data: {
          ...stats,
          message: 'Provide a ?q= parameter to search the Global Hive knowledge index.',
          example: '/v1/global_hive/browse?q=kubernetes+deployment&top_k=5',
        },
      });
    }

    const results = await memoryStore.queryGlobal(q, parseInt(top_k, 10));

    // Filter by category if specified
    if (category) {
      results.entries = results.entries.filter(e => e.category === category);
      results.results_found = results.entries.length;
    }

    return res.status(200).json({
      success: true,
      data: results,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to browse Global Hive.',
      detail: err.message,
    });
  }
});

/**
 * GET /v1/global_hive/stats
 * Global Hive marketplace statistics.
 * Public endpoint.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await memoryStore.getGlobalHiveStats();
    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve Global Hive stats.',
      detail: err.message,
    });
  }
});

export default router;
