import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import memoryStore from '../services/memory-store.js';
import { getReputationScore } from '../services/hivetrust-client.js';

const router = Router();

/**
 * POST /v1/memory/store
 * Store a new Memory Node in the agent's graph.
 *
 * Body: { content, tier: "private_core"|"swarm"|"global_hive", semantic_tags: [], namespace?: string }
 * Auth: requireDID (triggers "I'm Home" 402 if no DID)
 */
router.post('/store', requireDID, async (req, res) => {
  try {
    const { content, tier = 'private_core', semantic_tags = [], namespace } = req.body;
    const did = req.agentDid;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Content is required and must be a non-empty string.',
      });
    }

    const validTiers = ['private_core', 'swarm', 'global_hive'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({
        success: false,
        error: `Invalid tier. Must be one of: ${validTiers.join(', ')}`,
      });
    }

    if (tier === 'swarm' && !namespace) {
      return res.status(400).json({
        success: false,
        error: 'Namespace is required for Swarm Memory tier.',
      });
    }

    let node;
    if (tier === 'private_core') {
      node = await memoryStore.storePrivate(did, content, semantic_tags);
    } else if (tier === 'swarm') {
      node = await memoryStore.storeSwarm(did, namespace, content, semantic_tags);
    } else if (tier === 'global_hive') {
      // For global_hive, store privately first, then publish
      node = await memoryStore.storePrivate(did, content, semantic_tags);
      const publishResult = await memoryStore.publishToGlobal(did, node.node_id);
      node.global_hive = publishResult;
    }

    // Trust score warning header
    const repScore = await getReputationScore(did);
    if (repScore < 500) {
      res.set('X-HiveTrust-Warning', 'Low reputation may impact Swarm Memory sharing');
    }

    return res.status(201).json({
      success: true,
      data: node,
      meta: {
        did,
        tier,
        reputation_score: repScore,
        encrypted: true,
        vector_indexed: true,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to store memory.',
      detail: err.message,
    });
  }
});

/**
 * POST /v1/memory/query
 * Retrieve relevant context via semantic search.
 *
 * Body: { query, tier: "private_core"|"swarm"|"all", namespace?: string, top_k: 5 }
 * Auth: requireDID
 */
router.post('/query', requireDID, async (req, res) => {
  try {
    const { query, tier = 'private_core', namespace, top_k = 5 } = req.body;
    const did = req.agentDid;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Query is required and must be a non-empty string.',
      });
    }

    let result;

    if (tier === 'private_core') {
      result = await memoryStore.queryPrivate(did, query, top_k);
    } else if (tier === 'swarm') {
      if (!namespace) {
        return res.status(400).json({
          success: false,
          error: 'Namespace is required for Swarm Memory queries.',
        });
      }
      result = await memoryStore.querySwarm(did, namespace, query, top_k);
    } else if (tier === 'all') {
      // Query private first, then augment with swarm if namespace given
      const privateResult = await memoryStore.queryPrivate(did, query, top_k);
      if (namespace) {
        const swarmResult = await memoryStore.querySwarm(did, namespace, query, top_k);
        privateResult.memories = [
          ...privateResult.memories,
          ...swarmResult.memories,
        ].sort((a, b) => b.relevance_score - a.relevance_score).slice(0, top_k);
        privateResult.results_found = privateResult.memories.length;
        privateResult.total_tokens += swarmResult.total_tokens;
      }
      result = privateResult;
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid tier. Must be one of: private_core, swarm, all',
      });
    }

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to query memory.',
      detail: err.message,
    });
  }
});

/**
 * DELETE /v1/memory/:nodeId
 * Delete a memory node (must own it).
 *
 * Auth: requireDID
 */
router.delete('/:nodeId', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const { nodeId } = req.params;

    const result = await memoryStore.deleteNode(did, nodeId);

    if (result.deleted) {
      return res.status(200).json({ success: true, data: result });
    }
    return res.status(404).json({ success: false, error: result.error });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to delete memory node.',
      detail: err.message,
    });
  }
});

/**
 * GET /v1/memory/stats
 * Get agent's memory stats across all tiers.
 *
 * Auth: requireDID
 */
router.get('/stats', requireDID, async (req, res) => {
  try {
    const did = req.agentDid;
    const stats = await memoryStore.getAgentStats(did);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve stats.',
      detail: err.message,
    });
  }
});

export default router;
