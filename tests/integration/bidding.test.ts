import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import r from 'rethinkdb';
import { Database, assertWrite } from '../../src/db/connection.js';
import { initialize } from '../../src/db/initialize.js';
import { BidRepository, requestId } from '../../src/bids/bid.repository.js';
import { BidService, type FaultHooks } from '../../src/bids/bid.service.js';
import { buildApp } from '../../src/app.js';
import type { Auction, BidInput, BidRequest } from '../../src/bids/bid.types.js';

const db = new Database(`auction_test_${randomUUID().replaceAll('-', '')}`);
const otherDb = new Database(db.name);
const repository = new BidRepository(db);
const service = new BidService(repository);
const otherService = new BidService(new BidRepository(otherDb));
const app = buildApp(service, { logger: false, timeoutMs: 45_000 });
const otherApp = buildApp(otherService, { logger: false, timeoutMs: 45_000 });
const deadline = () => performance.now() + 45_000;

async function auction(overrides: Partial<Auction> = {}): Promise<string> {
  const id = randomUUID();
  assertWrite(await db.run(db.table('auctions').insert({
    id, currency: 'INR', opening_amount: 100, opens_at: r.now().sub(60),
    closes_at: r.now().add(3600), created_at: r.now(),
    version: 0, top_bid: null, pending_decision: null, ...overrides,
  })));
  return id;
}
const input = (auction_id: string, amount = 100, user_id = 'user-a'): BidInput => ({ auction_id, amount, user_id });
const post = (body: BidInput, key = randomUUID(), target = app) => target.inject({
  method: 'POST', url: '/bid', headers: { 'idempotency-key': key }, payload: body,
});

async function ledger(id: string): Promise<BidRequest[]> {
  const cursor = await db.run(db.table('bid_requests').filter({ auction_id: id }));
  return cursor.toArray<BidRequest>();
}

beforeAll(async () => { await db.connect(); await initialize(db); await otherDb.connect(); });
afterAll(async () => {
  await app.close(); await otherApp.close();
  // Only the random database created by this suite can be removed.
  if (/^auction_test_[a-f0-9]{32}$/.test(db.name)) await db.run(r.dbDrop(db.name));
  await db.close(); await otherDb.close();
});

describe('business rules and HTTP contract', () => {
  it('accepts opening amount, higher bids and a self-raise; rejects equal/lower bids', async () => {
    const id = await auction();
    expect((await post(input(id, 99))).statusCode).toBe(409);
    expect((await post(input(id))).statusCode).toBe(201);
    expect((await post(input(id))).json().code).toBe('BID_TOO_LOW');
    expect((await post(input(id, 101))).statusCode).toBe(201);
    expect((await post(input(id, 100, 'user-b'))).statusCode).toBe(409);
    expect((await post(input(id, 102, 'user-b'))).statusCode).toBe(201);
    expect((await repository.getAuction(id))?.top_bid).toMatchObject({ amount: 102, user_id: 'user-b' });
  });

  it('stores and replays missing-auction responses', async () => {
    const key = randomUUID();
    const body = input(randomUUID());
    const first = await post(body, key);
    expect(first.statusCode).toBe(404);
    expect((await post(body, key)).body).toBe(first.body);
  });

  it('replays acceptance after outbidding and closure; persists rejections', async () => {
    const id = await auction();
    const body = input(id);
    const key = randomUUID();
    const first = await post(body, key);
    const rejectedKey = randomUUID();
    const rejection = await post(body, rejectedKey);
    await post(input(id, 200, 'user-b'));
    assertWrite(await db.run(db.table('auctions').get(id).update({ closes_at: r.now().sub(1) })));
    expect((await post(body, key)).body).toBe(first.body);
    expect((await post(body, rejectedKey)).body).toBe(rejection.body);
    expect((await post(input(id, 300))).json().code).toBe('AUCTION_CLOSED');
  });

  it('rejects a changed amount or user for an existing key', async () => {
    const id = await auction(); const key = randomUUID();
    await post(input(id), key);
    expect((await post(input(id, 200), key)).json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await post(input(id, 100, 'user-b'), key)).statusCode).toBe(409);
    expect((await repository.getAuction(id))?.version).toBe(1);
  });

  it('scopes idempotency keys to an auction', async () => {
    const key = randomUUID();
    expect((await post(input(await auction()), key)).statusCode).toBe(201);
    expect((await post(input(await auction()), key)).statusCode).toBe(201);
  });

  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null])('rejects invalid amount %s', async (amount) => {
    const response = await app.inject({ method: 'POST', url: '/bid',
      headers: { 'idempotency-key': randomUUID() }, payload: { ...input('auction'), amount } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects missing keys, extra fields, blank IDs and malformed JSON', async () => {
    expect((await app.inject({ method: 'POST', url: '/bid', payload: input('auction') })).statusCode).toBe(400);
    for (const payload of [{ ...input('auction'), extra: 1 }, input(''), { user_id: 'a', amount: 100 }]) {
      expect((await app.inject({ method: 'POST', url: '/bid', headers: { 'idempotency-key': 'valid' }, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/bid', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
  });

  it.each([
    ['before opening', -1, 'AUCTION_NOT_OPEN'],
    ['at opening', 0, 'accepted'],
    ['before closing', 999, 'accepted'],
    ['at closing', 1000, 'AUCTION_CLOSED'],
    ['after closing', 1001, 'AUCTION_CLOSED'],
  ])('enforces the database boundary %s', async (_label, offset, expected) => {
    const opens = new Date('2030-01-01T00:00:00Z');
    const id = await auction({ opens_at: opens, closes_at: new Date(opens.getTime() + 1000) });
    const body = input(id); const key = randomUUID();
    const request = await repository.register(body, key);
    expect(await repository.decide(body, request.id, 0, new Date(opens.getTime() + Number(offset)))).toBe(true);
    const saved = await repository.getAuction(id);
    await service.finalize(id, saved!.pending_decision!);
    const outcome = (await repository.getRequest(request.id))!.outcome!;
    expect(outcome.body.code ?? outcome.body.status).toBe(expected);
  });
});

describe('real database concurrency across independent connections and API instances', () => {
  it('accepts exactly one of 100 equal bids', async () => {
    const id = await auction();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => post(input(id, 100, `user-${i}`), randomUUID(), i % 2 ? app : otherApp)));
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(99);
    expect((await ledger(id))).toHaveLength(100);
    expect((await repository.getAuction(id))?.pending_decision).toBeNull();
  });

  it('orders mixed accepted amounts strictly and finishes at the largest amount', async () => {
    const id = await auction();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => post(input(id, 100 + ((i * 37) % 100), `user-${i}`), randomUUID(), i % 2 ? app : otherApp)));
    expect(responses.every((response) => [201, 409].includes(response.statusCode))).toBe(true);
    const accepted = (await ledger(id)).filter((row) => row.outcome?.statusCode === 201)
      .sort((a, b) => Number(a.outcome!.body.auction_version) - Number(b.outcome!.body.auction_version));
    expect(accepted.length).toBeGreaterThan(0);
    for (let i = 1; i < accepted.length; i++) expect(accepted[i]!.amount).toBeGreaterThan(accepted[i - 1]!.amount);
    expect((await repository.getAuction(id))?.top_bid?.amount).toBe(199);
  });

  it('converges 100 simultaneous retries onto exactly one outcome', async () => {
    const id = await auction(); const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => post(input(id), key, i % 2 ? app : otherApp)));
    expect(responses.every((response) => response.statusCode === 201 && response.body === responses[0]!.body)).toBe(true);
    expect(await ledger(id)).toHaveLength(1);
    expect((await repository.getAuction(id))?.version).toBe(1);
  });

  it('resolves concurrently conflicting payloads for one key', async () => {
    const id = await auction(); const key = randomUUID();
    const responses = await Promise.all([post(input(id, 100), key), post(input(id, 200), key, otherApp)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await repository.getAuction(id))?.version).toBe(1);
  });

  it('progresses independently on many auctions', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, () => auction()));
    const responses = await Promise.all(ids.map((id, i) => post(input(id), randomUUID(), i % 2 ? app : otherApp)));
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
  });
});

