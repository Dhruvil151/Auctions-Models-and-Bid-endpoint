import { setTimeout as delay } from 'node:timers/promises';
import type { BidInput, Decision, Outcome } from './bid.types.js';
import { BidRepository } from './bid.repository.js';
import { unavailable } from '../shared/errors.js';

export interface FaultHooks {
  afterRegistration?: () => Promise<void>;
  beforeDecision?: () => Promise<void>;
  afterDecision?: () => Promise<void>;
  afterOutcome?: () => Promise<void>;
  afterClear?: () => Promise<void>;
}

export class BidService {
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
        await this.hooks.beforeDecision?.();
        if (performance.now() >= deadline) throw unavailable();
        if (await this.repository.decide(input, request.id, auction.version)) {
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
