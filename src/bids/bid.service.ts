import { setTimeout as delay } from 'node:timers/promises';
import type { BidInput, Decision, Outcome } from './bid.types.js';
import { BidRepository } from './bid.repository.js';
import { unavailable } from '../shared/errors.js';
import { Admission } from '../shared/admission.js';
import { config } from '../config.js';

export interface FaultHooks {
  afterRegistration?: () => Promise<void>;
  beforeDecision?: () => Promise<void>;
  afterDecision?: () => Promise<void>;
  afterOutcome?: () => Promise<void>;
  afterClear?: () => Promise<void>;
}

export class BidService {
  private readonly decisions = new Admission(config.maxActiveBids, config.maxQueuedBids);
  constructor(readonly repository: BidRepository, private readonly hooks: FaultHooks = {}) {}

  async finalize(auctionId: string, decision: Decision): Promise<void> {
    await this.repository.saveOutcome(decision.request_id, decision.outcome);
    await this.hooks.afterOutcome?.();
    await this.repository.clearDecision(auctionId, decision);
    await this.hooks.afterClear?.();
  }

  async bid(input: BidInput, key: string, deadline: number): Promise<Outcome> {
    let request = await this.repository.register(input, key);
    await this.hooks.afterRegistration?.();
    if (request.outcome) return request.outcome;

    for (let attempt = 0; performance.now() < deadline; attempt++) {
      // Read auction BEFORE the request: this order plus the version CAS fences
      // a delayed duplicate whose outcome is completed by a different process.
      const auction = await this.repository.getAuction(input.auction_id);
      if (!auction) {
        const outcome = { statusCode: 404, body: { code: 'AUCTION_NOT_FOUND', message: 'Auction does not exist.' } };
        await this.repository.saveOutcome(request.id, outcome);
        return (await this.repository.getRequest(request.id))!.outcome!;
      }
      if (auction.pending_decision) {
        await this.finalize(auction.id, auction.pending_decision);
      } else {
        request = await this.repository.checkedRequest(request.id, input, key);
        if (request.outcome) return request.outcome;
        // The top amount never decreases and opening_amount is immutable. A
        // bid already too low cannot become valid, so its rejection need not
        // write the hot auction document. The ordered reads above are essential:
        // a duplicate of an accepted bid must see its completed ledger outcome.
        const tooLow = auction.top_bid ? input.amount <= auction.top_bid.amount : input.amount < auction.opening_amount;
        if (tooLow) {
          const outcome: Outcome = { statusCode: 409, body: {
            code: 'BID_TOO_LOW', message: 'Bid must meet the opening amount and exceed the current top bid.',
            auction_id: auction.id, auction_version: auction.version,
          } };
          return this.repository.saveOutcome(request.id, outcome, true);
        }
        await this.hooks.beforeDecision?.();
        if (performance.now() >= deadline) throw unavailable();
        if (await this.decisions.run(deadline, () => this.repository.decide(input, request.id, auction.version), auction.id)) {
          await this.hooks.afterDecision?.();
          const decided = await this.repository.getAuction(auction.id);
          if (decided?.pending_decision?.request_id === request.id) {
            await this.finalize(auction.id, decided.pending_decision);
          }
          const completed = await this.repository.getRequest(request.id);
          if (completed?.outcome) return completed.outcome;
        }
      }
      await delay(Math.random() * Math.min(50, 2 ** Math.min(attempt, 6)));
    }
    throw unavailable();
  }
}
