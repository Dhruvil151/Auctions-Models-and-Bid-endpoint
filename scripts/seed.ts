import r from 'rethinkdb';
import { Database, assertWrite } from '../src/db/connection.js';

const db = new Database();
try {
  await db.connect(1);
  const id = process.argv[2] ?? 'demo-auction';
  const result = await db.run(db.table('auctions').insert({
    id, currency: 'INR', opening_amount: 100,
    opens_at: r.now(), closes_at: r.now().add(3600),
    top_bid: null, version: 0, pending_decision: null, created_at: r.now(),
  }, { conflict: 'error', durability: 'hard' }));
  assertWrite(result);
  console.log(`Created ${id}: INR, opening amount 100 paise, closes in one hour.`);
} finally { await db.close(); }
