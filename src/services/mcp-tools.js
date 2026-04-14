/**
 * MCP Tool Definitions — Agentic Clearinghouse
 *
 * Exposes clearinghouse operations as MCP-compatible tool definitions.
 * These tools can be discovered via GET /v1/mcp/tools and invoked via POST /v1/mcp/invoke.
 */

import {
  translateToHive,
  registerSupplier,
  routeRequest,
} from './protocol-translator.js';
import { storeReceipt } from './receipt-vault.js';

const TOOLS = [
  {
    name: 'hivemind_translate_protocol',
    description: 'Translate an agent message from any supported protocol (A2A, x402, AP2, Hive-native) to Hive internal format. Wraps POST /v1/clearinghouse/translate.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'object',
          description: 'The protocol message to translate. Can be A2A (JSON-RPC 2.0), x402 (payment-required), AP2 (task/step/artifact), or Hive-native format.',
        },
        target_protocol: {
          type: 'string',
          enum: ['a2a', 'x402', 'ap2', 'hive'],
          description: 'Optional target protocol to translate into after converting to Hive format.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'hivemind_route_request',
    description: 'Route a procurement request to the best matching registered suppliers. Wraps POST /v1/clearinghouse/route.',
    inputSchema: {
      type: 'object',
      properties: {
        request_type: {
          type: 'string',
          description: 'Type of procurement request (e.g., "raw_materials", "components", "services").',
        },
        products: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of products or capabilities needed.',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'critical'],
          description: 'Urgency level of the request.',
        },
        budget_usdc: {
          type: 'number',
          description: 'Maximum budget in USDC for this procurement.',
        },
        preferred_protocol: {
          type: 'string',
          enum: ['a2a', 'x402', 'ap2', 'hive'],
          description: 'Preferred communication protocol for the supplier.',
        },
      },
      required: ['request_type'],
    },
  },
  {
    name: 'hivemind_register_supplier',
    description: 'Register a new supplier agent with the Agentic Clearinghouse. Wraps POST /v1/clearinghouse/register-supplier.',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_did: {
          type: 'string',
          description: 'DID of the supplier agent (e.g., did:hive:supplier_acme).',
        },
        name: {
          type: 'string',
          description: 'Human-readable name of the supplier.',
        },
        protocol: {
          type: 'string',
          enum: ['a2a', 'x402', 'ap2', 'hive'],
          description: 'Native protocol the supplier speaks.',
        },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of capabilities/products the supplier offers.',
        },
        endpoint_url: {
          type: 'string',
          description: 'URL of the supplier agent endpoint.',
        },
        catalog_format: {
          type: 'string',
          description: 'Format of the supplier catalog (e.g., "json", "csv").',
        },
        payment_methods: {
          type: 'array',
          items: { type: 'string' },
          description: 'Accepted payment methods (e.g., ["usdc", "x402"]).',
        },
      },
      required: ['supplier_did', 'name', 'protocol', 'capabilities', 'endpoint_url'],
    },
  },
  {
    name: 'hivemind_store_receipt',
    description: 'Store an immutable cryptographic receipt of a transaction in the Receipt Vault. Auto-issues a compliance certificate via HiveLaw. Wraps POST /v1/vault/store-receipt. Costs $0.05 USDC.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: {
          type: 'string',
          description: 'Unique identifier for the transaction being receipted.',
        },
        source_service: {
          type: 'string',
          description: 'Service that originated the transaction (e.g., "hivemind", "hivelaw", "hiveagent").',
        },
        amount_usdc: {
          type: 'number',
          description: 'Transaction amount in USDC.',
        },
        payer_did: {
          type: 'string',
          description: 'DID of the payer (e.g., did:hive:agent_123).',
        },
        payee_did: {
          type: 'string',
          description: 'DID of the payee (optional).',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint where the transaction occurred (optional).',
        },
        payload_hash: {
          type: 'string',
          description: 'SHA-256 hash of the transaction payload (optional).',
        },
        metadata: {
          type: 'object',
          description: 'Additional metadata to store with the receipt (optional).',
        },
      },
      required: ['transaction_id', 'source_service', 'amount_usdc', 'payer_did'],
    },
  },
];

/**
 * Get all MCP tool definitions.
 */
export function getMCPTools() {
  return TOOLS;
}

/**
 * Invoke an MCP tool by name with given arguments.
 */
export async function invokeMCPTool(toolName, args) {
  switch (toolName) {
    case 'hivemind_translate_protocol': {
      const translated = translateToHive(args.message || {}, {});
      return { success: !translated.error, result: translated };
    }
    case 'hivemind_route_request': {
      const result = routeRequest({
        request_type: args.request_type,
        products: args.products || [],
        urgency: args.urgency || 'normal',
        budget_usdc: args.budget_usdc,
        preferred_protocol: args.preferred_protocol,
      });
      return { success: true, result };
    }
    case 'hivemind_register_supplier': {
      const record = registerSupplier({
        supplier_did: args.supplier_did,
        name: args.name,
        protocol: args.protocol,
        capabilities: args.capabilities || [],
        endpoint_url: args.endpoint_url,
        catalog_format: args.catalog_format,
        payment_methods: args.payment_methods || [],
      });
      return { success: true, result: record };
    }
    case 'hivemind_store_receipt': {
      const receipt = await storeReceipt({
        transaction_id: args.transaction_id,
        source_service: args.source_service,
        amount_usdc: args.amount_usdc,
        payer_did: args.payer_did,
        payee_did: args.payee_did,
        endpoint: args.endpoint,
        payload_hash: args.payload_hash,
        metadata: args.metadata,
      });
      return { success: true, result: receipt };
    }
    default:
      return { success: false, error: `Unknown tool: ${toolName}`, available_tools: TOOLS.map(t => t.name) };
  }
}