describe('crash recovery and stale actors', () => {
  it.each(['afterRegistration', 'afterDecision', 'afterOutcome', 'afterClear'] as const)('recovers interruption at %s', async (point) => {
    const id = await auction(); const key = randomUUID(); const body = input(id);
    const hooks: FaultHooks = { [point]: async () => { throw new Error('Simulated process interruption'); } };
    const interrupted = new BidService(repository, hooks);
    await expect(interrupted.bid(body, key, deadline())).rejects.toThrow('Simulated');
    const result = await otherService.bid(body, key, deadline());
    expect(result.statusCode).toBe(201);
    expect((await repository.getAuction(id))?.version).toBe(1);
    expect(await ledger(id)).toHaveLength(1);
    // A replay may return before clearing an already archived slot; new work helps it.
    await service.bid(input(id, 101), randomUUID(), deadline());
    expect((await repository.getAuction(id))?.pending_decision).toBeNull();
  });

  it('a different bidder helps finish an interrupted decision before bidding', async () => {
    const id = await auction(); const key = randomUUID();
    const interrupted = new BidService(repository, { afterDecision: async () => { throw new Error('crash'); } });
    await expect(interrupted.bid(input(id), key, deadline())).rejects.toThrow('crash');
    expect((await otherService.bid(input(id, 200, 'user-b'), randomUUID(), deadline())).statusCode).toBe(201);
    expect((await service.bid(input(id), key, deadline())).statusCode).toBe(201);
    expect((await repository.getAuction(id))?.top_bid?.amount).toBe(200);
  });

  it('fences a delayed duplicate after another process completes the same request', async () => {
    const id = await auction(); const key = randomUUID();
    let release!: () => void; let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new BidService(repository, { beforeDecision: async () => { reached(); await resume; } });
    const pending = delayed.bid(input(id), key, deadline());
    await paused;
    const first = await otherService.bid(input(id), key, deadline());
    release();
    expect(await pending).toEqual(first);
    expect((await repository.getAuction(id))?.version).toBe(1);
  });

  it('a stale recovery helper cannot clear a newer decision', async () => {
    const id = await auction(); const firstBody = input(id);
    const first = await repository.register(firstBody, randomUUID());
    await repository.decide(firstBody, first.id, 0);
    const oldDecision = (await repository.getAuction(id))!.pending_decision!;
    await service.finalize(id, oldDecision);
    const nextBody = input(id, 200);
    const next = await repository.register(nextBody, randomUUID());
    await repository.decide(nextBody, next.id, 1);
    await service.finalize(id, oldDecision);
    expect((await repository.getAuction(id))?.pending_decision?.request_id).toBe(next.id);
    await service.finalize(id, (await repository.getAuction(id))!.pending_decision!);
  });

  it('keeps a pending decision when outcome persistence fails', async () => {
    const id = await auction(); const key = randomUUID(); const body = input(id);
    class BrokenRepository extends BidRepository {
      override async saveOutcome(): Promise<void> { throw new Error('ledger unavailable'); }
    }
    await expect(new BidService(new BrokenRepository(db)).bid(body, key, deadline())).rejects.toThrow('ledger unavailable');
    expect((await repository.getAuction(id))?.pending_decision?.request_id).toBe(requestId(id, key));
    expect((await service.bid(body, key, deadline())).statusCode).toBe(201);
  });
});
