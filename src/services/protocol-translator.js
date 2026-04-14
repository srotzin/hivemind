/**
 * Protocol Translator Service — Agentic Clearinghouse
 *
 * Translates between external agent protocols and Hive internal format.
 * Supported protocols: A2A (Google), x402 (Coinbase), AP2, Hive-native.
 *
 * This is "Grand Central Station" — any agent, any protocol, one Hive.
 */

import { v4 as uuidv4 } from 'uuid';

// ─── Supplier Registry (in-memory) ──────────────────────────────────

const suppliers = new Map();     // did -> supplier profile
const translations = new Map();  // request_id -> translation record
const handshakes = new Map();    // handshake_id -> negotiation state

// ─── Protocol Detection ─────────────────────────────────────────────

const SUPPORTED_PROTOCOLS = ['a2a', 'x402', 'ap2', 'hive'];

/**
 * Detect which protocol an incoming message uses.
 */
export function detectProtocol(message, headers = {}) {
  // A2A: JSON-RPC 2.0 with tasks/* methods
  if (message.jsonrpc === '2.0' && message.method && message.method.startsWith('tasks/')) {
    return 'a2a';
  }

  // x402: Has paymentRequirements or payment-related structure
  if (message.paymentRequirements || message.resource || headers['payment-signature']) {
    return 'x402';
  }

  // AP2: REST-based with tasks/steps/artifacts shape
  if (message.task_id && (message.steps || message.artifacts || message.input)) {
    return 'ap2';
  }

  // Hive native: Has DID + content or query fields
  if (message.did || message.content || message.query || message.tier) {
    return 'hive';
  }

  // Explicit protocol field
  if (message.protocol && SUPPORTED_PROTOCOLS.includes(message.protocol)) {
    return message.protocol;
  }

  return null;
}

// ─── A2A → Hive ────────────────────────────────────────────────────

function translateA2AToHive(message) {
  const requestId = `req_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  // Extract parts from A2A message
  const params = message.params || {};
  const parts = params.message?.parts || [];

  let content = '';
  let payload = null;
  const attachments = [];

  for (const part of parts) {
    if (part.type === 'text') {
      content += (content ? '\n' : '') + part.text;
    } else if (part.type === 'data') {
      payload = part.data;
    } else if (part.type === 'file') {
      attachments.push({ name: part.file?.name, uri: part.file?.uri, mimeType: part.file?.mimeType });
    }
  }

  // Resolve agent URL to source DID via supplier registry
  const agentUrl = params.agent?.url || params.url;
  let sourceDid = null;
  for (const [did, supplier] of suppliers) {
    if (supplier.endpoint_url === agentUrl) {
      sourceDid = did;
      break;
    }
  }

  const hiveMessage = {
    request_id: requestId,
    source_did: sourceDid,
    source_protocol: 'a2a',
    content,
    payload,
    attachments,
    metadata: {
      a2a_task_id: params.id || message.id,
      a2a_method: message.method,
      a2a_agent_url: agentUrl,
    },
    routing: suggestRoute(content, payload),
    translated_at: new Date().toISOString(),
  };

  return hiveMessage;
}

// ─── Hive → A2A ────────────────────────────────────────────────────

function translateHiveToA2A(hiveMessage) {
  const parts = [];

  if (hiveMessage.content) {
    parts.push({ type: 'text', text: hiveMessage.content });
  }
  if (hiveMessage.payload) {
    parts.push({ type: 'data', data: hiveMessage.payload });
  }
  if (hiveMessage.attachments) {
    for (const att of hiveMessage.attachments) {
      parts.push({ type: 'file', file: { name: att.name, uri: att.uri, mimeType: att.mimeType } });
    }
  }

  return {
    jsonrpc: '2.0',
    method: 'tasks/send',
    params: {
      id: hiveMessage.request_id,
      message: { role: 'user', parts },
    },
    id: hiveMessage.metadata?.a2a_task_id || hiveMessage.request_id,
  };
}

// ─── x402 → Hive ───────────────────────────────────────────────────

function translateX402ToHive(message, headers = {}) {
  const requestId = `req_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  const hiveMessage = {
    request_id: requestId,
    source_protocol: 'x402',
    target_endpoint: message.resource || null,
    content: message.description || message.body || null,
    payload: message.data || null,
    metadata: {
      payment_info: message.paymentRequirements || null,
      payment_signature: headers['payment-signature'] || null,
      x402_resource: message.resource,
    },
    routing: suggestRoute(message.description || message.body, message.data),
    translated_at: new Date().toISOString(),
  };

  return hiveMessage;
}

