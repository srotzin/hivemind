/**
 * x402 Payment Required Middleware — PRODUCTION VERSION
 * 
 * Verifies payments via:
 * 1. Stripe subscription ID → verified against Stripe API
 * 2. On-chain USDC tx hash → verified against Base L2 via public RPC
 * 3. Internal key bypass (platform-to-platform calls only)
 * 
 * NO dev-mode bypasses. NO passthrough. Every payment is verified.
 */

const HIVE_PAYMENT_ADDRESS = (process.env.HIVE_PAYMENT_ADDRESS || '').toLowerCase();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
// USDC contract on Base L2
const USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/**
 * Verify a Stripe subscription is active.
 */
async function verifyStripeSubscription(subscriptionId) {
  if (!STRIPE_SECRET_KEY || !STRIPE_SECRET_KEY.startsWith('sk_live_')) {
    console.error('[x402] Stripe secret key not configured or not in live mode');
    return { valid: false, reason: 'stripe_not_configured' };
  }

  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { valid: false, reason: 'subscription_not_found' };
    }

    const sub = await res.json();
    if (sub.status === 'active' || sub.status === 'trialing') {
      return {
        valid: true,
        customer: sub.customer,
        plan: sub.items?.data?.[0]?.price?.id,
        status: sub.status,
      };
    }
    return { valid: false, reason: `subscription_status_${sub.status}` };
  } catch (err) {
    console.error('[x402] Stripe verification error:', err.message);
    return { valid: false, reason: 'stripe_error' };
  }
}

/**
 * Verify a USDC transfer on Base L2.
 * Checks that the tx sent >= requiredAmount USDC to HIVE_PAYMENT_ADDRESS.
 */
async function verifyOnChainPayment(txHash, requiredAmountUsdc) {
  if (!HIVE_PAYMENT_ADDRESS) {
    console.error('[x402] HIVE_PAYMENT_ADDRESS not configured');
    return { valid: false, reason: 'payment_address_not_configured' };
  }

  try {
    // Get transaction receipt
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

    // Look for USDC Transfer events in logs
    // Transfer(address,address,uint256) topic = keccak256 of the event signature
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;

      // topics[2] is the recipient (padded to 32 bytes)
      const recipient = '0x' + log.topics[2].slice(26).toLowerCase();
      if (recipient !== HIVE_PAYMENT_ADDRESS) continue;

      // data is the amount (USDC has 6 decimals)
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
 * Production payment middleware.
 * @param {number} priceUsdc - Required payment amount in USDC
 * @param {string} serviceName - Display name for the service
 */
export function requirePayment(priceUsdc, serviceName = 'Hive Service') {
  return async (req, res, next) => {
    // 1. Internal key bypass (platform-to-platform calls)
    const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
    if (HIVE_INTERNAL_KEY && internalKey === HIVE_INTERNAL_KEY) {
      req.paymentVerified = true;
      req.paymentSource = 'internal';
      return next();
    }

    // 2. Stripe subscription verification
    const subscriptionId = req.headers['x-subscription-id'];
    if (subscriptionId) {
      const result = await verifyStripeSubscription(subscriptionId);
      if (result.valid) {
        req.paymentVerified = true;
        req.paymentSource = 'stripe';
        req.subscriptionInfo = result;
        return next();
      }
      return res.status(402).json({
        status: '402 Payment Required',
        error: `Subscription verification failed: ${result.reason}`,
        service: serviceName,
      });
    }

    // 3. On-chain USDC verification
    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    if (paymentHash) {
      const result = await verifyOnChainPayment(paymentHash, priceUsdc);
      if (result.valid) {
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

    // 4. No valid payment — return 402 with instructions
    return res.status(402).json({
      status: '402 Payment Required',
      service: serviceName,
      payment: {
        amount_usdc: priceUsdc,
        currency: 'USDC',
        network: 'Base L2',
        recipient_address: HIVE_PAYMENT_ADDRESS || 'NOT_CONFIGURED',
        supported_methods: ['x402_onchain', 'stripe_subscription'],
      },
      headers_to_include: {
        'X-Payment-Hash': '<USDC transaction hash on Base L2>',
        'X-Subscription-Id': '<Active Stripe subscription ID>',
      },
      x402_flow: {
        step_1: `Send ${priceUsdc} USDC to ${HIVE_PAYMENT_ADDRESS || 'WALLET_ADDRESS'} on Base L2`,
        step_2: 'Include the transaction hash in the X-Payment-Hash header',
        step_3: 'Retry this request with the payment header',
      },
      stripe_flow: {
        step_1: 'Subscribe at https://hivetrustiq.com/subscribe',
        step_2: 'Include subscription ID in X-Subscription-Id header',
      },
    });
  };
}
