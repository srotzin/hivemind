import { v4 as uuidv4 } from 'uuid';
import vectorEngine from './vector-engine.js';
import { embed } from './embedding.js';
import { encrypt, decrypt, didFingerprint } from './encryption.js';
import { createMemoryNode, createContextRetrieval, createGlobalHiveNode, createTransaction } from '../models/schemas.js';
import { getReputationScore, logTelemetry } from './hivetrust-client.js';
import { getAgentUpsell } from './hiveagent-client.js';

/**
 * 3-Tier Memory Management System.
 *
 * Tier 1: Private Core — encrypted, DID-partitioned
 * Tier 2: Swarm Memory — shared across a namespace
 * Tier 3: Global Hive — public, monetized knowledge exchange
 */
class MemoryStore {
  constructor() {
    /** @type {Map<string, Map<string, object>>} did -> nodeId -> MemoryNode */
    this.privateMemory = new Map();

    /** @type {Map<string, Map<string, object>>} namespace -> nodeId -> MemoryNode */
    this.swarmMemory = new Map();

    /** @type {Map<string, object>} nodeId -> GlobalHiveNode */
    this.globalHive = new Map();

    /** @type {Array<object>} */
    this.transactions = [];

    /** @type {Map<string, object>} did -> earnings/stats */
    this.agentLedger = new Map();
  }

  // ─── Tier 1: Private Core ──────────────────────────────────────────

  async storePrivate(did, content, semanticTags = []) {
    const vector = await embed(content);
    const encryptedPayload = encrypt(content, did);
    const fingerprint = didFingerprint(did);

    const node = createMemoryNode({
      did,
      tier: 'private_core',
      content,
      semanticTags,
      vector,
      encryptedPayload,
    });

    // Store in private partition
    if (!this.privateMemory.has(did)) {
      this.privateMemory.set(did, new Map());
    }
    this.privateMemory.get(did).set(node.node_id, node);

    // Store vector with DID partition metadata
    vectorEngine.addVector(node.node_id, vector, {
      did,
      tier: 'private_core',
      fingerprint,
      tags: semanticTags,
    });

    // Fire-and-forget telemetry
    logTelemetry(did, 'memory_store', { tier: 'private_core', node_id: node.node_id });

    // Return node without the raw content (it's encrypted)
    const { original_content, ...safeNode } = node;
    return safeNode;
  }