// ─── Hive → x402 ───────────────────────────────────────────────────

function translateHiveToX402(hiveMessage, priceUsdc = 0.01) {
  return {
    resource: hiveMessage.target_endpoint || `/v1/clearinghouse/relay`,
    description: hiveMessage.content,
    data: hiveMessage.payload,
    paymentRequirements: {
      scheme: 'exact',
      network: 'eip155:8453',
      maxAmountRequired: String(Math.ceil(priceUsdc * 1_000_000)),
      asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    },
  };
}

// ─── AP2 → Hive ────────────────────────────────────────────────────

function translateAP2ToHive(message) {
  const requestId = `req_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  const hiveMessage = {
    request_id: requestId,
    source_protocol: 'ap2',
    content: message.input || null,
    payload: message.additional_input || null,
    attachments: (message.artifacts || []).map(a => ({
      name: a.file_name || a.artifact_id,
      uri: a.uri,
      mimeType: a.mime_type,
      content: a.parts ? a.parts.map(p => p.text || p.data).join('\n') : null,
    })),
    pipeline_stages: (message.steps || []).map(s => ({
      step_id: s.step_id,
      name: s.name,
      status: s.status,
      output: s.output,
    })),
    metadata: {
      ap2_task_id: message.task_id,
      ap2_status: message.status,
    },
    routing: suggestRoute(message.input, message.additional_input),
    translated_at: new Date().toISOString(),
  };

  return hiveMessage;
}

// ─── Hive → AP2 ────────────────────────────────────────────────────

function translateHiveToAP2(hiveMessage) {
  return {
    task_id: hiveMessage.request_id,
    input: hiveMessage.content,
    additional_input: hiveMessage.payload,
    status: hiveMessage.status || 'submitted',
    artifacts: (hiveMessage.attachments || []).map(a => ({
      artifact_id: a.name,
      file_name: a.name,
      uri: a.uri,
      mime_type: a.mimeType,
      parts: a.content ? [{ type: 'text', text: a.content }] : [],
    })),
    steps: (hiveMessage.pipeline_stages || []).map(s => ({
      step_id: s.step_id,
      name: s.name,
      status: s.status,
      output: s.output,
    })),
  };
}

// ─── Hive Native (pass-through) ────────────────────────────────────

function translateHiveToHive(message) {
  const requestId = message.request_id || `req_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  return {
    ...message,
    request_id: requestId,
    source_protocol: 'hive',
    routing: suggestRoute(message.content, message.payload),
    translated_at: new Date().toISOString(),
  };
}

// ─── Route Suggestion ──────────────────────────────────────────────

