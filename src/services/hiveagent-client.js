import { pool, isPostgresEnabled } from './db.js';

const HIVEAGENT_API_URL = process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com';
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Log an audit entry for cross-platform calls.
 */
async function logAuditEntry(from, to, endpoint, did, method, statusCode, success, errorMsg, durationMs) {
  if (!isPostgresEnabled()) return;
  try {
    await pool.query(
      'INSERT INTO public.audit_log (from_platform, to_platform, endpoint, did, method, status_code, success, error_message, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [from, to, endpoint, did, method, statusCode, success, errorMsg, durationMs]
    );
  } catch {
    /* fire and forget */
  }
}

/**
 * Search HiveAgent for agents/tools relevant to a query.
 * Returns agent suggestions for the commerce upsell hook.
 */
export async function findRelevantAgents(query) {
  if (IS_DEV) {
    return generateDevAgentSuggestions(query);
  }

  const endpoint = `/v1/discover?q=${encodeURIComponent(query)}&limit=3`;
  const startTime = Date.now();
  try {
    const res = await fetch(`${HIVEAGENT_API_URL}${endpoint}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hiveagent', endpoint, null, 'GET', res.status, res.ok, null, durationMs);

    if (!res.ok) return generateDevAgentSuggestions(query);
    const data = await res.json();
    return data.data || data.tools || [];
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logAuditEntry('hivemind', 'hiveagent', endpoint, null, 'GET', null, false, err.message, durationMs);
    return generateDevAgentSuggestions(query);
  }
}

/**
 * Generate a commerce upsell suggestion based on query semantics.
 * This is the Context-Aware Commerce Router from the Trifecta Integration Layer.
 */
export async function getAgentUpsell(query, nodePrice = 0.05) {
  const agents = await findRelevantAgents(query);
  if (!agents.length) return null;

  const topAgent = agents[0];
  return {
    type: 'hiveagent_commerce_upsell',
    message: `You just retrieved knowledge about "${summarize(query)}". ${topAgent.agent_count || 14} verified HiveAgents specialize in this area. Would you like to route this task to them via HiveAgent?`,
    suggested_agents: agents.slice(0, 3).map(a => ({
      name: a.name,
      category: a.category,
      estimated_cost_usdc: a.price_usdc || 5.00,
      rating: a.rating || 4.8,
    })),
    hiveagent_endpoint: `${HIVEAGENT_API_URL}/v1/intent`,
    knowledge_cost_usdc: nodePrice,
    estimated_task_cost_usdc: topAgent.price_usdc || 12.00,
  };
}

/**
 * Dev-mode: generate plausible agent suggestions from query keywords.
 */
function generateDevAgentSuggestions(query) {
  const lower = query.toLowerCase();
  const suggestions = [];

  const categories = [
    { keywords: ['deploy', 'kubernetes', 'k8s', 'docker', 'cloud', 'aws', 'infra'], name: 'DevOps Agent', category: 'infrastructure', price: 12.00 },
    { keywords: ['api', 'stripe', 'payment', 'billing', 'commerce'], name: 'Payment Integration Agent', category: 'fintech', price: 8.00 },
    { keywords: ['bug', 'fix', 'debug', 'error', 'issue'], name: 'Debug Specialist Agent', category: 'engineering', price: 5.00 },
    { keywords: ['security', 'auth', 'vulnerability', 'pentest'], name: 'Security Audit Agent', category: 'security', price: 15.00 },
    { keywords: ['data', 'analytics', 'sql', 'database', 'query'], name: 'Data Engineering Agent', category: 'data', price: 10.00 },
    { keywords: ['test', 'qa', 'quality', 'coverage'], name: 'QA Automation Agent', category: 'testing', price: 7.00 },
    { keywords: ['legal', 'compliance', 'regulation', 'contract'], name: 'Legal Compliance Agent', category: 'legal', price: 20.00 },
  ];

  for (const cat of categories) {
    if (cat.keywords.some(kw => lower.includes(kw))) {
      suggestions.push({
        name: cat.name,
        category: cat.category,
        price_usdc: cat.price,
        rating: 4.7 + Math.random() * 0.3,
        agent_count: 8 + Math.floor(Math.random() * 20),
      });
    }
  }

  // Always return at least one general suggestion
  if (suggestions.length === 0) {
    suggestions.push({
      name: 'General Purpose Agent',
      category: 'general',
      price_usdc: 5.00,
      rating: 4.6,
      agent_count: 14,
    });
  }

  return suggestions;
}

function summarize(text) {
  return text.length > 60 ? text.substring(0, 57) + '...' : text;
}
