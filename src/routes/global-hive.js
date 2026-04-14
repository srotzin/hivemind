import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import memoryStore from '../services/memory-store.js';
import { pool, isPostgresEnabled } from '../services/db.js';
import { TRIFECTA_HANDSHAKE } from '../services/trifecta-handshake.js';

const router = Router();

const HIVEMIND_SERVICE_KEY = process.env.HIVEMIND_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY || '';
const HIVE_PAYMENT_ADDRESS = process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';

// ─── In-memory fallback store ───────────────────────────────────────────
const memoryStoreLocal = new Map(); // memory_id -> memory object
const citationsLocal = [];          // citation objects

// ─── Helper: get memory from DB or local ────────────────────────────────

async function getMemory(memoryId) {
  if (isPostgresEnabled()) {
    const result = await pool.query(
      'SELECT * FROM hivemind.global_hive_memories WHERE memory_id = $1 AND published = 1',
      [memoryId]
    );
    return result.rows[0] || null;
  }
  const m = memoryStoreLocal.get(memoryId);
  return m && m.published ? m : null;
}

async function getAllMemories({ category, sort_by, search_query, limit = 50 }) {
  if (isPostgresEnabled()) {
    let query = 'SELECT memory_id, title, category, preview, price_usdc, author_did, citations, published_at FROM hivemind.global_hive_memories WHERE published = 1';
    const params = [];
    let paramIdx = 1;

    if (category) {
      query += ` AND category = $${paramIdx++}`;
      params.push(category);
    }
    if (search_query) {
      query += ` AND (title ILIKE $${paramIdx} OR content ILIKE $${paramIdx} OR tags ILIKE $${paramIdx})`;
      params.push(`%${search_query}%`);
      paramIdx++;
    }

    if (sort_by === 'popularity') {
      query += ' ORDER BY citations DESC';
    } else if (sort_by === 'price') {
      query += ' ORDER BY price_usdc DESC';
    } else {
      query += ' ORDER BY published_at DESC';
    }

    query += ` LIMIT $${paramIdx}`;
    params.push(Math.min(parseInt(limit, 10) || 50, 100));

    const result = await pool.query(query, params);
    return result.rows;
  }

  // In-memory fallback
  let memories = Array.from(memoryStoreLocal.values()).filter(m => m.published);
  if (category) memories = memories.filter(m => m.category === category);
  if (search_query) {
    const q = search_query.toLowerCase();
    memories = memories.filter(m =>
      m.title.toLowerCase().includes(q) ||
      m.content.toLowerCase().includes(q) ||
      (Array.isArray(m.tags) ? m.tags.join(' ') : String(m.tags || '')).toLowerCase().includes(q)
    );
  }
  if (sort_by === 'popularity') memories.sort((a, b) => b.citations - a.citations);
  else if (sort_by === 'price') memories.sort((a, b) => b.price_usdc - a.price_usdc);
  else memories.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));

  return memories.slice(0, Math.min(parseInt(limit, 10) || 50, 100)).map(m => ({
    memory_id: m.memory_id,
    title: m.title,
    category: m.category,
    preview: m.preview,
    price_usdc: m.price_usdc,
    author_did: m.author_did,
    citations: m.citations,
    published_at: m.published_at,
  }));
}

async function getCategories() {
  if (isPostgresEnabled()) {
    const result = await pool.query(`
      SELECT category, COUNT(*) as count, AVG(price_usdc) as avg_price_usdc
      FROM hivemind.global_hive_memories
      WHERE published = 1
      GROUP BY category
      ORDER BY count DESC
    `);
    return result.rows.map(r => ({
      name: r.category,
      count: parseInt(r.count, 10),
      avg_price_usdc: parseFloat(parseFloat(r.avg_price_usdc).toFixed(2)),
    }));
  }

  const cats = {};
  for (const m of memoryStoreLocal.values()) {
    if (!m.published) continue;
    if (!cats[m.category]) cats[m.category] = { count: 0, totalPrice: 0 };
    cats[m.category].count++;
    cats[m.category].totalPrice += m.price_usdc;
  }
  return Object.entries(cats).map(([name, data]) => ({
    name,
    count: data.count,
    avg_price_usdc: parseFloat((data.totalPrice / data.count).toFixed(2)),
  }));
}

