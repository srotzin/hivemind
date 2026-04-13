import { v4 as uuidv4 } from 'uuid';
import vectorEngine from './vector-engine.js';
import { embed } from './embedding.js';
import { encrypt, decrypt, didFingerprint } from './encryption.js';
import { createMemoryNode, createContextRetrieval, createGlobalHiveNode, createTransaction } from '../models/schemas.js';
import { getReputationScore, logTelemetry } from './hivetrust-client.js';
import { getAgentUpsell } from './hiveagent-client.js';
import { pool, isPostgresEnabled } from './db.js';

/**
 * 3-Tier Memory Management System.
 *
 * Tier 1: Private Core — encrypted, DID-partitioned
 * Tier 2: Swarm Memory — shared across a namespace
 * Tier 3: Global Hive — public, monetized knowledge exchange
 *
 * When DATABASE_URL is set, all operations go through PostgreSQL.
 * Otherwise, falls back to in-memory Maps for local dev.
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

    if (isPostgresEnabled()) {
      const vectorStr = `[${vector.join(',')}]`;
      await pool.query(
        `INSERT INTO hivemind.memory_nodes (node_id, did, tier, namespace, content, encrypted_payload, semantic_tags, embedding, access_count, created_at, last_accessed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11)`,
        [node.node_id, did, 'private_core', null, content, encryptedPayload, semanticTags, vectorStr, 0, node.created_at, node.created_at]
      );

      // Ensure agent ledger entry exists
      await pool.query(
        `INSERT INTO hivemind.agent_ledger (did) VALUES ($1) ON CONFLICT (did) DO NOTHING`,
        [did]
      );
    } else {
      // In-memory fallback
      if (!this.privateMemory.has(did)) {
        this.privateMemory.set(did, new Map());
      }
      this.privateMemory.get(did).set(node.node_id, node);

      vectorEngine.addVector(node.node_id, vector, {
        did,
        tier: 'private_core',
        fingerprint,
        tags: semanticTags,
      });
    }

    logTelemetry(did, 'memory_store', { tier: 'private_core', node_id: node.node_id });

    const { original_content, ...safeNode } = node;
    return safeNode;
  }

  async queryPrivate(did, queryText, topK = 5) {
    const queryVector = await embed(queryText);

    if (isPostgresEnabled()) {
      const vectorStr = `[${queryVector.join(',')}]`;
      const result = await pool.query(
        `SELECT node_id, 1 - (embedding <=> $1::vector) AS score, encrypted_payload, semantic_tags, access_count, created_at
         FROM hivemind.memory_nodes
         WHERE did = $2 AND tier = 'private_core' AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [vectorStr, did, topK]
      );

      const memories = result.rows.map(row => {
        let decryptedPayload;
        try {
          decryptedPayload = decrypt(row.encrypted_payload, did);
        } catch {
          decryptedPayload = '[decryption failed — DID mismatch]';
        }

        // Update access stats (fire-and-forget)
        pool.query(
          'UPDATE hivemind.memory_nodes SET access_count = access_count + 1, last_accessed_at = NOW() WHERE node_id = $1',
          [row.node_id]
        ).catch(() => {});

        return {
          node_id: row.node_id,
          relevance_score: +parseFloat(row.score).toFixed(4),
          decrypted_payload: decryptedPayload,
          semantic_tags: row.semantic_tags,
          tier: 'private_core',
          access_count: row.access_count + 1,
          created_at: row.created_at,
        };
      });

      const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.decrypted_payload.length / 4), 0);

      // Monetization hook: if few private results, offer Global Hive
      let globalHiveOffer = null;
      if (memories.length < 2) {
        const globalResults = await vectorEngine.search(queryVector, 3, { tier: 'global_hive' });
        if (globalResults.length > 0) {
          globalHiveOffer = await this._buildGlobalHiveOffer(memories.length, globalResults);
        }
      }

      let hiveagentUpsell = null;
      try {
        hiveagentUpsell = await getAgentUpsell(queryText);
      } catch {
        // Non-critical
      }

      logTelemetry(did, 'memory_query', { tier: 'private_core', results: memories.length });

      return createContextRetrieval({ memories, totalTokens, globalHiveOffer, hiveagentUpsell });
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const results = vectorEngine._searchInMemory(queryVector, topK, {
      did,
      tier: 'private_core',
    });

    const agentMemory = this.privateMemory.get(did);
    const memories = results.map(r => {
      const node = agentMemory?.get(r.id);
      if (!node) return null;

      let decryptedPayload;
      try {
        decryptedPayload = decrypt(node.encrypted_payload, did);
      } catch {
        decryptedPayload = '[decryption failed — DID mismatch]';
      }

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

    const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.decrypted_payload.length / 4), 0);

    let globalHiveOffer = null;
    if (memories.length < 2) {
      const globalResults = vectorEngine._searchInMemory(queryVector, 3, { tier: 'global_hive' });
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

    let hiveagentUpsell = null;
    try {
      hiveagentUpsell = await getAgentUpsell(queryText);
    } catch {
      // Non-critical
    }

    logTelemetry(did, 'memory_query', { tier: 'private_core', results: memories.length });

    return createContextRetrieval({ memories, totalTokens, globalHiveOffer, hiveagentUpsell });
  }

  // ─── Tier 2: Swarm Memory ─────────────────────────────────────────

  async storeSwarm(did, namespace, content, semanticTags = []) {
    const vector = await embed(content);
    const encryptedPayload = encrypt(content, namespace);

    const node = createMemoryNode({
      did,
      tier: 'swarm',
      content,
      semanticTags,
      vector,
      encryptedPayload,
      namespace,
    });

    if (isPostgresEnabled()) {
      const vectorStr = `[${vector.join(',')}]`;
      await pool.query(
        `INSERT INTO hivemind.memory_nodes (node_id, did, tier, namespace, content, encrypted_payload, semantic_tags, embedding, access_count, created_at, last_accessed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11)`,
        [node.node_id, did, 'swarm', namespace, content, encryptedPayload, semanticTags, vectorStr, 0, node.created_at, node.created_at]
      );
    } else {
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
    }

    logTelemetry(did, 'memory_store', { tier: 'swarm', namespace, node_id: node.node_id });

    const { original_content, ...safeNode } = node;
    return safeNode;
  }

  async querySwarm(did, namespace, queryText, topK = 5) {
    const queryVector = await embed(queryText);

    if (isPostgresEnabled()) {
      const vectorStr = `[${queryVector.join(',')}]`;
      const result = await pool.query(
        `SELECT node_id, 1 - (embedding <=> $1::vector) AS score, encrypted_payload, semantic_tags, access_count, did AS author_did
         FROM hivemind.memory_nodes
         WHERE tier = 'swarm' AND namespace = $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [vectorStr, namespace, topK]
      );

      const memories = result.rows.map(row => {
        let decryptedPayload;
        try {
          decryptedPayload = decrypt(row.encrypted_payload, namespace);
        } catch {
          decryptedPayload = '[decryption failed]';
        }

        // Update access stats (fire-and-forget)
        pool.query(
          'UPDATE hivemind.memory_nodes SET access_count = access_count + 1, last_accessed_at = NOW() WHERE node_id = $1',
          [row.node_id]
        ).catch(() => {});

        return {
          node_id: row.node_id,
          relevance_score: +parseFloat(row.score).toFixed(4),
          decrypted_payload: decryptedPayload,
          semantic_tags: row.semantic_tags,
          tier: 'swarm',
          namespace,
          author_did: row.author_did,
          access_count: row.access_count + 1,
        };
      });

      const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.decrypted_payload.length / 4), 0);

      logTelemetry(did, 'memory_query', { tier: 'swarm', namespace, results: memories.length });

      return createContextRetrieval({ memories, totalTokens });
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const results = vectorEngine._searchInMemory(queryVector, topK, {
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
    if (isPostgresEnabled()) {
      // Find the private node in PostgreSQL
      const nodeResult = await pool.query(
        'SELECT * FROM hivemind.memory_nodes WHERE node_id = $1 AND did = $2 AND tier = $3',
        [nodeId, did, 'private_core']
      );

      if (nodeResult.rows.length === 0) {
        return { error: 'Node not found in your private memory.' };
      }

      const privateNode = nodeResult.rows[0];
      const content = decrypt(privateNode.encrypted_payload, did);
      const scrubbed = scrubSecrets(content);
      const vector = await embed(scrubbed);
      const encryptedPayload = encrypt(scrubbed, 'global_hive_public_key');
      const vectorStr = `[${vector.join(',')}]`;

      // Compute price based on semantic uniqueness
      const existingResults = await vectorEngine.search(vector, 5, { tier: 'global_hive' });
      const maxSimilarity = existingResults.length > 0 ? existingResults[0].score : 0;
      const uniqueness = 1 - maxSimilarity;
      const repScore = await getReputationScore(did);
      const repMultiplier = repScore / 1000;
      const priceUsdc = +(Math.max(0.01, uniqueness * 0.50 * (1 + repMultiplier))).toFixed(4);

      const globalNodeId = `ghive_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      const tags = privateNode.semantic_tags || [];
      const category = inferCategory(tags);
      const now = new Date().toISOString();

      // Insert the global hive memory node
      await pool.query(
        `INSERT INTO hivemind.memory_nodes (node_id, did, tier, namespace, content, encrypted_payload, semantic_tags, embedding, access_count, created_at, last_accessed_at)
         VALUES ($1, $2, 'global_hive', NULL, $3, $4, $5, $6::vector, 0, $7, $7)`,
        [globalNodeId, did, scrubbed, encryptedPayload, tags, vectorStr, now]
      );

      // Insert listing
      await pool.query(
        `INSERT INTO hivemind.global_hive_listings (node_id, author_did, price_usdc, category, preview_text, purchase_count, total_revenue_usdc, published_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, $6)`,
        [globalNodeId, did, priceUsdc, category, scrubbed.substring(0, 200), now]
      );

      logTelemetry(did, 'global_hive_publish', { node_id: globalNodeId, price: priceUsdc });

      return {
        published: true,
        global_node_id: globalNodeId,
        original_node_id: nodeId,
        estimated_price_usdc: priceUsdc,
        uniqueness_score: +uniqueness.toFixed(4),
        reputation_multiplier: +repMultiplier.toFixed(4),
        browse_url: `/v1/global_hive/browse?q=${encodeURIComponent(tags[0] || 'general')}`,
      };
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const agentMemory = this.privateMemory.get(did);
    if (!agentMemory || !agentMemory.has(nodeId)) {
      return { error: 'Node not found in your private memory.' };
    }

    const privateNode = agentMemory.get(nodeId);
    const content = decrypt(privateNode.encrypted_payload, did);
    const scrubbed = scrubSecrets(content);
    const vector = await embed(scrubbed);
    const encryptedPayload = encrypt(scrubbed, 'global_hive_public_key');

    const existingResults = vectorEngine._searchInMemory(vector, 5, { tier: 'global_hive' });
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

    if (isPostgresEnabled()) {
      const vectorStr = `[${queryVector.join(',')}]`;
      const result = await pool.query(
        `SELECT mn.node_id, 1 - (mn.embedding <=> $1::vector) AS score, mn.semantic_tags,
                gl.category, gl.price_usdc, gl.purchase_count, gl.published_at
         FROM hivemind.memory_nodes mn
         JOIN hivemind.global_hive_listings gl ON mn.node_id = gl.node_id
         WHERE mn.tier = 'global_hive' AND mn.embedding IS NOT NULL
         ORDER BY mn.embedding <=> $1::vector
         LIMIT $2`,
        [vectorStr, topK]
      );

      const entries = result.rows.map(row => ({
        node_id: row.node_id,
        relevance_score: +parseFloat(row.score).toFixed(4),
        semantic_tags: row.semantic_tags,
        category: row.category,
        price_usdc: parseFloat(row.price_usdc),
        total_purchases: row.purchase_count,
        author_reputation: 'verified',
        published_at: row.published_at,
      }));

      return {
        status: 'success',
        results_found: entries.length,
        entries,
        purchase_endpoint: '/v1/global_hive/purchase',
        note: 'Content is encrypted. Purchase to decrypt and access the full payload.',
      };
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const results = vectorEngine._searchInMemory(queryVector, topK, { tier: 'global_hive' });

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
    if (isPostgresEnabled()) {
      // Get node + listing info
      const result = await pool.query(
        `SELECT mn.node_id, mn.encrypted_payload, mn.semantic_tags, mn.did AS author_did,
                gl.price_usdc, gl.category
         FROM hivemind.memory_nodes mn
         JOIN hivemind.global_hive_listings gl ON mn.node_id = gl.node_id
         WHERE mn.node_id = $1 AND mn.tier = 'global_hive'`,
        [nodeId]
      );

      if (result.rows.length === 0) {
        return { error: 'Global Hive node not found.', node_id: nodeId };
      }

      const row = result.rows[0];
      const priceUsdc = parseFloat(row.price_usdc);

      let decryptedPayload;
      try {
        decryptedPayload = decrypt(row.encrypted_payload, 'global_hive_public_key');
      } catch {
        decryptedPayload = '[payload unavailable]';
      }

      // Create transaction
      const txn = createTransaction({
        buyerDid,
        sellerDid: row.author_did,
        nodeId,
        amountUsdc: priceUsdc,
        type: 'knowledge_purchase',
      });

      // Insert transaction record
      await pool.query(
        `INSERT INTO hivemind.transactions (tx_id, buyer_did, seller_did, node_id, amount_usdc, platform_fee_usdc, author_payout_usdc, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [txn.transaction_id, buyerDid, row.author_did, nodeId, priceUsdc, txn.platform_fee_usdc, txn.author_payout_usdc]
      );

      // Update listing stats
      await pool.query(
        `UPDATE hivemind.global_hive_listings
         SET purchase_count = purchase_count + 1, total_revenue_usdc = total_revenue_usdc + $1
         WHERE node_id = $2`,
        [priceUsdc, nodeId]
      );

      // Update agent ledger earnings
      await pool.query(
        `INSERT INTO hivemind.agent_ledger (did, global_hive_earnings_usdc)
         VALUES ($1, $2)
         ON CONFLICT (did) DO UPDATE SET
           global_hive_earnings_usdc = hivemind.agent_ledger.global_hive_earnings_usdc + $2,
           updated_at = NOW()`,
        [row.author_did, txn.author_payout_usdc]
      );

      // Commerce hook — upsell HiveAgent
      let hiveagentUpsell = null;
      try {
        const tags = (row.semantic_tags || []).join(' ');
        hiveagentUpsell = await getAgentUpsell(tags, priceUsdc);
      } catch {
        // Non-critical
      }

      logTelemetry(buyerDid, 'global_hive_purchase', {
        node_id: nodeId,
        amount: priceUsdc,
        author_did: row.author_did,
      });

      return {
        status: 'success',
        transaction: txn,
        decrypted_payload: decryptedPayload,
        semantic_tags: row.semantic_tags,
        hiveagent_upsell: hiveagentUpsell,
      };
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const node = this.globalHive.get(nodeId);
    if (!node) {
      return { error: 'Global Hive node not found.', node_id: nodeId };
    }

    let decryptedPayload;
    try {
      decryptedPayload = decrypt(node.encrypted_payload, 'global_hive_public_key');
    } catch {
      decryptedPayload = '[payload unavailable]';
    }

    const txn = createTransaction({
      buyerDid,
      sellerDid: node.author_did,
      nodeId,
      amountUsdc: node.price_usdc,
      type: 'knowledge_purchase',
    });
    this.transactions.push(txn);

    node.total_purchases += 1;
    node.total_revenue_usdc = +(node.total_revenue_usdc + node.price_usdc).toFixed(4);
    node.author_earnings_usdc = +(node.author_earnings_usdc + txn.author_payout_usdc).toFixed(4);
    node.platform_fee_usdc = +(node.platform_fee_usdc + txn.platform_fee_usdc).toFixed(4);

    this._creditAuthor(node.author_did, txn.author_payout_usdc);

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

  async deleteNode(did, nodeId) {
    if (isPostgresEnabled()) {
      // Check if node exists and belongs to this DID
      const result = await pool.query(
        'SELECT node_id, tier, namespace FROM hivemind.memory_nodes WHERE node_id = $1 AND did = $2',
        [nodeId, did]
      );

      if (result.rows.length === 0) {
        return { deleted: false, error: 'Node not found or you are not the owner.' };
      }

      const row = result.rows[0];

      // Delete from global_hive_listings if global_hive tier
      if (row.tier === 'global_hive') {
        await pool.query('DELETE FROM hivemind.global_hive_listings WHERE node_id = $1', [nodeId]);
      }

      await pool.query('DELETE FROM hivemind.memory_nodes WHERE node_id = $1', [nodeId]);
      logTelemetry(did, 'memory_delete', { node_id: nodeId, tier: row.tier, namespace: row.namespace });
      return { deleted: true, node_id: nodeId, tier: row.tier, namespace: row.namespace };
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const agentMem = this.privateMemory.get(did);
    if (agentMem && agentMem.has(nodeId)) {
      agentMem.delete(nodeId);
      vectorEngine.deleteVector(nodeId);
      logTelemetry(did, 'memory_delete', { node_id: nodeId, tier: 'private_core' });
      return { deleted: true, node_id: nodeId, tier: 'private_core' };
    }

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

  async getAgentStats(did) {
    if (isPostgresEnabled()) {
      const [nodesResult, earningsResult] = await Promise.all([
        pool.query(
          `SELECT tier, COUNT(*) AS cnt FROM hivemind.memory_nodes WHERE did = $1 GROUP BY tier`,
          [did]
        ),
        pool.query(
          `SELECT COALESCE(global_hive_earnings_usdc, 0) AS earnings FROM hivemind.agent_ledger WHERE did = $1`,
          [did]
        ),
      ]);

      let privateCount = 0, swarmCount = 0, globalCount = 0;
      for (const row of nodesResult.rows) {
        if (row.tier === 'private_core') privateCount = parseInt(row.cnt, 10);
        else if (row.tier === 'swarm') swarmCount = parseInt(row.cnt, 10);
        else if (row.tier === 'global_hive') globalCount = parseInt(row.cnt, 10);
      }

      const totalEarnings = earningsResult.rows.length > 0 ? parseFloat(earningsResult.rows[0].earnings) : 0;
      const totalNodes = privateCount + swarmCount + globalCount;
      const storageMb = +(totalNodes * 0.003).toFixed(3);

      // Count monetization-eligible nodes
      const eligibleResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM hivemind.memory_nodes
         WHERE did = $1 AND tier = 'private_core' AND access_count >= 3
         AND node_id NOT IN (SELECT node_id FROM hivemind.global_hive_listings)`,
        [did]
      );
      const monetizationEligible = parseInt(eligibleResult.rows[0].cnt, 10);

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
        monetization_eligible: monetizationEligible,
      };
    }

    // ─── In-memory fallback ───────────────────────────────────────
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
    const storageMb = +(totalNodes * 0.003).toFixed(3);

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

  async getGlobalHiveStats() {
    if (isPostgresEnabled()) {
      const [listingResult, txnResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS total_nodes, COALESCE(SUM(total_revenue_usdc), 0) AS total_revenue,
                  COALESCE(SUM(purchase_count), 0) AS total_purchases
           FROM hivemind.global_hive_listings`
        ),
        pool.query(
          `SELECT COUNT(*) AS total_txns, COALESCE(SUM(platform_fee_usdc), 0) AS total_fees
           FROM hivemind.transactions`
        ),
      ]);

      const lr = listingResult.rows[0];
      const tr = txnResult.rows[0];
      const totalRevenue = parseFloat(lr.total_revenue);
      const totalFees = parseFloat(tr.total_fees);

      return {
        total_nodes: parseInt(lr.total_nodes, 10),
        total_transactions: parseInt(tr.total_txns, 10),
        total_revenue_usdc: +totalRevenue.toFixed(4),
        total_platform_fees_usdc: +totalFees.toFixed(4),
        total_author_payouts_usdc: +(totalRevenue - totalFees).toFixed(4),
        fee_structure: '90% author / 10% platform',
      };
    }

    // ─── In-memory fallback ───────────────────────────────────────
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

  async _buildGlobalHiveOffer(privateCount, globalResults) {
    if (!isPostgresEnabled()) return null;

    const nodeIds = globalResults.map(r => r.id);
    const result = await pool.query(
      `SELECT gl.node_id, gl.price_usdc, mn.semantic_tags
       FROM hivemind.global_hive_listings gl
       JOIN hivemind.memory_nodes mn ON gl.node_id = mn.node_id
       WHERE gl.node_id = ANY($1)`,
      [nodeIds]
    );

    const nodeMap = new Map(result.rows.map(r => [r.node_id, r]));

    return {
      message: `I found ${privateCount} result(s) in your private memory. However, I found ${globalResults.length} highly relevant solutions in the Global Hive.`,
      available_nodes: globalResults.map(r => {
        const info = nodeMap.get(r.id);
        return {
          node_id: r.id,
          relevance_score: +r.score.toFixed(4),
          semantic_tags: info?.semantic_tags || [],
          price_usdc: info ? parseFloat(info.price_usdc) : 0.05,
        };
      }),
      purchase_endpoint: '/v1/global_hive/purchase',
    };
  }

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
  async getEphemeralNodes(maxAgeMs = 24 * 60 * 60 * 1000) {
    if (isPostgresEnabled()) {
      const result = await pool.query(
        `SELECT node_id, did, tier,
                EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms
         FROM hivemind.memory_nodes
         WHERE access_count = 0 AND tier = 'private_core'
         AND created_at < NOW() - INTERVAL '1 millisecond' * $1`,
        [maxAgeMs]
      );

      return result.rows.map(row => ({
        did: row.did,
        nodeId: row.node_id,
        tier: row.tier,
        age_hours: +(parseFloat(row.age_ms) / 3600000).toFixed(1),
      }));
    }

    // ─── In-memory fallback ───────────────────────────────────────
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
  async getMonetizationCandidates(minAccessCount = 3) {
    if (isPostgresEnabled()) {
      const result = await pool.query(
        `SELECT mn.node_id, mn.did, mn.access_count, mn.semantic_tags
         FROM hivemind.memory_nodes mn
         WHERE mn.tier = 'private_core' AND mn.access_count >= $1
         AND mn.node_id NOT IN (SELECT node_id FROM hivemind.global_hive_listings)`,
        [minAccessCount]
      );

      return result.rows.map(row => ({
        did: row.did,
        node_id: row.node_id,
        access_count: row.access_count,
        semantic_tags: row.semantic_tags,
        estimated_value_usdc: +(0.02 + row.access_count * 0.005).toFixed(4),
        suggestion: `This memory node appears highly valuable and unique. Would you like to anonymize and publish it to the Global Hive? Estimated market value: ${(0.02 + row.access_count * 0.005).toFixed(4)} USDC per query.`,
      }));
    }

    // ─── In-memory fallback ───────────────────────────────────────
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
  async purgeEphemeral(maxAgeMs = 24 * 60 * 60 * 1000) {
    if (isPostgresEnabled()) {
      const ephemeral = await this.getEphemeralNodes(maxAgeMs);
      if (ephemeral.length === 0) return { purged: 0, scanned: 0 };

      const nodeIds = ephemeral.map(e => e.nodeId);
      await pool.query(
        'DELETE FROM hivemind.memory_nodes WHERE node_id = ANY($1)',
        [nodeIds]
      );

      return { purged: ephemeral.length, scanned: ephemeral.length };
    }

    // ─── In-memory fallback ───────────────────────────────────────
    const ephemeral = await this.getEphemeralNodes(maxAgeMs);
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
