import { createHash } from 'node:crypto';
import r from 'rethinkdb';
import { Database, assertWrite } from '../db/connection.js';
import type { Auction, BidInput, BidRequest, Decision, Outcome } from './bid.types.js';
import { ApiError } from '../shared/errors.js';

export function requestId(auctionId: string, key: string): string {
  return createHash('sha256').update(JSON.stringify([auctionId, key])).digest('hex');
}

export class BidRepository {
  constructor(readonly db: Database) {}

  async register(input: BidInput, key: string): Promise<BidRequest> {
    const id = requestId(input.auction_id, key);
    assertWrite(await this.db.run(this.db.table('bid_requests').get(id).replace((existing: r.Row) =>
      r.branch(existing.eq(null), r.expr({
        id, ...input, idempotency_key: key, outcome: null, created_at: r.now(),
      }), existing), { durability: 'hard' })));
    return this.checkedRequest(id, input, key);
  }

  async checkedRequest(id: string, input: BidInput, key: string): Promise<BidRequest> {
    const request = await this.getRequest(id);
    if (!request) throw new Error('Request ledger entry missing');
    if (request.auction_id !== input.auction_id || request.user_id !== input.user_id ||
        request.amount !== input.amount || request.idempotency_key !== key) {
      throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This key already belongs to a different bid.');
    }
    return request;
  }

  async getRequest(id: string): Promise<BidRequest | null> {
    return this.db.run(this.db.table('bid_requests').get(id));
  }

  async getAuction(id: string): Promise<Auction | null> {
    return this.db.run(this.db.table('auctions').get(id));
  }

  /** Test-only time override is internal; the HTTP API cannot provide it. */
  async decide(input: BidInput, id: string, version: number, time?: Date): Promise<boolean> {
    const now = time ? r.expr(time) : r.expr(r.now());
    const query = this.db.table('auctions').get(input.auction_id).update((auction: r.Row) => {
      const next = auction('version').add(1);
      const reject = (code: string, message: string) => r.expr({
        statusCode: 409, body: { code, message, auction_id: input.auction_id, auction_version: next },
      });
      const accepted = r.expr({ statusCode: 201, body: {
        bid_id: id, auction_id: input.auction_id, user_id: input.user_id,
        amount: input.amount, status: 'accepted', auction_version: next,
        accepted_at: now.toISO8601(),
      } });
      const tooLow = r.branch(auction('top_bid').eq(null),
        r.expr(input.amount).lt(auction('opening_amount')),
        r.expr(input.amount).le(auction('top_bid')('amount')));
      const outcome = r.branch(now.lt(auction('opens_at')),
        reject('AUCTION_NOT_OPEN', 'Auction has not opened.'),
        r.branch(now.ge(auction('closes_at')),
          reject('AUCTION_CLOSED', 'Auction is closed.'),
          r.branch(tooLow, reject('BID_TOO_LOW', 'Bid must meet the opening amount and exceed the current top bid.'), accepted)));
      return r.branch(auction('version').eq(version).and(auction('pending_decision').eq(null)),
        r.expr({
          version: next,
          pending_decision: { request_id: id, version: next, outcome },
          top_bid: r.branch(outcome('statusCode').eq(201), r.expr({
            bid_id: id, user_id: input.user_id, amount: input.amount, accepted_at: now.toISO8601(),
          }), auction('top_bid')),
        }), r.expr({}));
    }, { durability: 'hard' });
    const result = await this.db.run(query);
    assertWrite(result);
    return result.replaced === 1;
  }

  async saveOutcome(id: string, outcome: Outcome, replayExisting = false): Promise<Outcome> {
    const result = await this.db.run(this.db.table('bid_requests').get(id).update((request: r.Row) =>
      r.branch(request('outcome').eq(null), r.expr({ outcome, completed_at: r.now() }), r.expr({})),
    { durability: 'hard' }));
    assertWrite(result);
    if (result.skipped) throw new Error('Cannot record outcome: missing request');
    const saved = await this.getRequest(id);
    if (!saved?.outcome) throw new Error('Request outcome missing after write');
    if (!replayExisting && (saved.outcome.statusCode !== outcome.statusCode ||
        Object.keys(saved.outcome.body).length !== Object.keys(outcome.body).length ||
        Object.keys(outcome.body).some((key) => saved.outcome!.body[key] !== outcome.body[key]))) {
      throw new Error('Conflicting request outcomes');
    }
    return saved.outcome;
  }

  async clearDecision(auctionId: string, decision: Decision): Promise<void> {
    assertWrite(await this.db.run(this.db.table('auctions').get(auctionId).update((auction: r.Row) =>
      r.branch(auction('version').eq(decision.version)
        .and(auction('pending_decision')('request_id').default('').eq(decision.request_id)),
      r.expr({ pending_decision: null }), r.expr({})), { durability: 'hard' })));
  }
}
