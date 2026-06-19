import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs() { return Date.now(); }

async function withRetry(fn, retries = 3, baseDelay = 100) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) throw e;
      const jitter = Math.random() * 50;
      const delay = baseDelay * Math.pow(2, attempt) + jitter;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};

  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  if (idem) {
    try {
      const existing = await withRetry(() => getByIdemKey(idem));
      if (existing) return reply.send(existing);
    } catch (e) {
      req.log.error({ err: e, ctx: 'getByIdemKey' });
      return reply.code(503).send({ error: 'db_unavailable' });
    }
  }

  try {
    const t = nowMs();
    const info = await withRetry(() => insertSignal(userId, type, payload, idem, t));
    return reply.code(201).send({
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: idem,
      createdAt: t
    });
  } catch (e) {
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return reply.send({ items: rows });
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
