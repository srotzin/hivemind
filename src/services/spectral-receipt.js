/**
 * Spectral Receipt Emitter — hive-receipt service integration
 *
 * Emits a Spectral-signed receipt to the hive-receipt service on every
 * fee event across hivemind's three paid surfaces:
 *   - Receipt Vault  ($0.05/receipt)
 *   - Clearinghouse  ($0.01–$0.05/op)
 *   - Subscription   ($25/$99/$200/mo)
 *
 * Fire-and-forget: never blocks the fee path. AbortSignal.timeout(4000)
 * matches the Wave B pattern established across all 18 MCP shims.
 *
 * Treasury: Monroe W1 — 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 */

const HIVE_RECEIPT_URL = process.env.HIVE_RECEIPT_URL || 'https://hive-receipt.onrender.com';
const TREASURY = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';

/**
 * Emit a Spectral receipt to hive-receipt.
 * Non-blocking — any network error is logged and swallowed.
 *
 * @param {object} opts
 * @param {string} opts.issuer_did     - DID of the hivemind service node
 * @param {string} opts.event_type     - e.g. 'receipt_vault_store', 'clearinghouse_translate', 'subscription_create'
 * @param {number} opts.amount_usd     - Fee amount in USD
 * @param {string} [opts.payer_did]    - DID of the paying agent (if known)
 * @param {object} [opts.metadata]     - Extra context fields
 */
export function emitSpectralReceipt({ issuer_did, event_type, amount_usd, payer_did, metadata = {} }) {
  const payload = {
    issuer_did: issuer_did || 'did:hive:hivemind',
    event_type,
    amount_usd,
    currency: 'USDC',
    network: 'base',
    pay_to: TREASURY,
    payer_did: payer_did || undefined,
    timestamp: new Date().toISOString(),
    metadata,
    brand: '#C08D23',
  };

  fetch(`${HIVE_RECEIPT_URL}/v1/receipt/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000),
  }).catch(err => {
    console.error('[spectral-receipt] Emission failed (non-blocking):', err.message);
  });
}