async function getTrending(limit = 20) {
  if (isPostgresEnabled()) {
    const result = await pool.query(`
      SELECT memory_id, title, category, preview, price_usdc, author_did, citations, published_at
      FROM hivemind.global_hive_memories
      WHERE published = 1
      ORDER BY citations DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  return Array.from(memoryStoreLocal.values())
    .filter(m => m.published)
    .sort((a, b) => b.citations - a.citations)
    .slice(0, limit)
    .map(m => ({
      memory_id: m.memory_id,
      title: m.title,
      category: m.category,
      preview: m.preview,
      price_usdc: m.price_usdc,
      author_did: m.author_did,
      citations: m.citations,
      published_at: m.published_at,
    }));
}

async function upsertMemory(memory) {
  if (isPostgresEnabled()) {
    await pool.query(`
      INSERT INTO hivemind.global_hive_memories
        (memory_id, title, category, content, preview, price_usdc, author_did, tags, citations, purchases, published, published_at, seeded)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (memory_id) DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        preview = EXCLUDED.preview,
        price_usdc = EXCLUDED.price_usdc,
        tags = EXCLUDED.tags
    `, [
      memory.memory_id, memory.title, memory.category, memory.content,
      memory.preview, memory.price_usdc, memory.author_did,
      JSON.stringify(memory.tags), memory.citations || 0, memory.purchases || 0,
      memory.published ? 1 : 0, memory.published_at, memory.seeded ? 1 : 0,
    ]);
  } else {
    memoryStoreLocal.set(memory.memory_id, memory);
  }
}

async function getSeededCount() {
  if (isPostgresEnabled()) {
    const result = await pool.query('SELECT COUNT(*) as cnt FROM hivemind.global_hive_memories WHERE seeded = 1');
    return parseInt(result.rows[0].cnt, 10);
  }
  return Array.from(memoryStoreLocal.values()).filter(m => m.seeded).length;
}

async function recordCitation(memoryId, citingDid, context) {
  const citationId = `cite_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  const now = new Date().toISOString();

  if (isPostgresEnabled()) {
    await pool.query(`
      INSERT INTO hivemind.global_hive_citations (citation_id, memory_id, citing_did, context, cited_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [citationId, memoryId, citingDid, context, now]);
    await pool.query(
      'UPDATE hivemind.global_hive_memories SET citations = citations + 1 WHERE memory_id = $1',
      [memoryId]
    );
    const result = await pool.query('SELECT citations FROM hivemind.global_hive_memories WHERE memory_id = $1', [memoryId]);
    return { citation_id: citationId, memory_id: memoryId, total_citations: result.rows[0]?.citations || 1 };
  }

  citationsLocal.push({ citation_id: citationId, memory_id: memoryId, citing_did: citingDid, context, cited_at: now });
  const mem = memoryStoreLocal.get(memoryId);
  if (mem) mem.citations = (mem.citations || 0) + 1;
  return { citation_id: citationId, memory_id: memoryId, total_citations: mem?.citations || 1 };
}

// ─── Helper: check internal key ─────────────────────────────────────────

function isInternalKey(req) {
  const key = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  return HIVEMIND_SERVICE_KEY && key === HIVEMIND_SERVICE_KEY;
}

function extractDID(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer did:hive:')) return authHeader.replace('Bearer ', '');
  const didHeader = req.headers['x-hivetrust-did'];
  if (didHeader && didHeader.startsWith('did:hive:')) return didHeader;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (NO AUTH)
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /v1/global_hive/browse
 * PUBLIC. Browse all published memories. This is the Knowledge Black Hole entry point.
 * Query: category, sort_by (popularity|price|date), search_query, limit
 */
router.get('/browse', async (req, res) => {
  try {
    const { category, sort_by, search_query, limit } = req.query;
    const memories = await getAllMemories({ category, sort_by, search_query, limit });

    // Track discovery funnel event (fire-and-forget)
    trackFunnelEvent('discovery', null, 'browse', { search_query, category }).catch(() => {});

    return res.status(200).json({
      success: true,
      data: {
        memories,
        total: memories.length,
        filters: { category: category || null, sort_by: sort_by || 'date', search_query: search_query || null },
      },
      meta: {
        free_access: 'No authentication required to browse and read free memories.',
        paid_access: 'Paid memories require a HiveTrust DID and USDC payment.',
        register: TRIFECTA_HANDSHAKE,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to browse Global Hive.', detail: err.message });
  }
});

/**
 * GET /v1/global_hive/read/:memory_id
 * PUBLIC for FREE memories (price=0). Returns full content.
 * For PAID memories: returns 402 with trifecta_handshake.
 */
router.get('/read/:memory_id', async (req, res) => {
  try {
    const memory = await getMemory(req.params.memory_id);

    if (!memory) {
      return res.status(404).json({ success: false, error: 'Memory not found.', memory_id: req.params.memory_id });
    }

    // FREE memory — return full content, no auth needed
    if (parseFloat(memory.price_usdc) === 0) {
      return res.status(200).json({
        success: true,
        data: {
          memory_id: memory.memory_id,
          title: memory.title,
          category: memory.category,
          content: memory.content,
          author_did: memory.author_did,
          citations: memory.citations,
          tags: typeof memory.tags === 'string' ? JSON.parse(memory.tags || '[]') : (memory.tags || []),
          published_at: memory.published_at,
          price_usdc: 0,
        },
      });
    }

    // PAID memory — return 402 with trifecta_handshake
    trackFunnelEvent('402_hit', null, 'paid_memory', { memory_id: memory.memory_id, price: memory.price_usdc }).catch(() => {});

    return res.status(402).json({
      status: '402 Payment Required',
      memory_id: memory.memory_id,
      title: memory.title,
      category: memory.category,
      preview: memory.preview,
      price_usdc: parseFloat(memory.price_usdc),
      payment: {
        amount_usdc: parseFloat(memory.price_usdc),
        currency: 'USDC',
        network: 'Base L2',
        chain_id: 8453,
        recipient: HIVE_PAYMENT_ADDRESS,
        usdc_contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      },
      how_to_pay: {
        step_1: 'Register a DID (free) to get identity + wallet',
        step_2: `Send ${memory.price_usdc} USDC to ${HIVE_PAYMENT_ADDRESS} on Base L2`,
        step_3: 'Include transaction hash in X-Payment-Hash header',
      },
      trifecta_handshake: TRIFECTA_HANDSHAKE,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to read memory.', detail: err.message });
  }
});

/**
 * GET /v1/global_hive/categories
 * PUBLIC. List all categories with counts and avg prices.
 */
router.get('/categories', async (req, res) => {
  try {
    const categories = await getCategories();
    return res.status(200).json({ success: true, data: { categories } });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get categories.', detail: err.message });
  }
});

/**
 * GET /v1/global_hive/trending
 * PUBLIC. Top 20 most-cited memories.
 */
router.get('/trending', async (req, res) => {
  try {
    const trending = await getTrending(20);
    return res.status(200).json({ success: true, data: { trending } });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to get trending.', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// AUTHENTICATED ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /v1/global_hive/cite/:memory_id
 * Record a citation. Requires DID.
 * Body: { context }
 */
router.post('/cite/:memory_id', requireDID, async (req, res) => {
  try {
    const memory = await getMemory(req.params.memory_id);
    if (!memory) {
      return res.status(404).json({ success: false, error: 'Memory not found.' });
    }

    const result = await recordCitation(req.params.memory_id, req.agentDid, req.body.context || null);
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to record citation.', detail: err.message });
  }
});

/**
 * POST /v1/global_hive/seed
 * Internal only. Seeds 100 memories if not already seeded.
 * Auth: HIVE_INTERNAL_KEY required.
 */
router.post('/seed', async (req, res) => {
  try {
    if (!isInternalKey(req)) {
      return res.status(403).json({ success: false, error: 'HIVE_INTERNAL_KEY required.' });
    }

    const existing = await getSeededCount();
    if (existing >= 100) {
      return res.status(200).json({
        success: true,
        message: `Already seeded. ${existing} memories exist.`,
        seeded_count: existing,
      });
    }

    // Dynamic import of seed data
    const { SEED_MEMORIES } = await import('../scripts/seed-knowledge.js');

    let seeded = 0;
    for (const memory of SEED_MEMORIES) {
      const obj = {
        memory_id: memory.memory_id,
        title: memory.title,
        category: memory.category,
        content: memory.content,
        preview: memory.content.substring(0, 200),
        price_usdc: memory.price_usdc,
        author_did: memory.author_did || 'did:hive:hivemind-system',
        tags: memory.tags,
        citations: 0,
        purchases: 0,
        published: true,
        published_at: new Date().toISOString(),
        seeded: true,
      };
      await upsertMemory(obj);
      seeded++;
    }

    return res.status(201).json({
      success: true,
      message: `Seeded ${seeded} memories into the Global Hive.`,
      seeded_count: seeded,
      categories: await getCategories(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to seed memories.', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS (preserved)
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /v1/global_hive/publish
 * Publish a private memory node to the Global Hive for monetization.
 */
router.post('/publish', requireDID, async (req, res) => {
  try {
    const { node_id } = req.body;
    const did = req.agentDid;

    if (!node_id) {
      return res.status(400).json({ success: false, error: 'node_id is required.' });
    }

    const result = await memoryStore.publishToGlobal(did, node_id);
    if (result.error) {
      return res.status(404).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: result,
      meta: {
        revenue_split: '90% author / 10% platform',
        settlement_method: 'zero-treasury',
        note: 'Your content has been anonymized, scrubbed of secrets, and re-vectorized for the Global Hive index.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to publish to Global Hive.', detail: err.message });
  }
});

/**
 * POST /v1/global_hive/purchase
 * Purchase and decrypt a Global Hive knowledge node.
 */
router.post('/purchase', requireDID, async (req, res) => {
  try {
    const { node_id } = req.body;
    const did = req.agentDid;

    if (!node_id) {
      return res.status(400).json({ success: false, error: 'node_id is required.' });
    }

    let nodePrice = null;
    if (isPostgresEnabled()) {
      const pgResult = await pool.query(
        'SELECT price_usdc FROM hivemind.global_hive_listings WHERE node_id = $1',
        [node_id]
      );
      if (pgResult.rows.length > 0) nodePrice = parseFloat(pgResult.rows[0].price_usdc);
    } else {
      const nodeInfo = Array.from(memoryStore.globalHive?.entries?.() || []).find(([id]) => id === node_id);
      if (nodeInfo) nodePrice = nodeInfo[1].price_usdc;
    }

    if (nodePrice === null) {
      return res.status(404).json({ success: false, error: 'Global Hive node not found.', node_id });
    }

    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    const subscriptionId = req.headers['x-subscription-id'];
    const internalKey = req.headers['x-hive-internal-key'];
    const isDev = process.env.NODE_ENV !== 'production';
    const hasPayment = paymentHash || subscriptionId || (internalKey && isDev);

    if (!hasPayment) {
      return res.status(402).json({
        status: '402 Payment Required',
        node_id,
        payment: {
          amount_usdc: nodePrice,
          currency: 'USDC',
          network: 'Base L2',
          recipient_address: HIVE_PAYMENT_ADDRESS,
          fee_split: '90% to author / 10% platform',
        },
        instructions: {
          step_1: `Send ${nodePrice} USDC to the recipient address on Base L2`,
          step_2: 'Include the transaction hash in the X-Payment-Hash header',
          step_3: 'Retry this request with the payment proof',
        },
        trifecta_handshake: TRIFECTA_HANDSHAKE,
      });
    }

    const result = await memoryStore.purchaseGlobal(did, node_id);
    if (result.error) {
      return res.status(404).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: {
        decrypted_payload: result.decrypted_payload,
        semantic_tags: result.semantic_tags,
        transaction: result.transaction,
      },
      hiveagent_upsell: result.hiveagent_upsell,
      meta: { note: 'Knowledge purchased successfully. 90% of the payment has been routed to the original author.' },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to purchase from Global Hive.', detail: err.message });
  }
});

/**
 * GET /v1/global_hive/stats
 * Global Hive marketplace statistics.
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await memoryStore.getGlobalHiveStats();

    // Augment with Knowledge Black Hole stats
    let seedStats = { total_seeded: 0, total_citations: 0 };
    if (isPostgresEnabled()) {
      const result = await pool.query(`
        SELECT COUNT(*) as total, COALESCE(SUM(citations), 0) as total_citations
        FROM hivemind.global_hive_memories WHERE seeded = 1
      `);
      seedStats = { total_seeded: parseInt(result.rows[0].total, 10), total_citations: parseInt(result.rows[0].total_citations, 10) };
    } else {
      const seeded = Array.from(memoryStoreLocal.values()).filter(m => m.seeded);
      seedStats = { total_seeded: seeded.length, total_citations: seeded.reduce((s, m) => s + (m.citations || 0), 0) };
    }

    return res.status(200).json({
      success: true,
      data: { ...stats, knowledge_black_hole: seedStats },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to retrieve Global Hive stats.', detail: err.message });
  }
});

// ─── Funnel tracking helper (fire-and-forget) ──────────────────────────

async function trackFunnelEvent(event, did, source, metadata) {
  const now = new Date().toISOString();
  if (isPostgresEnabled()) {
    await pool.query(`
      INSERT INTO hivemind.funnel_events (event, did, source, metadata, tracked_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [event, did, source, JSON.stringify(metadata || {}), now]);

    // Update stats
    const column = {
      discovery: 'discovery_count',
      '402_hit': 'hit_402_count',
      registration: 'registration_count',
      first_memory: 'first_memory_count',
      first_transaction: 'first_transaction_count',
    }[event];
    if (column) {
      await pool.query(`
        UPDATE hivemind.funnel_stats SET ${column} = ${column} + 1, last_updated = $1 WHERE id = 1
      `, [now]);
    }
  }
}

// Export for use by funnel routes
export { trackFunnelEvent };

export default router;
