import { randomBytes } from 'crypto';

const SVC_VERSION = process.env.SERVICE_VERSION || '1.0.0';

export function ritzId() {
  return 'req_' + randomBytes(8).toString('hex');
}

export function ritzMiddleware(req, res, next) {
  res.locals.requestId = ritzId();
  res.locals.startMs   = Date.now();
  res.setHeader('X-Request-Id',   res.locals.requestId);
  res.setHeader('X-Powered-By',   'TheHiveryIQ');
  res.setHeader('X-Hive-Version', SVC_VERSION);
  next();
}

export function ok(res, service, data, meta = {}, code = 200) {
  return res.status(code).json({
    status:     'success',
    service,
    version:    SVC_VERSION,
    request_id: res.locals.requestId || ritzId(),
    timestamp:  new Date().toISOString(),
    data,
    meta: {
      processing_ms: res.locals.startMs ? Date.now() - res.locals.startMs : null,
      ...meta,
    },
  });
}

export function err(res, service, code, message, httpCode = 400, extra = {}) {
  return res.status(httpCode).json({
    status:     'error',
    service,
    version:    SVC_VERSION,
    request_id: res.locals.requestId || ritzId(),
    timestamp:  new Date().toISOString(),
    error: {
      code,
      message,
      docs: `https://thehiveryiq.com/docs/errors/${code}`,
      ...extra,
    },
  });
}
