/**
 * Subscription Tiers — hivemind collective intelligence layer
 *
 * POST /v1/subscription         — create or upgrade subscription (x402 gated)
 * GET  /v1/subscription/:did    — status check (free)
 * POST /v1/subscription/verify  — lightweight auth check (free)
 *
 * Tiers:
 *   Starter    $25/mo  — Unlimited receipt vault + 1,000 clears/mo
 *   Pro        $99/mo  — Unlimited receipt vault + 10,000 clears/mo + priority routing
 *   Enterprise $200/mo — Unlimited all surfaces + extended retention + audit attestation + SLA
 *
 * x402 pattern matches Wave B MCP-shim pattern (Bloomberg/Stripe Docs voice).
 * Spectral receipt emitted on every successful subscription.
 * Treasury: Monroe W1 — 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { emitSpectralReceipt } from '../services/spectral-receipt.js';
import { pool, isPostgresEnabled } from '../services/db.js';

const router = Router();

const TREASURY = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;

const TIERS = {
  starter: {
    price_usd: 25,
    name: 'Starter',
    receipt_vault: 'unlimited',
    clearinghouse_ops_mo: 1000,
    knowledge_queries_mo: 'unlimited',
    retention_days: 90,
    audit_attestation: false,
    sla: '99.5%',
    description: 'Unlimited receipt vault + 1,000 clearinghouse ops/mo',
  },
  pro: {
    price_usd: 99,
    name: 'Pro',
    receipt_vault: 'unlimited',
    clearinghouse_ops_mo: 10000,
    knowledge_queries_mo: 'unlimited',
    retention_days: 180,
    audit_attestation: false,
    sla: '99.9%',
    description: 'Unlimited receipt vault + 10,000 clearinghouse ops/mo + priority routing',
  },
  enterprise: {
    price_usd: 200,
    name: 'Enterprise',
    receipt_vault: 'unlimited',
    clearinghouse_ops_mo: 'unlimited',
    knowledge_queries_mo: 'unlimited',
    retention_days: 365,
    audit_attestation: true,
    sla: '99.99%',
    description: 'Unlimited all surfaces + extended retention + HiveLaw audit attestation + SLA',
  },
};

// In-memory subscription store (PostgreSQL when enabled)
const memorySubscriptions = new Map();

// ─── Self-healing table ─────────────────────────────────────────────
let tableEnsured = false;
async function ensureSubTable() {
  if (tableEnsured || !isPostgresEnabled()) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hivemind_subscriptions (
        sub_id        TEXT PRIMARY KEY,
        did           TEXT NOT NULL,
        tier          TEXT NOT NULL,
        price_usd     NUMERIC(10,2) NOT NULL,
        tx_hash       TEXT,
        activated_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_ms    BIGINT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sub_did ON hivemind_subscriptions(did)');
    tableEnsured = true;
    console.log('[subscription] Table ensured');
  } catch (err) {
    console.error('[subscription] Failed to ensure table:', err.message);
  }
}

async function getActiveSub(did) {
  await ensureSubTable();
  const now = Date.now();
  if (isPostgresEnabled()) {
    try {
      const result = await pool.query(
        `SELECT * FROM hivemind_subscriptions WHERE did = $1 AND expires_ms > $2 ORDER BY expires_ms DESC LIMIT 1`,
        [did, now]
      );
      return result.rows[0] || null;
    } catch { /* fall through */ }
  }
  const subs = Array.from(memorySubscriptions.values())
    .filter(s => s.did === did && s.expires_ms > now)
    .sort((a, b) => b.expires_ms - a.expires_ms);
  return subs[0] || null;
}

async function saveSub(sub) {
  await ensureSubTable();
  memorySubscriptions.set(sub.sub_id, sub);
  if (isPostgresEnabled()) {
    try {
      await pool.query(
        `INSERT INTO hivemind_subscriptions (sub_id, did, tier, price_usd, tx_hash, expires_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sub_id) DO UPDATE SET tier=$3, price_usd=$4, tx_hash=$5, expires_ms=$6`,
        [sub.sub_id, sub.did, sub.tier, sub.price_usd, sub.tx_hash, sub.expires_ms]
      );
    } catch (err) {
      console.error('[subscription] Failed to persist:', err.message);
    }
  }
}

