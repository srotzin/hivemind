import { pool, isPostgresEnabled } from '../services/db.js';

/**
 * Audit logging middleware.
 * Intercepts res.end() to capture status code and duration after response completes.
 * Logs to public.audit_log table. Fire-and-forget — logging failure never crashes the request.
 */
export function auditLogger(req, res, next) {
  const start = Date.now();
  const originalEnd = res.end;

  res.end = function (...args) {
    res.end = originalEnd;
    res.end(...args);

    // Fire-and-forget audit log insert
    if (!isPostgresEnabled()) return;

    const duration = Date.now() - start;
    const did = req.agentDid || req.headers['x-hivetrust-did'] || null;
    const statusCode = res.statusCode;
    const success = statusCode >= 200 && statusCode < 400;

    pool.query(
      `INSERT INTO public.audit_log (from_platform, to_platform, endpoint, did, method, status_code, success, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['external', 'hivemind', req.originalUrl, did, req.method, statusCode, success, duration]
    ).catch(err => {
      console.error('[audit-logger] Failed to write audit log:', err.message);
    });
  };

  next();
}
