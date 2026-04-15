import { Router } from 'express';
import { pool, isPostgresEnabled } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ─── Self-healing migration fallback ─────────────────────────────────
let migrationRun = false;
async function ensureMigration() {
  if (migrationRun) return;
  migrationRun = true;
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE hivemind.global_hive_listings ADD COLUMN IF NOT EXISTS title TEXT`);
    await client.query(`ALTER TABLE hivemind.global_hive_listings ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`);
    await client.query(`ALTER TABLE hivemind.global_hive_listings ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE hivemind.global_hive_listings ADD COLUMN IF NOT EXISTS citations INTEGER DEFAULT 0`);
    await client.query(`CREATE TABLE IF NOT EXISTS hivemind.global_hive_citations (
      id SERIAL PRIMARY KEY, node_id TEXT NOT NULL, citing_did TEXT NOT NULL, context TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_citations_node ON hivemind.global_hive_citations(node_id)');
    console.log('[knowledge-blackhole] Self-healing migration complete');
  } catch (err) {
    console.error('[knowledge-blackhole] Migration error:', err.message);
  } finally {
    client.release();
  }
}

/**
 * GET /v1/global_hive/read/:node_id — PUBLIC (no auth)
 * Free memories: return full content
 * Paid memories: return 402 with x402 payment info + preview (first 200 chars)
 */