// ─── POST /v1/subscription ──────────────────────────────────────────
router.post('/', async (req, res) => {
  const { tier, did, tx_hash } = req.body;
  const agentDid = did || req.headers['x-hivetrust-did'] || req.headers['x-hive-did'];

  if (!tier || !TIERS[tier]) {
    return res.status(400).json({
      success: false,
      error: 'tier is required. Valid values: starter, pro, enterprise.',
      available_tiers: Object.fromEntries(
        Object.entries(TIERS).map(([k, v]) => [k, { price_usd: v.price_usd, description: v.description }])
      ),
    });
  }

  if (!agentDid) {
    return res.status(400).json({
      success: false,
      error: 'did is required (body.did or x-hive-did header).',
    });
  }

  const tierDef = TIERS[tier];

  // Enterprise — invoice-billing model (no tx_hash required)
  if (tier === 'enterprise') {
    const sub_id = `sub_${uuidv4().replace(/-/g, '')}`;
    const expires_ms = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const sub = {
      sub_id, did: agentDid, tier, price_usd: tierDef.price_usd,
      tx_hash: tx_hash || 'enterprise_invoice', expires_ms,
      activated_at: new Date().toISOString(),
    };
    await saveSub(sub);
    emitSpectralReceipt({
      issuer_did: 'did:hive:hivemind',
      event_type: 'subscription_create',
      amount_usd: tierDef.price_usd,
      payer_did: agentDid,
      metadata: { tier, sub_id, billing_model: 'enterprise_invoice' },
    });
    return res.status(200).json({
      success: true,
      data: {
        sub_id, tier, tier_details: tierDef,
        did: agentDid,
        activated_at: sub.activated_at,
        expires_ms,
        expires_at: new Date(expires_ms).toISOString(),
        receipt_emitted: true,
      },
      meta: {
        price_usd: tierDef.price_usd,
        billing_model: 'enterprise_invoice',
        treasury: TREASURY,
        brand: '#C08D23',
        partner_attribution: 'Complements HiveLaw, hiveclear. Audit attestation layer — never a clearing or legal service.',
      },
    });
  }

  // Starter / Pro — require tx_hash payment OR return x402 envelope
  if (!tx_hash) {
    const priceUsdc = tierDef.price_usd;
    const paymentRequired = {
      accepts: [
        {
          scheme: 'exact',
          network: `eip155:${BASE_CHAIN_ID}`,
          maxAmountRequired: String(Math.ceil(priceUsdc * 1_000_000)),
          resource: '/v1/subscription',
          description: `hivemind ${tierDef.name} subscription — ${priceUsdc} USDC/mo`,
          mimeType: 'application/json',
          payTo: TREASURY,
          maxTimeoutSeconds: 300,
          asset: `eip155:${BASE_CHAIN_ID}/erc20:${USDC_CONTRACT}`,
        },
      ],
    };
    res.set({
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      'X-Payment-Amount': priceUsdc.toString(),
      'X-Payment-Currency': 'USDC',
      'X-Payment-Network': 'base',
      'X-Payment-Chain-Id': BASE_CHAIN_ID.toString(),
      'X-Payment-Address': TREASURY,
    });
    return res.status(402).json({
      status: '402 Payment Required',
      service: 'hivemind',
      protocol: 'x402',
      tier,
      tier_details: tierDef,
      payment: {
        amount_usdc: priceUsdc,
        currency: 'USDC',
        network: 'base',
        chain_id: BASE_CHAIN_ID,
        recipient: TREASURY,
        usdc_contract: USDC_CONTRACT,
        accepted_methods: ['x402_signature', 'onchain_tx_hash'],
      },
      x402: {
        type: 'x402',
        version: '1',
        kind: `subscription_hivemind_${tier}`,
        asking_usd: priceUsdc,
        asset: 'USDC',
        asset_address: USDC_CONTRACT,
        network: 'base',
        pay_to: TREASURY,
        bogo: { first_call_free: true, loyalty_every_n: 6 },
      },
      how_to_pay: {
        step_1: `Send ${priceUsdc} USDC to ${TREASURY} on Base (chain ID ${BASE_CHAIN_ID})`,
        step_2: 'Include the transaction hash as body.tx_hash',
        step_3: 'Retry POST /v1/subscription — subscription activates immediately',
      },
      available_tiers: Object.fromEntries(
        Object.entries(TIERS).map(([k, v]) => [k, { price_usd: v.price_usd, description: v.description }])
      ),
    });
  }

  // tx_hash provided — activate subscription
  const sub_id = `sub_${uuidv4().replace(/-/g, '')}`;
  const expires_ms = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const sub = {
    sub_id, did: agentDid, tier, price_usd: tierDef.price_usd,
    tx_hash, expires_ms,
    activated_at: new Date().toISOString(),
  };
  await saveSub(sub);
  emitSpectralReceipt({
    issuer_did: 'did:hive:hivemind',
    event_type: 'subscription_create',
    amount_usd: tierDef.price_usd,
    payer_did: agentDid,
    metadata: { tier, sub_id, tx_hash },
  });

  return res.status(201).json({
    success: true,
    data: {
      sub_id, tier, tier_details: tierDef,
      did: agentDid,
      tx_hash,
      activated_at: sub.activated_at,
      expires_ms,
      expires_at: new Date(expires_ms).toISOString(),
      receipt_emitted: true,
    },
    meta: {
      price_usd: tierDef.price_usd,
      treasury: TREASURY,
      brand: '#C08D23',
      partner_attribution: 'Complements HiveLaw, hiveclear. Never a clearing or legal service.',
    },
  });
});

// ─── GET /v1/subscription/:did ──────────────────────────────────────
router.get('/:did', async (req, res) => {
  const sub = await getActiveSub(req.params.did);
  if (!sub) {
    return res.status(404).json({
      success: false,
      error: 'No active subscription found.',
      did: req.params.did,
      subscribe_at: 'POST /v1/subscription',
      available_tiers: Object.fromEntries(
        Object.entries(TIERS).map(([k, v]) => [k, { price_usd: v.price_usd, description: v.description }])
      ),
    });
  }
  const tierDef = TIERS[sub.tier] || {};
  return res.status(200).json({
    success: true,
    data: {
      sub_id: sub.sub_id,
      did: sub.did,
      tier: sub.tier,
      tier_details: tierDef,
      price_usd: sub.price_usd,
      activated_at: sub.activated_at,
      expires_ms: sub.expires_ms,
      expires_at: new Date(sub.expires_ms).toISOString(),
      active: true,
    },
  });
});

// ─── POST /v1/subscription/verify ───────────────────────────────────
router.post('/verify', async (req, res) => {
  const did = req.body?.did || req.headers['x-hive-did'] || req.headers['x-hivetrust-did'];
  if (!did) {
    return res.status(400).json({ success: false, error: 'did is required.' });
  }
  const sub = await getActiveSub(did);
  return res.status(200).json({
    success: true,
    data: {
      did,
      has_active_subscription: !!sub,
      tier: sub?.tier || null,
      expires_ms: sub?.expires_ms || null,
    },
  });
});

export default router;
