export interface BidInput { auction_id: string; user_id: string; amount: number }
export interface Outcome { statusCode: number; body: Record<string, string | number> }
export interface TopBid { bid_id: string; user_id: string; amount: number; accepted_at: string }
export interface Decision { request_id: string; version: number; outcome: Outcome }
export interface Auction {
  id: string; currency: string; opening_amount: number;
  opens_at: Date; closes_at: Date; top_bid: TopBid | null;
  version: number; pending_decision: Decision | null; created_at: Date;
}
export interface BidRequest extends BidInput {
  id: string; idempotency_key: string; outcome: Outcome | null; created_at: Date;
}
