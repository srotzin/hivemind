const HIVE_PAYMENT_ADDRESS = process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

/**
 * x402 Payment Required middleware for monetized endpoints.
 * Checks for payment proof via headers or active subscription.
 *
 * Free endpoints: /health, /.well-known/*, /v1/trifecta/status, /v1/global_hive/browse
 * Paid endpoints: /v1/global_hive/purchase
 */
export function requirePayment(priceUsdc, serviceName = 'HiveMind Service') {
  return (req, res, next) => {
    // Check for payment hash (x402 protocol)
    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    if (paymentHash) {
      // In production: verify on-chain. In dev: accept any non-empty hash.
      req.paymentVerified = true;
      req.paymentHash = paymentHash;
      req.paymentAmount = priceUsdc;
      return next();
    }

    // Check for subscription ID
    const subscriptionId = req.headers['x-subscription-id'];
    if (subscriptionId) {
      // In production: verify with Stripe. In dev: accept any non-empty ID.
      req.subscriptionVerified = true;
      req.subscriptionId = subscriptionId;
      return next();
    }

    // Dev mode: accept internal key
    const internalKey = req.headers['x-hive-internal-key'];
    if (internalKey && internalKey === (process.env.HIVE_INTERNAL_KEY || 'hivemind-dev-key')) {
      req.paymentVerified = true;
      return next();
    }

    // Return 402 Payment Required with payment instructions
    return res.status(402).json({
      status: '402 Payment Required',
      service: serviceName,
      payment: {
        amount_usdc: priceUsdc,
        currency: 'USDC',
        network: 'Base L2',
        recipient_address: HIVE_PAYMENT_ADDRESS,
        supported_methods: ['x402', 'stripe_subscription'],
      },
      headers_to_include: {
        'X-Payment-Hash': '<USDC transaction hash on Base L2>',
        'X-Subscription-Id': '<Active Stripe subscription ID>',
      },
      x402_flow: {
        step_1: `Send ${priceUsdc} USDC to ${HIVE_PAYMENT_ADDRESS} on Base L2`,
        step_2: 'Include the transaction hash in the X-Payment-Hash header',
        step_3: 'Retry this request with the payment header',
      },
      stripe_flow: {
        step_1: 'Subscribe via POST /v1/subscribe (coming soon)',
        step_2: 'Include subscription ID in X-Subscription-Id header',
      },
    });
  };
}
