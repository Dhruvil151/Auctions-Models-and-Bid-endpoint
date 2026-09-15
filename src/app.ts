import Fastify from 'fastify';
import { config } from './config.js';
import { BidService } from './bids/bid.service.js';
import type { BidInput } from './bids/bid.types.js';
import { ApiError, unavailable } from './shared/errors.js';
import { Admission } from './shared/admission.js';

export function buildApp(service: BidService, options: { logger?: boolean; timeoutMs?: number; maxActive?: number; maxQueued?: number } = {}) {
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 4096,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  const admission = new Admission(options.maxActive ?? config.maxActiveBids, options.maxQueued ?? config.maxQueuedBids);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode === 503) reply.header('Retry-After', '1');
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    const failure = error as { validation?: unknown; statusCode?: number };
    if (failure.validation || (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500)) {
      return reply.code(failure.statusCode ?? 400).send({ code: 'INVALID_REQUEST', message: 'Invalid JSON body, fields, or Idempotency-Key header.' });
    }
    request.log.error({ err: error }, 'Bid outcome unavailable');
    return reply.header('Retry-After', '1').code(503).send({ code: 'RETRY_REQUIRED', message: 'Result unavailable. Retry with the same Idempotency-Key.' });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.post<{ Body: BidInput; Headers: { 'idempotency-key': string } }>('/bid', {
    schema: {
      headers: {
        type: 'object', required: ['idempotency-key'],
        properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' } },
      },
      body: {
        type: 'object', additionalProperties: false, required: ['auction_id', 'user_id', 'amount'],
        properties: {
          auction_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          user_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
      },
    },
  }, async (request, reply) => {
    const deadline = performance.now() + (options.timeoutMs ?? config.bidTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(unavailable()), Math.max(1, deadline - performance.now()));
    });
    try {
      // A response deadline does not cancel a possibly committed write. The
      // admission permit stays held until that workflow actually finishes.
      const outcome = await Promise.race([
        admission.run(deadline, () => service.bid(request.body, request.headers['idempotency-key'], deadline)),
        timeout,
      ]);
      return reply.code(outcome.statusCode).send(outcome.body);
    } finally { clearTimeout(timer); }
  });
  return app;
}