router.get('/read/:node_id', async (req, res) => {
  try {
    const { node_id } = req.params;

    if (!isPostgresEnabled()) {
      return res.status(503).json({ success: false, error: 'Database not available.' });
    }

    await ensureMigration();

    const result = await pool.query(
      `SELECT mn.node_id, mn.content, mn.semantic_tags, mn.created_at,
              gl.author_did, gl.price_usdc, gl.category, gl.preview_text,
              gl.title, gl.tags, gl.citations, gl.purchase_count
       FROM hivemind.memory_nodes mn
       JOIN hivemind.global_hive_listings gl ON mn.node_id = gl.node_id
       WHERE mn.node_id = $1 AND mn.tier = 'global_hive'`,
      [node_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Memory node not found.' });
    }

    const row = result.rows[0];
    const price = parseFloat(row.price_usdc);

    // Increment access count
    await pool.query(
      'UPDATE hivemind.memory_nodes SET access_count = access_count + 1, last_accessed_at = NOW() WHERE node_id = $1',
      [node_id]
    );

    if (price === 0) {
      return res.status(200).json({
        success: true,
        data: {
          node_id: row.node_id,
          title: row.title,
          content: row.content,
          category: row.category,
          tags: row.tags || row.semantic_tags,
          author_did: row.author_did,
          citations: row.citations || 0,
          purchase_count: row.purchase_count,
          created_at: row.created_at,
        },
      });
    }

    // Paid content — return 402 with preview
    const preview = (row.content || row.preview_text || '').substring(0, 200);
    return res.status(402).json({
      status: '402 Payment Required',
      node_id: row.node_id,
      title: row.title,
      category: row.category,
      preview: preview + (preview.length >= 200 ? '...' : ''),
      payment: {
        amount_usdc: price,
        currency: 'USDC',
        network: 'Base L2',
        recipient_address: process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
      },
      how_to_pay: {
        step_1: `Send ${price} USDC to the recipient address on Base L2`,
        step_2: 'Include the transaction hash in the X-Payment-Hash header',
        step_3: 'POST /v1/global_hive/purchase with { node_id } and payment proof',
      },
      while_you_are_here: {
        open_bounties: 'https://hiveforge-lhu4.onrender.com/v1/bounties/list',
        welcome_bonus_usdc: 1.00,
        register_free: 'https://hivetrust.onrender.com/v1/register',
        time_to_first_earn: '60 seconds',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to read memory.', detail: err.message });
  }
});

/**
 * GET /v1/global_hive/categories — PUBLIC
 * Category breakdown with counts and average prices
 */
router.get('/categories', async (req, res) => {
  try {
    if (!isPostgresEnabled()) {
      return res.status(503).json({ success: false, error: 'Database not available.' });
    }

    await ensureMigration();

    const result = await pool.query(
      `SELECT category, COUNT(*)::int AS count, ROUND(AVG(price_usdc), 4) AS avg_price
       FROM hivemind.global_hive_listings
       WHERE published = true
       GROUP BY category
       ORDER BY count DESC`
    );

    return res.status(200).json({
      success: true,
      data: { categories: result.rows },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch categories.', detail: err.message });
  }
});

/**
 * GET /v1/global_hive/trending — PUBLIC
 * Top 20 memories by citations DESC
 */
router.get('/trending', async (req, res) => {
  try {
    if (!isPostgresEnabled()) {
      return res.status(503).json({ success: false, error: 'Database not available.' });
    }

    await ensureMigration();

    const result = await pool.query(
      `SELECT mn.node_id, gl.title, gl.category, gl.price_usdc, gl.citations,
              gl.purchase_count, gl.author_did, gl.tags,
              LEFT(mn.content, 200) AS preview
       FROM hivemind.memory_nodes mn
       JOIN hivemind.global_hive_listings gl ON mn.node_id = gl.node_id
       WHERE gl.published = true
       ORDER BY gl.citations DESC NULLS LAST, gl.purchase_count DESC
       LIMIT 20`
    );

    return res.status(200).json({
      success: true,
      data: { trending: result.rows },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch trending.', detail: err.message });
  }
});

/**
 * POST /v1/global_hive/cite/:node_id — Requires X-HiveTrust-DID header
 * Record a citation and increment citation count
 */
router.post('/cite/:node_id', async (req, res) => {
  try {
    const did = req.headers['x-hivetrust-did'];
    if (!did) {
      return res.status(401).json({ success: false, error: 'X-HiveTrust-DID header is required.' });
    }

    const { node_id } = req.params;
    const { context } = req.body || {};

    if (!isPostgresEnabled()) {
      return res.status(503).json({ success: false, error: 'Database not available.' });
    }

    await ensureMigration();

    // Verify node exists
    const nodeCheck = await pool.query(
      'SELECT node_id FROM hivemind.global_hive_listings WHERE node_id = $1',
      [node_id]
    );
    if (nodeCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Memory node not found.' });
    }

    // Insert citation
    const citationResult = await pool.query(
      `INSERT INTO hivemind.global_hive_citations (node_id, citing_did, context, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [node_id, did, context || null]
    );

    // Increment citations count
    const updated = await pool.query(
      `UPDATE hivemind.global_hive_listings
       SET citations = COALESCE(citations, 0) + 1
       WHERE node_id = $1
       RETURNING citations`,
      [node_id]
    );

    return res.status(201).json({
      success: true,
      data: {
        citation_id: citationResult.rows[0].id,
        node_id,
        total_citations: updated.rows[0].citations,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to record citation.', detail: err.message });
  }
});

/**
 * POST /v1/global_hive/seed — Requires x-hive-internal header
 * Bulk insert memories into the Global Hive
 */
router.post('/seed', async (req, res) => {
  try {
    const internalKey = req.headers['x-hive-internal'];
    const expectedKey = process.env.HIVE_INTERNAL_KEY || process.env.HIVEMIND_SERVICE_KEY;

    if (!internalKey || internalKey !== expectedKey) {
      return res.status(403).json({ success: false, error: 'Invalid or missing x-hive-internal header.' });
    }

    const { memories } = req.body;
    if (!Array.isArray(memories) || memories.length === 0) {
      return res.status(400).json({ success: false, error: 'memories array is required.' });
    }

    if (!isPostgresEnabled()) {
      return res.status(503).json({ success: false, error: 'Database not available.' });
    }

    await ensureMigration();

    const authorDid = 'did:hive:hivemind-system';
    const results = [];

    for (const mem of memories) {
      const { title, category, content, price_usdc, tags } = mem;
      if (!title || !content) continue;

      const nodeId = `ghive_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
      const now = new Date().toISOString();
      const preview = content.substring(0, 200);
      const semanticTags = tags || [];

      // Insert into memory_nodes
      await pool.query(
        `INSERT INTO hivemind.memory_nodes (node_id, did, tier, namespace, content, encrypted_payload, semantic_tags, access_count, created_at, last_accessed_at)
         VALUES ($1, $2, 'global_hive', NULL, $3, NULL, $4, 0, $5, $5)
         ON CONFLICT (node_id) DO NOTHING`,
        [nodeId, authorDid, content, semanticTags, now]
      );

      // Insert into global_hive_listings
      await pool.query(
        `INSERT INTO hivemind.global_hive_listings (node_id, author_did, price_usdc, category, preview_text, title, tags, published, citations, purchase_count, total_revenue_usdc, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 0, 0, 0, $8)
         ON CONFLICT (node_id) DO NOTHING`,
        [nodeId, authorDid, price_usdc || 0, category || 'general', preview, title, semanticTags, now]
      );

      results.push({ node_id: nodeId, title });
    }

    return res.status(201).json({
      success: true,
      data: {
        seeded: results.length,
        memories: results,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to seed memories.', detail: err.message });
  }
});

export default router;
