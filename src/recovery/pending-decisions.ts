import r from 'rethinkdb';
import type { Auction } from '../bids/bid.types.js';
import type { BidService } from '../bids/bid.service.js';

export async function recoverPending(service: BidService, batchSize = 100): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid recovery batch size');
  const db = service.repository.db;
  let recovered = 0;
  for (;;) {
    const cursor = await db.run(db.table('auctions').getAll(r.expr(1), { index: 'has_pending' }).limit(batchSize));
    const auctions = await cursor.toArray<Auction>();
    if (auctions.length === 0) return recovered;
    const before = recovered;
    for (const auction of auctions) {
      if (auction.pending_decision) {
        try {
          await service.finalize(auction.id, auction.pending_decision);
          recovered++;
        } catch (error) {
          console.error(`Failed to recover auction ${auction.id}:`, error);
        }
      }
    }
    if (recovered === before) return recovered; // no progress made — stop to avoid infinite loop
  }
}
