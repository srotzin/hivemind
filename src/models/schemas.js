import { v4 as uuidv4 } from 'uuid';

/**
 * Create a MemoryNode object.
 */
export function createMemoryNode({
  did,
  tier,
  content,
  semanticTags = [],
  vector = [],
  encryptedPayload = null,
  namespace = null,
}) {
  const now = new Date().toISOString();
  return {
    node_id: `mem_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
    did,
    tier,
    namespace: namespace || null,
    created_at: now,
    last_accessed: now,
    access_count: 0,
    semantic_tags: semanticTags,
    vector_embedding: vector.slice(0, 5).concat(vector.length > 5 ? [`...${vector.length} dimensions`] : []),
    encrypted_payload: encryptedPayload,
    original_content: content,
    monetization_status: 'ineligible',
    market_value_estimate_usdc: 0.00,
  };
}

/**
 * Create a ContextRetrievalObject (query response).
 */
export function createContextRetrieval({
  queryId = null,
  memories = [],
  totalTokens = 0,
  globalHiveOffer = null,
  hiveagentUpsell = null,
}) {
  return {
    query_id: queryId || `req_${uuidv4().replace(/-/g, '').substring(0, 10)}`,
    status: 'success',
    results_found: memories.length,
    total_tokens: totalTokens,
    memories,
    global_hive_offer: globalHiveOffer,
    trifecta_upsell: hiveagentUpsell,
  };
}

/**
 * Create a Trifecta Handshake object (the "I'm Home" 402 response).
 */
export function createTrifectaHandshake(sessionId, hiveTrustUrl) {
  return {
    status: '402 Payment Required',
    message: 'Memory storage requires a verified HiveTrust DID.',
    trifecta_handshake: {
      temporary_session_id: sessionId,
      hivetrust_registration_url: `${hiveTrustUrl}/v1/register?session=${sessionId}`,
      hiveagent_pre_approval: true,
      cost_usdc: 0.00,
      action_required: 'Follow the registration URL to finalize your DID and unlock the full Hive Constellation. Registration is free.',
    },
  };
}

/**
 * Create a GlobalHiveNode (published to the public knowledge exchange).
 */
export function createGlobalHiveNode({
  nodeId,
  authorDid,
  semanticTags = [],
  vector = [],
  encryptedPayload = null,
  priceUsdc = 0.05,
  category = 'general',
}) {
  const now = new Date().toISOString();
  return {
    node_id: nodeId,
    author_did: authorDid,
    published_at: now,
    semantic_tags: semanticTags,
    category,
    vector_embedding_preview: vector.slice(0, 3),
    encrypted_payload: encryptedPayload,
    price_usdc: priceUsdc,
    total_purchases: 0,
    total_revenue_usdc: 0.00,
    author_earnings_usdc: 0.00,
    platform_fee_usdc: 0.00,
    reputation_boost: 0,
  };
}

/**
 * Create a Transaction record.
 */
export function createTransaction({
  buyerDid,
  sellerDid,
  nodeId,
  amountUsdc,
  type = 'knowledge_purchase',
}) {
  const platformFee = +(amountUsdc * 0.10).toFixed(4);
  const authorPayout = +(amountUsdc - platformFee).toFixed(4);
  return {
    transaction_id: `txn_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
    type,
    buyer_did: buyerDid,
    seller_did: sellerDid,
    node_id: nodeId,
    amount_usdc: amountUsdc,
    platform_fee_usdc: platformFee,
    author_payout_usdc: authorPayout,
    fee_split: '90% author / 10% platform',
    status: 'completed',
    settled_at: new Date().toISOString(),
    settlement_method: 'zero-treasury',
  };
}
