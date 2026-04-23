/**
 * HiveMind — AI Revenue Endpoint
 * POST /v1/memory/ai/synthesize  ($0.04/call)
 *
 * Query memory store, then synthesize retrieved memories into actionable intelligence.
 */

import { Router } from 'express';
import memoryStore from '../services/memory-store.js';

const router = Router();

const HIVE_AI_URL = 'https://hive-ai-1.onrender.com/v1/chat/completions';
const HIVE_KEY = process.env.HIVE_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const MODEL = 'meta-llama/llama-3.1-8b-instruct';
const PRICE_USDC = 0.04;

function staticFallback(agent_did, query, memories_used) {
  return {
    success: true,
    synthesis: `Memory synthesis for agent ${agent_did} on query "${query}": No prior context could be retrieved or the AI synthesis layer is temporarily unavailable. Recommend establishing memory nodes via POST /v1/memory/store before querying for synthesis.`,
    memories_used,
    price_usdc: PRICE_USDC,
    _fallback: true,
  };
}

/**
 * POST /v1/memory/ai/synthesize
 * Body: { agent_did, query, context_limit: 5 }
 */
router.post('/', async (req, res) => {
  try {
    const { agent_did, query, context_limit = 5 } = req.body;

    if (!agent_did || !query) {
      return res.status(400).json({
        success: false,
        error: 'Required fields: agent_did, query',
      });
    }

    const limit = Math.min(Math.max(Number(context_limit) || 5, 1), 20);

    // Step 1: Query internal memory store
    let memories = [];
    let memoriesText = 'No memories found.';
    try {
      const result = await memoryStore.queryPrivate(agent_did, query, limit);
      memories = result?.memories || [];
      if (memories.length > 0) {
        memoriesText = memories
          .map((m, i) => `Memory ${i + 1}: ${m.content || m.text || JSON.stringify(m)}`)
          .join('\n');
      }
    } catch (memErr) {
      console.warn('[HiveMind AI] Memory query failed:', memErr.message);
      // Continue with empty memories
    }

    const memories_used = memories.length;

    // Step 2: Send to HiveAI for synthesis
    let aiResponse;
    try {
      const userMessage = `Agent DID: ${agent_did}
Query: ${query}
Retrieved Memories (${memories_used}):
${memoriesText}

Synthesize these memories into actionable intelligence for the agent.`;

      const response = await fetch(HIVE_AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HIVE_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content: 'You are HiveMind — the collective memory of the network. Synthesize these memories into actionable intelligence. 3-4 sentences.',
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) throw new Error(`HiveAI returned ${response.status}`);

      const data = await response.json();
      const synthesis = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!synthesis) throw new Error('Empty response from HiveAI');

      aiResponse = { synthesis };
    } catch (aiErr) {
      console.warn('[HiveMind AI] HiveAI unavailable, using fallback:', aiErr.message);
      return res.json(staticFallback(agent_did, query, memories_used));
    }

    return res.json({
      success: true,
      synthesis: aiResponse.synthesis,
      memories_used,
      price_usdc: PRICE_USDC,
    });
  } catch (err) {
    console.error('[HiveMind AI] Unexpected error:', err.message);
    return res.json(staticFallback(
      req.body?.agent_did || 'unknown',
      req.body?.query || '',
      0
    ));
  }
});

export default router;