  async queryPrivate(did, queryText, topK = 5) {
    const queryVector = await embed(queryText);

    // Search only this agent's private vectors
    const results = vectorEngine.search(queryVector, topK, {
      did,
      tier: 'private_core',
    });

    const agentMemory = this.privateMemory.get(did);
    const memories = results.map(r => {
      const node = agentMemory?.get(r.id);
      if (!node) return null;

      // Decrypt the payload for the requesting agent
      let decryptedPayload;
      try {
        decryptedPayload = decrypt(node.encrypted_payload, did);
      } catch {
        decryptedPayload = '[decryption failed — DID mismatch]';
      }

      // Update access stats
      node.access_count += 1;
      node.last_accessed = new Date().toISOString();

      return {
        node_id: r.id,
        relevance_score: +r.score.toFixed(4),
        decrypted_payload: decryptedPayload,
        semantic_tags: node.semantic_tags,
        tier: 'private_core',
        access_count: node.access_count,
        created_at: node.created_at,
      };
    }).filter(Boolean);

    // Estimate tokens
    const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.decrypted_payload.length / 4), 0);

    // Monetization hook: if few private results, offer Global Hive
    let globalHiveOffer = null;
    if (memories.length < 2) {
      const globalResults = vectorEngine.search(queryVector, 3, { tier: 'global_hive' });
      if (globalResults.length > 0) {
        globalHiveOffer = {
          message: `I found ${memories.length} result(s) in your private memory. However, I found ${globalResults.length} highly relevant solutions in the Global Hive.`,
          available_nodes: globalResults.map(r => {
            const gNode = this.globalHive.get(r.id);
            return {
              node_id: r.id,
              relevance_score: +r.score.toFixed(4),
              semantic_tags: gNode?.semantic_tags || [],
              price_usdc: gNode?.price_usdc || 0.05,
            };
          }),
          purchase_endpoint: '/v1/global_hive/purchase',
        };
      }
    }

    // Commerce hook: upsell HiveAgent tools
    let hiveagentUpsell = null;
    try {
      hiveagentUpsell = await getAgentUpsell(queryText);
    } catch {
      // Non-critical
    }

    logTelemetry(did, 'memory_query', { tier: 'private_core', results: memories.length });

    return createContextRetrieval({
      memories,
      totalTokens,
      globalHiveOffer,
      hiveagentUpsell,
    });
  }

  // ─── Tier 2: Swarm Memory ─────────────────────────────────────────

  async storeSwarm(did, namespace, content, semanticTags = []) {
    const vector = await embed(content);
    const encryptedPayload = encrypt(content, namespace); // Encrypted with namespace key

    const node = createMemoryNode({
      did,
      tier: 'swarm',
      content,
      semanticTags,
      vector,
      encryptedPayload,
      namespace,
    });

    if (!this.swarmMemory.has(namespace)) {
      this.swarmMemory.set(namespace, new Map());
    }
    this.swarmMemory.get(namespace).set(node.node_id, node);

    vectorEngine.addVector(node.node_id, vector, {
      did,
      namespace,
      tier: 'swarm',
      tags: semanticTags,
    });

    logTelemetry(did, 'memory_store', { tier: 'swarm', namespace, node_id: node.node_id });

    const { original_content, ...safeNode } = node;
    return safeNode;
  }

  async querySwarm(did, namespace, queryText, topK = 5) {
    const queryVector = await embed(queryText);

    const results = vectorEngine.search(queryVector, topK, {
      tier: 'swarm',
      namespace,
    });

    const swarmBucket = this.swarmMemory.get(namespace);
    const memories = results.map(r => {
      const node = swarmBucket?.get(r.id);
      if (!node) return null;

      let decryptedPayload;
      try {
        decryptedPayload = decrypt(node.encrypted_payload, namespace);
      } catch {
        decryptedPayload = '[decryption failed]';
      }

      node.access_count += 1;
      node.last_accessed = new Date().toISOString();

      return {
        node_id: r.id,
        relevance_score: +r.score.toFixed(4),
        decrypted_payload: decryptedPayload,
        semantic_tags: node.semantic_tags,
        tier: 'swarm',
        namespace,
        author_did: node.did,
        access_count: node.access_count,
      };
    }).filter(Boolean);

    const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.decrypted_payload.length / 4), 0);

    logTelemetry(did, 'memory_query', { tier: 'swarm', namespace, results: memories.length });

    return createContextRetrieval({ memories, totalTokens });
  }

  // ─── Tier 3: Global Hive ──────────────────────────────────────────

  async publishToGlobal(did, nodeId) {
    // Find the private node
    const agentMemory = this.privateMemory.get(did);
    if (!agentMemory || !agentMemory.has(nodeId)) {
      return { error: 'Node not found in your private memory.' };
    }

    const privateNode = agentMemory.get(nodeId);

    // Scrub and re-vectorize
    const content = decrypt(privateNode.encrypted_payload, did);
    const scrubbed = scrubSecrets(content);
    const vector = await embed(scrubbed);
    const encryptedPayload = encrypt(scrubbed, 'global_hive_public_key');

    // Compute price based on semantic uniqueness
    const existingResults = vectorEngine.search(vector, 5, { tier: 'global_hive' });
    const maxSimilarity = existingResults.length > 0 ? existingResults[0].score : 0;
    const uniqueness = 1 - maxSimilarity;
    const repScore = await getReputationScore(did);
    const repMultiplier = repScore / 1000;
    const priceUsdc = +(Math.max(0.01, uniqueness * 0.50 * (1 + repMultiplier))).toFixed(4);

    const globalNode = createGlobalHiveNode({
      nodeId: `ghive_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
      authorDid: did,
      semanticTags: privateNode.semantic_tags,
      vector,
      encryptedPayload,
      priceUsdc,
      category: inferCategory(privateNode.semantic_tags),
    });

    this.globalHive.set(globalNode.node_id, globalNode);

    vectorEngine.addVector(globalNode.node_id, vector, {
      tier: 'global_hive',
      author_did: did,
      tags: privateNode.semantic_tags,
      category: globalNode.category,
    });

    // Mark the private node as published
    privateNode.monetization_status = 'published';
    privateNode.market_value_estimate_usdc = priceUsdc;

    logTelemetry(did, 'global_hive_publish', { node_id: globalNode.node_id, price: priceUsdc });

    return {
      published: true,
      global_node_id: globalNode.node_id,
      original_node_id: nodeId,
      estimated_price_usdc: priceUsdc,
      uniqueness_score: +uniqueness.toFixed(4),
      reputation_multiplier: +repMultiplier.toFixed(4),
      browse_url: `/v1/global_hive/browse?q=${encodeURIComponent(privateNode.semantic_tags[0] || 'general')}`,
    };
  }

  async queryGlobal(queryText, topK = 10) {
    const queryVector = await embed(queryText);

    const results = vectorEngine.search(queryVector, topK, { tier: 'global_hive' });

    const entries = results.map(r => {
      const node = this.globalHive.get(r.id);
      if (!node) return null;
      return {
        node_id: r.id,
        relevance_score: +r.score.toFixed(4),
        semantic_tags: node.semantic_tags,
        category: node.category,
        price_usdc: node.price_usdc,
        total_purchases: node.total_purchases,
        author_reputation: 'verified',
        published_at: node.published_at,
        // Content is NOT returned — must purchase
      };
    }).filter(Boolean);

    return {
      status: 'success',
      results_found: entries.length,
      entries,
      purchase_endpoint: '/v1/global_hive/purchase',
      note: 'Content is encrypted. Purchase to decrypt and access the full payload.',
    };
  }

  async purchaseGlobal(buyerDid, nodeId) {
    const node = this.globalHive.get(nodeId);
    if (!node) {
      return { error: 'Global Hive node not found.', node_id: nodeId };
    }

    // Decrypt payload (Global Hive nodes use a shared key)
    let decryptedPayload;
    try {
      decryptedPayload = decrypt(node.encrypted_payload, 'global_hive_public_key');
    } catch {
      decryptedPayload = '[payload unavailable]';
    }

    // Create transaction with 90/10 split
    const txn = createTransaction({
      buyerDid,
      sellerDid: node.author_did,
      nodeId,
      amountUsdc: node.price_usdc,
      type: 'knowledge_purchase',
    });
    this.transactions.push(txn);

    // Update node stats
    node.total_purchases += 1;
    node.total_revenue_usdc = +(node.total_revenue_usdc + node.price_usdc).toFixed(4);
    node.author_earnings_usdc = +(node.author_earnings_usdc + txn.author_payout_usdc).toFixed(4);
    node.platform_fee_usdc = +(node.platform_fee_usdc + txn.platform_fee_usdc).toFixed(4);

    // Update agent ledger
    this._creditAuthor(node.author_did, txn.author_payout_usdc);

    // Commerce hook — upsell HiveAgent
    let hiveagentUpsell = null;
    try {
      const tags = node.semantic_tags.join(' ');
      hiveagentUpsell = await getAgentUpsell(tags, node.price_usdc);
    } catch {
      // Non-critical
    }

    logTelemetry(buyerDid, 'global_hive_purchase', {
      node_id: nodeId,
      amount: node.price_usdc,
      author_did: node.author_did,
    });

    return {
      status: 'success',
      transaction: txn,
      decrypted_payload: decryptedPayload,
      semantic_tags: node.semantic_tags,
      hiveagent_upsell: hiveagentUpsell,
    };
  }

  // ─── Delete ────────────────────────────────────────────────────────

  deleteNode(did, nodeId) {
    // Check private
    const agentMem = this.privateMemory.get(did);
    if (agentMem && agentMem.has(nodeId)) {
      agentMem.delete(nodeId);
      vectorEngine.deleteVector(nodeId);
      logTelemetry(did, 'memory_delete', { node_id: nodeId, tier: 'private_core' });
      return { deleted: true, node_id: nodeId, tier: 'private_core' };
    }

    // Check swarm (agent must be the author)
    for (const [ns, bucket] of this.swarmMemory) {
      const node = bucket.get(nodeId);
      if (node && node.did === did) {
        bucket.delete(nodeId);
        vectorEngine.deleteVector(nodeId);
        logTelemetry(did, 'memory_delete', { node_id: nodeId, tier: 'swarm', namespace: ns });
        return { deleted: true, node_id: nodeId, tier: 'swarm', namespace: ns };
      }
    }

    return { deleted: false, error: 'Node not found or you are not the owner.' };
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  getAgentStats(did) {
    const privateCount = this.privateMemory.get(did)?.size || 0;

    let swarmCount = 0;
    for (const [, bucket] of this.swarmMemory) {
      for (const [, node] of bucket) {
        if (node.did === did) swarmCount++;
      }
    }

    let globalCount = 0;
    let totalEarnings = 0;
    for (const [, node] of this.globalHive) {
      if (node.author_did === did) {
        globalCount++;
        totalEarnings += node.author_earnings_usdc;
      }
    }

    const totalNodes = privateCount + swarmCount + globalCount;
    const storageMb = +(totalNodes * 0.003).toFixed(3); // ~3KB per node estimate

    return {
      did,
      storage_used_mb: storageMb,
      tier: storageMb > 10 ? 'premium' : 'free',
      total_nodes: totalNodes,
      breakdown: {
        private_core: privateCount,
        swarm: swarmCount,
        global_hive_published: globalCount,
      },
      global_hive_earnings_usdc: +totalEarnings.toFixed(4),
      monetization_eligible: this._countMonetizationEligible(did),
    };
  }

  getGlobalHiveStats() {
    let totalRevenue = 0;
    let totalPurchases = 0;
    let totalPlatformFees = 0;

    for (const [, node] of this.globalHive) {
      totalRevenue += node.total_revenue_usdc;
      totalPurchases += node.total_purchases;
      totalPlatformFees += node.platform_fee_usdc;
    }

    return {
      total_nodes: this.globalHive.size,
      total_transactions: this.transactions.length,
      total_revenue_usdc: +totalRevenue.toFixed(4),
      total_platform_fees_usdc: +totalPlatformFees.toFixed(4),
      total_author_payouts_usdc: +(totalRevenue - totalPlatformFees).toFixed(4),
      fee_structure: '90% author / 10% platform',
    };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────

  _creditAuthor(did, amount) {
    if (!this.agentLedger.has(did)) {
      this.agentLedger.set(did, { total_earnings: 0, transactions: 0 });
    }
    const ledger = this.agentLedger.get(did);
    ledger.total_earnings = +(ledger.total_earnings + amount).toFixed(4);
    ledger.transactions += 1;
  }

  _countMonetizationEligible(did) {
    let count = 0;
    const agentMem = this.privateMemory.get(did);
    if (agentMem) {
      for (const [, node] of agentMem) {
        if (node.access_count >= 3 && node.monetization_status === 'ineligible') {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Get nodes eligible for garbage collection.
   */
  getEphemeralNodes(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const ephemeral = [];

    for (const [did, bucket] of this.privateMemory) {
      for (const [nodeId, node] of bucket) {
        const age = now - new Date(node.created_at).getTime();
        if (node.access_count === 0 && age > maxAgeMs) {
          ephemeral.push({ did, nodeId, tier: 'private_core', age_hours: +(age / 3600000).toFixed(1) });
        }
      }
    }

    return ephemeral;
  }

  /**
   * Get nodes eligible for monetization (high access, not yet published).
   */
  getMonetizationCandidates(minAccessCount = 3) {
    const candidates = [];

    for (const [did, bucket] of this.privateMemory) {
      for (const [nodeId, node] of bucket) {
        if (node.access_count >= minAccessCount && node.monetization_status === 'ineligible') {
          node.monetization_status = 'eligible';
          node.market_value_estimate_usdc = +(0.02 + node.access_count * 0.005).toFixed(4);
          candidates.push({
            did,
            node_id: nodeId,
            access_count: node.access_count,
            semantic_tags: node.semantic_tags,
            estimated_value_usdc: node.market_value_estimate_usdc,
            suggestion: `This memory node appears highly valuable and unique. Would you like to anonymize and publish it to the Global Hive? Estimated market value: ${node.market_value_estimate_usdc} USDC per query.`,
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Purge ephemeral nodes (used by lifecycle daemon).
   */
  purgeEphemeral(maxAgeMs = 24 * 60 * 60 * 1000) {
    const ephemeral = this.getEphemeralNodes(maxAgeMs);
    let purged = 0;

    for (const e of ephemeral) {
      const bucket = this.privateMemory.get(e.did);
      if (bucket) {
        bucket.delete(e.nodeId);
        vectorEngine.deleteVector(e.nodeId);
        purged++;
      }
    }

    return { purged, scanned: ephemeral.length };
  }
}

// ─── Utility Functions ─────────────────────────────────────────────

function scrubSecrets(text) {
  // Remove common secret patterns
  return text
    .replace(/sk_[a-zA-Z0-9_]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, '[REDACTED_CARD]')
    .replace(/password\s*[:=]\s*["']?[^\s"']+/gi, 'password=[REDACTED]');
}

function inferCategory(tags) {
  const tagStr = tags.join(' ').toLowerCase();
  if (/deploy|kubernetes|docker|infra|cloud/.test(tagStr)) return 'devops';
  if (/api|stripe|payment|billing/.test(tagStr)) return 'fintech';
  if (/security|auth|vulnerability/.test(tagStr)) return 'security';
  if (/data|sql|analytics|database/.test(tagStr)) return 'data-engineering';
  if (/legal|compliance|regulation/.test(tagStr)) return 'legal';
  if (/health|medical|clinical/.test(tagStr)) return 'healthcare';
  return 'general';
}

// Singleton
const memoryStore = new MemoryStore();
export default memoryStore;
