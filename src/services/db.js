import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

/** @type {pg.Pool|null} */
let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 20,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

/**
 * Check if PostgreSQL is available and configured.
 */
export function isPostgresEnabled() {
  return pool !== null;
}

/**
 * Initialize hivemind schema and tables.
 * Uses the exact SQL from the migration spec.
 */
export async function initDatabase() {
  if (!pool) {
    console.log('  DATABASE_URL not set — using in-memory storage (local dev mode)');
    return false;
  }

  const client = await pool.connect();
  try {
    // Enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create schemas
    await client.query('CREATE SCHEMA IF NOT EXISTS hivemind');

    // ─── Shared Tables (public schema) ──────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.sagas (
        saga_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        state JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'in_progress',
        steps_completed JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.audit_log (
        id SERIAL PRIMARY KEY,
        from_platform TEXT NOT NULL,
        to_platform TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        did TEXT,
        method TEXT NOT NULL DEFAULT 'GET',
        status_code INTEGER,
        success BOOLEAN DEFAULT true,
        error_message TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.rate_limits (
        did TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER DEFAULT 1,
        PRIMARY KEY (did, window_start)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.spent_payments (
        tx_hash TEXT PRIMARY KEY,
        amount_usdc NUMERIC(12, 4),
        verified_at TIMESTAMPTZ DEFAULT NOW(),
        endpoint TEXT,
        did TEXT
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_spent_payments_verified_at ON public.spent_payments(verified_at)');

    // ─── HiveMind Schema ────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS hivemind.memory_nodes (
        node_id TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('private_core', 'swarm', 'global_hive')),
        namespace TEXT,
        content TEXT,
        encrypted_payload TEXT,
        semantic_tags TEXT[] DEFAULT '{}',
        embedding vector(128),
        access_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_memory_did ON hivemind.memory_nodes(did)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_memory_tier ON hivemind.memory_nodes(tier)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_memory_namespace ON hivemind.memory_nodes(namespace)');

    // IVFFlat index requires rows to exist; create only if table has data
    // We use a try/catch because the index may fail on empty tables
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_memory_embedding
        ON hivemind.memory_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch {
      // IVFFlat index creation may fail on empty tables — will be created later
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS hivemind.global_hive_listings (
        node_id TEXT PRIMARY KEY REFERENCES hivemind.memory_nodes(node_id),
        author_did TEXT NOT NULL,
        price_usdc NUMERIC(10, 4) DEFAULT 0.01,
        category TEXT,
        preview_text TEXT,
        purchase_count INTEGER DEFAULT 0,
        total_revenue_usdc NUMERIC(12, 4) DEFAULT 0,
        published_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hivemind.transactions (
        tx_id TEXT PRIMARY KEY,
        buyer_did TEXT NOT NULL,
        seller_did TEXT NOT NULL,
        node_id TEXT NOT NULL,
        amount_usdc NUMERIC(10, 4) NOT NULL,
        platform_fee_usdc NUMERIC(10, 4) NOT NULL,
        author_payout_usdc NUMERIC(10, 4) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hivemind.agent_ledger (
        did TEXT PRIMARY KEY,
        storage_used_bytes BIGINT DEFAULT 0,
        node_count INTEGER DEFAULT 0,
        global_hive_earnings_usdc NUMERIC(12, 4) DEFAULT 0,
        tier TEXT DEFAULT 'free',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('  PostgreSQL schema initialized successfully');
    return true;
  } finally {
    client.release();
  }
}

export default pool;
export { pool };