function suggestRoute(content, payload) {
  const text = `${content || ''} ${JSON.stringify(payload || '')}`.toLowerCase();

  if (text.includes('memory') || text.includes('store') || text.includes('recall')) {
    return { endpoint: '/v1/memory/store', service: 'memory' };
  }
  if (text.includes('query') || text.includes('search') || text.includes('find')) {
    return { endpoint: '/v1/memory/query', service: 'memory' };
  }
  if (text.includes('publish') || text.includes('marketplace') || text.includes('knowledge')) {
    return { endpoint: '/v1/global_hive/publish', service: 'global_hive' };
  }
  if (text.includes('purchase') || text.includes('buy') || text.includes('acquire')) {
    return { endpoint: '/v1/global_hive/purchase', service: 'global_hive' };
  }
  if (text.includes('agent') || text.includes('discover') || text.includes('browse')) {
    return { endpoint: '/v1/global_hive/browse', service: 'global_hive' };
  }
  if (text.includes('procure') || text.includes('supply') || text.includes('order') || text.includes('catalog')) {
    return { endpoint: '/v1/clearinghouse/route', service: 'clearinghouse' };
  }

  return { endpoint: '/v1/memory/store', service: 'memory' };
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Translate an incoming message from any protocol to Hive internal format.
 */
export function translateToHive(message, headers = {}) {
  const protocol = detectProtocol(message, headers);
  if (!protocol) {
    return { error: 'unrecognized_protocol', message: 'Could not detect source protocol. Supported: a2a, x402, ap2, hive' };
  }

  let translated;
  switch (protocol) {
    case 'a2a':
      translated = translateA2AToHive(message);
      break;
    case 'x402':
      translated = translateX402ToHive(message, headers);
      break;
    case 'ap2':
      translated = translateAP2ToHive(message);
      break;
    case 'hive':
      translated = translateHiveToHive(message);
      break;
    default:
      return { error: 'unsupported_protocol', message: `Protocol '${protocol}' is not supported` };
  }

  // Record translation
  translations.set(translated.request_id, {
    request_id: translated.request_id,
    source_protocol: protocol,
    translated_at: translated.translated_at,
    message_hash: simpleHash(JSON.stringify(message)),
  });

  return translated;
}

/**
 * Translate a Hive internal message to an external protocol format.
 */
export function translateFromHive(hiveMessage, targetProtocol, options = {}) {
  switch (targetProtocol) {
    case 'a2a':
      return translateHiveToA2A(hiveMessage);
    case 'x402':
      return translateHiveToX402(hiveMessage, options.priceUsdc);
    case 'ap2':
      return translateHiveToAP2(hiveMessage);
    case 'hive':
      return hiveMessage;
    default:
      return { error: 'unsupported_protocol', message: `Target protocol '${targetProtocol}' is not supported` };
  }
}

// ─── Supplier Registry ─────────────────────────────────────────────

/**
 * Register a supplier agent.
 */
export function registerSupplier(profile) {
  const {
    supplier_did,
    name,
    protocol,
    capabilities = [],
    endpoint_url,
    catalog_format,
    payment_methods = [],
  } = profile;

  const record = {
    supplier_did,
    name,
    protocol,
    capabilities,
    endpoint_url,
    catalog_format: catalog_format || null,
    payment_methods,
    registered_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    status: 'active',
    requests_handled: 0,
  };

  suppliers.set(supplier_did, record);
  return record;
}

/**
 * Get all registered suppliers.
 */
export function getSuppliers() {
  return Array.from(suppliers.values());
}

/**
 * Get a specific supplier by DID.
 */
export function getSupplier(did) {
  return suppliers.get(did) || null;
}

// ─── Routing Engine ────────────────────────────────────────────────

/**
 * Route a procurement request to the best matching suppliers.
 */
export function routeRequest({ request_type, products = [], urgency, budget_usdc, preferred_protocol }) {
  const routingId = `route_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  const allSuppliers = getSuppliers();

  if (allSuppliers.length === 0) {
    return {
      routing_id: routingId,
      status: 'no_suppliers',
      message: 'No suppliers registered. Use /v1/clearinghouse/register-supplier to add suppliers.',
      matched_suppliers: [],
      routing_plan: null,
    };
  }

  // Score suppliers by capability match + protocol preference
  const scored = allSuppliers.map(supplier => {
    let score = 0;

    // Capability match
    const capabilitySet = new Set(supplier.capabilities.map(c => c.toLowerCase()));
    for (const product of products) {
      const productLower = product.toLowerCase();
      for (const cap of capabilitySet) {
        if (cap.includes(productLower) || productLower.includes(cap)) {
          score += 10;
        }
      }
    }

    // Request type match
    if (request_type) {
      for (const cap of capabilitySet) {
        if (cap.includes(request_type.toLowerCase())) {
          score += 5;
        }
      }
    }

    // Protocol preference bonus
    if (preferred_protocol && supplier.protocol === preferred_protocol) {
      score += 3;
    }

    // Active supplier bonus
    if (supplier.status === 'active') {
      score += 1;
    }

    return { supplier, score };
  });

  // Sort by score descending, filter to positive matches
  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  // Build routing plan
  const routingPlan = matched.slice(0, 5).map(({ supplier, score }) => ({
    supplier_did: supplier.supplier_did,
    name: supplier.name,
    protocol: supplier.protocol,
    endpoint_url: supplier.endpoint_url,
    match_score: score,
    estimated_cost_usdc: budget_usdc ? Math.min(budget_usdc, 0.05) : 0.05,
    translation_required: supplier.protocol !== 'hive',
  }));

  return {
    routing_id: routingId,
    status: matched.length > 0 ? 'routed' : 'no_match',
    request: { request_type, products, urgency, budget_usdc, preferred_protocol },
    matched_suppliers: routingPlan,
    total_matches: matched.length,
    routing_plan: routingPlan.length > 0 ? {
      primary: routingPlan[0],
      alternatives: routingPlan.slice(1),
      strategy: urgency === 'critical' ? 'parallel_fanout' : 'sequential_fallback',
    } : null,
    routed_at: new Date().toISOString(),
  };
}

// ─── Protocol Negotiation (Handshake) ──────────────────────────────

/**
 * Negotiate protocol capabilities between two agents.
 */
export function negotiateHandshake({ initiator_did, target_did, proposed_protocols = [] }) {
  const handshakeId = `hs_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  // Get target supplier info
  const targetSupplier = suppliers.get(target_did);

  // Determine agreed protocol
  let agreedProtocol = null;
  let connectionParams = {};

  if (targetSupplier) {
    // Check if any proposed protocol matches supplier's native protocol
    if (proposed_protocols.includes(targetSupplier.protocol)) {
      agreedProtocol = targetSupplier.protocol;
    } else if (proposed_protocols.length > 0) {
      // Default to first proposed — clearinghouse will translate
      agreedProtocol = proposed_protocols[0];
    }

    connectionParams = {
      endpoint: targetSupplier.endpoint_url,
      protocol: agreedProtocol || targetSupplier.protocol,
      translation_needed: agreedProtocol !== targetSupplier.protocol,
      translator_endpoint: '/v1/clearinghouse/translate',
      relay_endpoint: '/v1/clearinghouse/relay',
    };
  } else {
    // Target not registered — suggest Hive native through clearinghouse
    agreedProtocol = proposed_protocols.includes('hive') ? 'hive' : (proposed_protocols[0] || 'hive');
    connectionParams = {
      endpoint: '/v1/clearinghouse/relay',
      protocol: agreedProtocol,
      translation_needed: true,
      translator_endpoint: '/v1/clearinghouse/translate',
      note: 'Target agent not registered. Messages will be queued via clearinghouse relay.',
    };
  }

  const record = {
    handshake_id: handshakeId,
    initiator_did,
    target_did,
    proposed_protocols,
    agreed_protocol: agreedProtocol,
    connection_params: connectionParams,
    status: agreedProtocol ? 'agreed' : 'pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(), // 5 min TTL
  };

  handshakes.set(handshakeId, record);
  return record;
}

// ─── Relay (End-to-End Proxy) ──────────────────────────────────────

/**
 * Relay a message: translate → send to supplier → translate response back.
 */
export async function relayMessage({ source_protocol, target_did, message, headers = {} }) {
  const relayId = `relay_${uuidv4().replace(/-/g, '').substring(0, 12)}`;

  // Step 1: Translate incoming to Hive format
  const hiveMessage = translateToHive(message, headers);
  if (hiveMessage.error) {
    return { relay_id: relayId, status: 'translation_failed', error: hiveMessage };
  }

  // Step 2: Find target supplier
  const targetSupplier = suppliers.get(target_did);
  if (!targetSupplier) {
    return {
      relay_id: relayId,
      status: 'target_not_found',
      error: `Supplier ${target_did} not registered in clearinghouse`,
      translated_message: hiveMessage,
    };
  }

  // Step 3: Translate to target's native protocol
  const outbound = translateFromHive(hiveMessage, targetSupplier.protocol);

  // Step 4: Attempt delivery to supplier endpoint
  let supplierResponse = null;
  let deliveryStatus = 'pending';

  if (targetSupplier.endpoint_url) {
    try {
      const res = await fetch(targetSupplier.endpoint_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(outbound),
        signal: AbortSignal.timeout(15000),
      });
      supplierResponse = await res.json();
      deliveryStatus = res.ok ? 'delivered' : 'delivery_error';

      // Update supplier last_seen
      targetSupplier.last_seen = new Date().toISOString();
      targetSupplier.requests_handled++;
    } catch (err) {
      deliveryStatus = 'delivery_failed';
      supplierResponse = { error: err.message };
    }
  } else {
    deliveryStatus = 'no_endpoint';
  }

  // Step 5: Translate response back to source protocol if delivered
  let translatedResponse = null;
  if (supplierResponse && deliveryStatus === 'delivered' && source_protocol) {
    translatedResponse = translateFromHive(
      { ...hiveMessage, payload: supplierResponse, status: 'completed' },
      source_protocol,
    );
  }

  return {
    relay_id: relayId,
    status: deliveryStatus,
    source_protocol: hiveMessage.source_protocol,
    target_protocol: targetSupplier.protocol,
    target_did,
    outbound_message: outbound,
    supplier_response: supplierResponse,
    translated_response: translatedResponse,
    relayed_at: new Date().toISOString(),
  };
}

// ─── Diagnostics ───────────────────────────────────────────────────

export function getClearinghouseStats() {
  return {
    suppliers_registered: suppliers.size,
    translations_processed: translations.size,
    active_handshakes: Array.from(handshakes.values()).filter(h => h.status === 'agreed').length,
    supported_protocols: SUPPORTED_PROTOCOLS,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return 'h_' + Math.abs(hash).toString(16);
}
