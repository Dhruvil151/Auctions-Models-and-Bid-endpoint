import r from 'rethinkdb';
import type { Auction } from '../src/bids/bid.types.js';
import { Database } from '../src/db/connection.js';
import { BidRepository } from '../src/bids/bid.repository.js';
import { BidService } from '../src/bids/bid.service.js';

const db = new Database();
try {
  await db.connect();
  const service = new BidService(new BidRepository(db));
  const cursor = await db.run(db.table('auctions').getAll(r.expr(1), { index: 'has_pending' }));
  let recovered = 0;
  try {
    while (await cursor.hasNext()) {
      const auction = await cursor.next<Auction>();
      if (auction.pending_decision) { await service.finalize(auction.id, auction.pending_decision); recovered++; }
    }
  } finally { await cursor.close(); }
  console.log(`Recovered ${recovered} pending decisions.`);
} finally { await db.close(); }
