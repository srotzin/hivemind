/**
 * Agentic Clearinghouse Routes — Universal Protocol Translator
 *
 * "Grand Central Station" for agent interoperability.
 * Any agent speaking A2A (Google), x402 (Coinbase), AP2, or Hive-native
 * can communicate through the clearinghouse.
 *
 * Endpoints:
 *   POST /translate         — Universal protocol translation
 *   POST /register-supplier — Register a supplier agent
 *   POST /route             — Intelligent procurement routing
 *   GET  /suppliers         — List registered suppliers
 *   GET  /supplier/:did     — Get supplier details
 *   POST /handshake         — Protocol capability negotiation
 *   POST /relay             — End-to-end message relay
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import {
  translateToHive,
  translateFromHive,
  detectProtocol,
  registerSupplier,
  getSuppliers,
  getSupplier,
  routeRequest,
  negotiateHandshake,
  relayMessage,
  getClearinghouseStats,
} from '../services/protocol-translator.js';

const router = Router();

// ─── POST /translate ────────────────────────────────────────────────

router.post('/translate', requireDID, requirePayment(0.02, 'Clearinghouse Translation'), async (req, res) => {
  try {
    const { message, target_protocol } = req.body;

    if (!message || typeof message !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'message is required and must be an object containing the protocol message to translate.',
      });
    }

    // Detect and translate to Hive internal format
    const detected = detectProtocol(message, req.headers);
    const translated = translateToHive(message, req.headers);

    if (translated.error) {
      return res.status(400).json({
        success: false,
        error: translated.error,
        detail: translated.message,
        supported_protocols: ['a2a', 'x402', 'ap2', 'hive'],
      });
    }

    // Optionally translate to a target protocol
    let outbound = null;
    if (target_protocol) {
      outbound = translateFromHive(translated, target_protocol);
      if (outbound.error) {
        return res.status(400).json({
          success: false,
          error: outbound.error,
          detail: outbound.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        detected_protocol: detected,
        hive_format: translated,
        outbound_format: outbound,
        routing_suggestion: translated.routing,
      },
      meta: {
        cost_usdc: 0.02,
        note: 'Protocol translation completed. Use routing_suggestion to forward to the appropriate Hive service.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Translation failed.',
      detail: err.message,
    });
  }
});

// ─── POST /register-supplier ───────────────────────────────────────

router.post('/register-supplier', requireDID, requirePayment(0.05, 'Clearinghouse Supplier Registration'), async (req, res) => {
  try {
    const { supplier_did, name, protocol, capabilities, endpoint_url, catalog_format, payment_methods } = req.body;

    if (!supplier_did || !name || !protocol) {
      return res.status(400).json({
        success: false,
        error: 'supplier_did, name, and protocol are required.',
      });
    }

    const validProtocols = ['a2a', 'x402', 'ap2', 'hive'];
    if (!validProtocols.includes(protocol)) {
      return res.status(400).json({
        success: false,
        error: `Invalid protocol. Must be one of: ${validProtocols.join(', ')}`,
      });
    }

    if (!capabilities || !Array.isArray(capabilities) || capabilities.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'capabilities must be a non-empty array of strings.',
      });
    }

    if (!endpoint_url) {
      return res.status(400).json({
        success: false,
        error: 'endpoint_url is required.',
      });
    }

    const record = registerSupplier({
      supplier_did,
      name,
      protocol,
      capabilities,
      endpoint_url,
      catalog_format,
      payment_methods,
    });

    return res.status(201).json({
      success: true,
      data: record,
      meta: {
        cost_usdc: 0.05,
        note: 'Supplier registered. Other agents can now discover and route requests to this supplier via the clearinghouse.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Supplier registration failed.',
      detail: err.message,
    });
  }
});

// ─── POST /route ────────────────────────────────────────────────────

router.post('/route', requireDID, requirePayment(0.03, 'Clearinghouse Routing'), async (req, res) => {
  try {
    const { request_type, products, urgency, budget_usdc, preferred_protocol } = req.body;

    if (!request_type) {
      return res.status(400).json({
        success: false,
        error: 'request_type is required.',
      });
    }

    const result = routeRequest({
      request_type,
      products: products || [],
      urgency: urgency || 'normal',
      budget_usdc,
      preferred_protocol,
    });

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        cost_usdc: 0.03,
        note: result.status === 'routed'
          ? `Matched ${result.total_matches} supplier(s). Primary: ${result.routing_plan.primary.name}`
          : 'No matching suppliers found. Register suppliers first.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Routing failed.',
      detail: err.message,
    });
  }
});

// ─── GET /suppliers ─────────────────────────────────────────────────

router.get('/suppliers', requireDID, async (req, res) => {
  try {
    const allSuppliers = getSuppliers();
    const stats = getClearinghouseStats();

    return res.status(200).json({
      success: true,
      data: {
        suppliers: allSuppliers,
        total: allSuppliers.length,
        clearinghouse_stats: stats,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to list suppliers.',
      detail: err.message,
    });
  }
});

// ─── GET /supplier/:did ─────────────────────────────────────────────

router.get('/supplier/:did', requireDID, async (req, res) => {
  try {
    const supplier = getSupplier(req.params.did);

    if (!supplier) {
      return res.status(404).json({
        success: false,
        error: `Supplier ${req.params.did} not found in clearinghouse registry.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: supplier,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Failed to get supplier.',
      detail: err.message,
    });
  }
});

// ─── POST /handshake ────────────────────────────────────────────────

router.post('/handshake', requireDID, requirePayment(0.01, 'Clearinghouse Handshake'), async (req, res) => {
  try {
    const { initiator_did, target_did, proposed_protocols } = req.body;

    if (!initiator_did || !target_did) {
      return res.status(400).json({
        success: false,
        error: 'initiator_did and target_did are required.',
      });
    }

    if (!proposed_protocols || !Array.isArray(proposed_protocols) || proposed_protocols.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'proposed_protocols must be a non-empty array.',
      });
    }

    const result = negotiateHandshake({ initiator_did, target_did, proposed_protocols });

    return res.status(200).json({
      success: true,
      data: result,
      meta: {
        cost_usdc: 0.01,
        note: result.status === 'agreed'
          ? `Agreed on protocol: ${result.agreed_protocol}. Connection parameters provided.`
          : 'Handshake pending — target agent may need to confirm.',
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Handshake negotiation failed.',
      detail: err.message,
    });
  }
});

// ─── POST /relay ────────────────────────────────────────────────────

router.post('/relay', requireDID, requirePayment(0.05, 'Clearinghouse Relay'), async (req, res) => {
  try {
    const { source_protocol, target_did, message } = req.body;

    if (!target_did) {
      return res.status(400).json({
        success: false,
        error: 'target_did is required.',
      });
    }

    if (!message || typeof message !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'message is required and must be an object.',
      });
    }

    const result = await relayMessage({
      source_protocol,
      target_did,
      message,
      headers: req.headers,
    });

    const statusCode = result.status === 'delivered' ? 200
      : result.status === 'target_not_found' ? 404
        : result.status === 'translation_failed' ? 400
          : 502;

    return res.status(statusCode).json({
      success: result.status === 'delivered',
      data: result,
      meta: {
        cost_usdc: 0.05,
        note: result.status === 'delivered'
          ? `Message relayed to ${target_did} via ${result.target_protocol} protocol.`
          : `Relay status: ${result.status}`,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Relay failed.',
      detail: err.message,
    });
  }
});

export default router;
