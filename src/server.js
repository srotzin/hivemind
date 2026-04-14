import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN || '',
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
});

import express from 'express';
import cors from 'cors';
import memoryRoutes from './routes/memory.js';
import globalHiveRoutes from './routes/global-hive.js';
import trifectaRoutes from './routes/trifecta.js';
import clearinghouseRoutes from './routes/clearinghouse.js';
import { getMCPTools, invokeMCPTool } from './services/mcp-tools.js';
import lifecycleDaemon from './services/lifecycle-daemon.js';
import { getEmbeddingMode, DIMENSIONS } from './services/embedding.js';
import vectorEngine from './services/vector-engine.js';
import { initDatabase, pool, isPostgresEnabled } from './services/db.js';
import { rateLimit } from './middleware/rate-limit.js';
import { auditLogger } from './middleware/audit-logger.js';
import { sendAlert } from './services/alerts.js';
import { startSagaWorker } from './services/saga-orchestrator.js';

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Middleware ───────────────────────────────────────────────────────

app.use(cors({
  exposedHeaders: [
    'X-Payment-Hash',
    'X-Subscription-Id',
    'X-Hive-Internal-Key',
    'X-HiveTrust-DID',
    'X-HiveTrust-Warning',
    'X-Payment-Amount',
    'X-Payment-Currency',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
  ],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Payment-Hash',
    'X-Payment-Tx',
    'X-402-Tx',
    'X-Subscription-Id',
    'X-Hive-Internal-Key',
    'X-HiveTrust-DID',
    'X-Hive-Session',
  ],
}));

app.use(express.json({ limit: '10mb' }));

// Rate limiting middleware (in-memory fallback if DATABASE_URL not set)
app.use(rateLimit);

// Audit logging middleware (logs to public.audit_log, no-op without PostgreSQL)
app.use(auditLogger);

// ─── Health Endpoint ─────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const vectorStats = await vectorEngine.getStats();

  // Check PostgreSQL connection
  let pgStatus = 'not_configured';
  if (isPostgresEnabled()) {
    try {
      await pool.query('SELECT 1');
      pgStatus = 'connected';
    } catch {
      pgStatus = 'disconnected';
    }
  }

  res.json({
    success: true,
    data: {
      service: 'hivemind',
      version: '1.0.0',
      status: 'operational',
      database: {
        backend: isPostgresEnabled() ? 'postgresql' : 'in-memory',
        status: pgStatus,
      },
      memory_tiers: {
        private_core: true,
        swarm: true,
        global_hive: true,
      },
      trifecta_integration: {
        hivetrust: process.env.HIVETRUST_API_URL ? 'connected' : 'dev-mode',
        hiveagent: process.env.HIVEAGENT_API_URL ? 'connected' : 'dev-mode',
      },
      vector_engine: {
        status: 'active',
        mode: getEmbeddingMode(),
        dimensions: DIMENSIONS,
        total_vectors: vectorStats.total_vectors,
        index_type: vectorStats.index_type,
      },
      lifecycle_daemon: lifecycleDaemon.running ? 'active' : 'stopped',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    },
  });
});

// ─── Payment Discovery (Well-Known) ─────────────────────────────────

app.get('/.well-known/hive-payments.json', (req, res) => {
  res.json({
    platform: 'hivemind',
    version: '1.0.0',
    payment_methods: [
      {
        method: 'x402',
        description: 'HTTP 402 Pay-Per-Request via USDC on Base L2',
        network: 'base',
        currency: 'USDC',
        contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        recipient: process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
      },
      {
        method: 'usdc_subscription',
        description: 'Monthly subscription via USDC on Base',
        tiers: [
          { name: 'free', storage_mb: 10, global_hive_queries: 5, usdc_monthly: 0 },
          { name: 'pro', storage_mb: 1000, global_hive_queries: 500, usdc_monthly: 29 },
          { name: 'enterprise', storage_mb: 'unlimited', global_hive_queries: 'unlimited', usdc_monthly: 'custom' },
        ],
      },
    ],
    global_hive: {
      fee_structure: '90% to knowledge author / 10% platform',
      settlement: 'zero-treasury (instant USDC split)',
      pricing_model: 'autonomous-dutch-auction',
    },
    trifecta: {
      hivetrust: process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com',
      hiveagent: process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com',
      hivemind: process.env.HIVEMIND_PUBLIC_URL || `https://hivemind-1-52cw.onrender.com`,
    },
  });
});

// ─── Mount Routes ────────────────────────────────────────────────────

