import { recoverPending } from '../src/recovery/pending-decisions.js';
import { Database } from '../src/db/connection.js';
import { BidRepository } from '../src/bids/bid.repository.js';
import { BidService } from '../src/bids/bid.service.js';

const db = new Database();
try {
  await db.connect();
  const service = new BidService(new BidRepository(db));
  const recovered = await recoverPending(service);
  console.log(`Recovered ${recovered} pending decisions.`);
} finally { await db.close(); }
