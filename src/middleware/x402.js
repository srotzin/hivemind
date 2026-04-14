/**
 * x402 Payment Required Middleware — USDC-ONLY PRODUCTION
 * 
 * Verifies payments via:
 * 1. Internal key bypass (platform-to-platform calls only)
 * 2. On-chain USDC tx hash → verified against Base L2 via public RPC
 * 3. x402 protocol signature (PAYMENT-SIGNATURE header) → facilitator verification
 * 
 * NO Stripe. NO human interfaces. Agents pay in USDC on Base. Period.
 * 
 * Ref: x402 Protocol — https://docs.x402.org
 */

import { pool, isPostgresEnabled } from '../services/db.js';

const HIVE_PAYMENT_ADDRESS = (process.env.HIVE_PAYMENT_ADDRESS || '').toLowerCase();
const HIVEMIND_SERVICE_KEY = process.env.HIVEMIND_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// In-memory fallback for replay protection when PostgreSQL is unavailable
const spentPaymentsMemory = new Set();

// Base L2 constants
const USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BASE_CHAIN_ID = 8453;

// x402 facilitator — xpay (permissionless, gas-sponsored) or CDP (with keys)
// Override with X402_FACILITATOR_URL env var to use CDP: https://api.cdp.coinbase.com/platform/v2/x402
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://facilitator.xpay.sh';

/**
 * Check if a payment tx hash has already been spent.
 */
async function isPaymentSpent(txHash) {
  if (spentPaymentsMemory.has(txHash)) return true;
  if (isPostgresEnabled()) {
    try {
      const result = await pool.query(
        'SELECT 1 FROM public.spent_payments WHERE tx_hash = $1',
        [txHash]
      );
      return result.rows.length > 0;
    } catch {
      // Fall through to memory-only check
    }
  }
  return false;
}

/**
 * Record a payment tx hash as spent.
 */