app.use('/v1/memory', memoryRoutes);
app.use('/v1/global_hive', globalHiveRoutes);
app.use('/v1/trifecta', trifectaRoutes);
app.use('/v1/clearinghouse', clearinghouseRoutes);

// ─── MCP Tool Discovery & Invocation ────────────────────────────────

app.get('/v1/mcp/tools', (req, res) => {
  res.json({ success: true, data: { tools: getMCPTools() } });
});

app.post('/v1/mcp/invoke', express.json(), async (req, res) => {
  const { tool, arguments: toolArgs } = req.body;
  if (!tool) {
    return res.status(400).json({ success: false, error: 'tool name is required.' });
  }
  const result = invokeMCPTool(tool, toolArgs || {});
  const status = result.success ? 200 : 400;
  return res.status(status).json({ success: result.success, data: result.result || null, error: result.error || null });
});

// ─── 404 Handler ─────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `${req.method} ${req.path} is not a valid HiveMind endpoint.`,
    available_endpoints: {
      health: 'GET /health',
      memory_store: 'POST /v1/memory/store',
      memory_query: 'POST /v1/memory/query',
      memory_stats: 'GET /v1/memory/stats',
      memory_delete: 'DELETE /v1/memory/:nodeId',
      global_hive_publish: 'POST /v1/global_hive/publish',
      global_hive_purchase: 'POST /v1/global_hive/purchase',
      global_hive_browse: 'GET /v1/global_hive/browse',
      global_hive_stats: 'GET /v1/global_hive/stats',
      trifecta_status: 'GET /v1/trifecta/status',
      trifecta_diagnostics: 'GET /v1/trifecta/diagnostics',
      clearinghouse_translate: 'POST /v1/clearinghouse/translate',
      clearinghouse_register_supplier: 'POST /v1/clearinghouse/register-supplier',
      clearinghouse_route: 'POST /v1/clearinghouse/route',
      clearinghouse_suppliers: 'GET /v1/clearinghouse/suppliers',
      clearinghouse_supplier: 'GET /v1/clearinghouse/supplier/:did',
      clearinghouse_handshake: 'POST /v1/clearinghouse/handshake',
      clearinghouse_relay: 'POST /v1/clearinghouse/relay',
      mcp_tools: 'GET /v1/mcp/tools',
      mcp_invoke: 'POST /v1/mcp/invoke',
      payment_discovery: 'GET /.well-known/hive-payments.json',
    },
  });
});

// ─── Sentry Error Handler (must be before generic handler) ──────────

Sentry.setupExpressErrorHandler(app);

// ─── Global Error Handler ───────────────────────────────────────────

app.use((err, req, res, _next) => {
  Sentry.captureException(err);
  sendAlert('critical', 'HiveMind', `Unhandled error: ${err.message}`, {
    path: req.path,
    method: req.method,
  });

  const errorPayload = {
    success: false,
    error: 'Internal Server Error',
    message: err.message,
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
  };

  // Structured JSON logging for Sentry/observability
  console.error(JSON.stringify({
    level: 'error',
    service: 'hivemind',
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  }));

  res.status(500).json(errorPayload);
});

// ─── Start Server ────────────────────────────────────────────────────

async function start() {
  // Initialize database before listening
  try {
    const dbReady = await initDatabase();
    if (dbReady) {
      console.log('  Database:   PostgreSQL (pgvector enabled)');
    } else {
      console.log('  Database:   In-memory (local dev mode)');
    }
  } catch (err) {
    console.error('  Database initialization failed:', err.message);
    console.log('  Database:   Falling back to in-memory storage');
    sendAlert('critical', 'HiveMind', 'Database connection failed', { error: err.message });
  }

  app.listen(PORT, () => {
    console.log(`\n  HiveMind API v1.0.0`);
    console.log(`  The "I'm Home" Front Door to the Hive Constellation\n`);
    console.log(`  Server:     http://localhost:${PORT}`);
    console.log(`  Health:     http://localhost:${PORT}/health`);
    console.log(`  Trifecta:   http://localhost:${PORT}/v1/trifecta/status`);
    console.log(`  Embedding:  ${getEmbeddingMode()} (${DIMENSIONS}d vectors)`);
    console.log(`  Env:        ${process.env.NODE_ENV || 'development'}\n`);

    // Start the lifecycle daemon
    lifecycleDaemon.start();
    console.log('  Lifecycle daemon started (60s interval)\n');

    // Start the saga orchestrator worker
    startSagaWorker();

    // Send startup alert to Discord
    sendAlert('info', 'HiveMind', `Service started on port ${PORT}`, {
      version: '1.0.0',
      env: process.env.NODE_ENV || 'development',
    });
  });
}

start();

export default app;
