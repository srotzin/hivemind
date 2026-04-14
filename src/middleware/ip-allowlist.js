/**
 * IP Allowlist middleware for internal endpoints.
 * Reads ALLOWED_INTERNAL_IPS env var (comma-separated).
 * If not set or empty, skips check entirely (backward compatible).
 */
export function ipAllowlist(req, res, next) {
  const allowedRaw = process.env.ALLOWED_INTERNAL_IPS;
  if (!allowedRaw || !allowedRaw.trim()) {
    return next();
  }

  const allowedIps = allowedRaw.split(',').map(ip => ip.trim()).filter(Boolean);
  if (allowedIps.length === 0) {
    return next();
  }

  // Check x-forwarded-for first (Render proxy support), fall back to req.ip
  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.ip;

  if (!allowedIps.includes(clientIp)) {
    console.error(`[ip-allowlist] Blocked request from ${clientIp} to ${req.originalUrl}`);
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'IP address not allowed',
    });
  }

  next();
}