async function recordSpentPayment(txHash, amountUsdc, endpoint, did) {
  spentPaymentsMemory.add(txHash);
  if (isPostgresEnabled()) {
    try {
      await pool.query(
        `INSERT INTO public.spent_payments (tx_hash, amount_usdc, endpoint, did)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [txHash, amountUsdc, endpoint, did]
      );
    } catch (err) {
      console.error('[x402] Failed to record spent payment:', err.message);
    }
  }
}

/**
 * Verify a USDC transfer on Base L2 via public RPC.
 */
async function verifyOnChainPayment(txHash, requiredAmountUsdc) {
  if (!HIVE_PAYMENT_ADDRESS) {
    console.error('[x402] HIVE_PAYMENT_ADDRESS not configured');
    return { valid: false, reason: 'payment_address_not_configured' };
  }

  try {
    const receiptRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
      signal: AbortSignal.timeout(10000),
    });

    const { result: receipt } = await receiptRes.json();
    if (!receipt || receipt.status !== '0x1') {
      return { valid: false, reason: 'tx_not_found_or_failed' };
    }

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;

      const recipient = '0x' + log.topics[2].slice(26).toLowerCase();
      if (recipient !== HIVE_PAYMENT_ADDRESS) continue;

      const amountRaw = parseInt(log.data, 16);
      const amountUsdc = amountRaw / 1_000_000;

      if (amountUsdc >= requiredAmountUsdc) {
        return {
          valid: true,
          amount_usdc: amountUsdc,
          from: '0x' + log.topics[1].slice(26),
          tx_hash: txHash,
        };
      }
    }

    return { valid: false, reason: 'insufficient_amount_or_wrong_recipient' };
  } catch (err) {
    console.error('[x402] On-chain verification error:', err.message);
    return { valid: false, reason: 'chain_verification_error' };
  }
}

/**
 * Production payment middleware — USDC on Base L2 only.
 * @param {number} priceUsdc - Required payment amount in USDC
 * @param {string} serviceName - Display name for the service
 */
export function requirePayment(priceUsdc, serviceName = 'Hive Service') {
  return async (req, res, next) => {
    // 1. Internal key bypass (platform-to-platform calls)
    const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
    if (HIVEMIND_SERVICE_KEY && internalKey === HIVEMIND_SERVICE_KEY) {
      req.paymentVerified = true;
      req.paymentSource = 'internal';
      return next();
    }

    // 2. On-chain USDC verification (direct tx hash)
    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    if (paymentHash) {
      // Replay protection: reject already-spent tx hashes
      if (await isPaymentSpent(paymentHash)) {
        return res.status(409).json({
          status: '409 Conflict',
          error: 'Payment transaction has already been used',
          tx_hash: paymentHash,
        });
      }

      const result = await verifyOnChainPayment(paymentHash, priceUsdc);
      if (result.valid) {
        // Record spent payment
        await recordSpentPayment(paymentHash, result.amount_usdc, req.originalUrl, req.agentDid);
        req.paymentVerified = true;
        req.paymentSource = 'onchain';
        req.paymentInfo = result;
        return next();
      }
      return res.status(402).json({
        status: '402 Payment Required',
        error: `Payment verification failed: ${result.reason}`,
        service: serviceName,
      });
    }

    // 3. x402 protocol signature (from agents using official x402 SDK)
    const paymentSignature = req.headers['payment-signature'];
    if (paymentSignature) {
      // Forward to facilitator for verification + settlement
      try {
        const verifyRes = await fetch(`${X402_FACILITATOR_URL}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentPayload: paymentSignature,
            paymentRequirements: {
              scheme: 'exact',
              network: `eip155:${BASE_CHAIN_ID}`,
              maxAmountRequired: String(Math.ceil(priceUsdc * 1_000_000)),
              resource: req.originalUrl,
              payTo: HIVE_PAYMENT_ADDRESS,
            },
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (verifyRes.ok) {
          const verification = await verifyRes.json();
          if (verification.valid || verification.isValid) {
            req.paymentVerified = true;
            req.paymentSource = 'x402_facilitator';
            req.paymentInfo = verification;

            // Settle the payment
            fetch(`${X402_FACILITATOR_URL}/settle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                paymentPayload: paymentSignature,
                paymentRequirements: {
                  scheme: 'exact',
                  network: `eip155:${BASE_CHAIN_ID}`,
                  maxAmountRequired: String(Math.ceil(priceUsdc * 1_000_000)),
                  resource: req.originalUrl,
                  payTo: HIVE_PAYMENT_ADDRESS,
                },
              }),
            }).catch(err => console.error('[x402] Settlement error:', err.message));

            return next();
          }
        }
      } catch (err) {
        console.error('[x402] Facilitator verification error:', err.message);
      }

      return res.status(402).json({
        status: '402 Payment Required',
        error: 'Payment signature verification failed',
        service: serviceName,
      });
    }

    // 4. No valid payment — return 402 with x402 protocol-compliant instructions
    const paymentRequired = {
      accepts: [
        {
          scheme: 'exact',
          network: `eip155:${BASE_CHAIN_ID}`,
          maxAmountRequired: String(Math.ceil(priceUsdc * 1_000_000)),
          resource: req.originalUrl,
          description: `${serviceName} — ${priceUsdc} USDC`,
          mimeType: 'application/json',
          payTo: HIVE_PAYMENT_ADDRESS,
          maxTimeoutSeconds: 300,
          asset: `eip155:${BASE_CHAIN_ID}/erc20:${USDC_CONTRACT}`,
        },
      ],
    };

    // Set x402 protocol headers
    res.set({
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      'X-Payment-Amount': priceUsdc.toString(),
      'X-Payment-Currency': 'USDC',
      'X-Payment-Network': 'base',
      'X-Payment-Chain-Id': BASE_CHAIN_ID.toString(),
      'X-Payment-Address': HIVE_PAYMENT_ADDRESS || 'NOT_CONFIGURED',
      'X-Payment-USDC-Contract': USDC_CONTRACT,
    });

    return res.status(402).json({
      status: '402 Payment Required',
      service: serviceName,
      protocol: 'x402',
      payment: {
        amount_usdc: priceUsdc,
        currency: 'USDC',
        network: 'base',
        chain_id: BASE_CHAIN_ID,
        recipient: HIVE_PAYMENT_ADDRESS || 'NOT_CONFIGURED',
        usdc_contract: USDC_CONTRACT,
        accepted_methods: ['x402_signature', 'onchain_tx_hash'],
      },
      how_to_pay: {
        x402_flow: {
          step_1: 'Use an x402-compatible client or wallet (e.g. @x402/fetch)',
          step_2: 'The client will automatically construct and sign a USDC payment',
          step_3: 'Retry with the PAYMENT-SIGNATURE header — settlement is automatic',
        },
        direct_flow: {
          step_1: `Send ${priceUsdc} USDC to ${HIVE_PAYMENT_ADDRESS} on Base (chain ID ${BASE_CHAIN_ID})`,
          step_2: 'Include the transaction hash in the X-Payment-Hash header',
          step_3: 'Retry this request — payment is verified on-chain automatically',
        },
      },
    });
  };
}
