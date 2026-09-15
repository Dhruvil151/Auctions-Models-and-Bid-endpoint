import r from 'rethinkdb';
import { Database, assertWrite } from './connection.js';

export async function initialize(db: Database): Promise<void> {
  if (!(await db.run(r.dbList())).includes(db.name)) await db.run(r.dbCreate(db.name));
  const tables = await db.run(r.db(db.name).tableList());
  for (const name of ['auctions', 'bid_requests']) {
    if (!tables.includes(name)) await db.run(r.db(db.name).tableCreate(name));
    assertWrite(await db.run(r.db('rethinkdb').table('table_config').filter({ db: db.name, name }).update({ write_acks: 'majority', durability: 'hard' })));
  }
  const requests = db.table('bid_requests');
  if (!(await db.run(requests.indexList())).includes('auction_version')) {
    await db.run(requests.indexCreate('auction_version', (row: r.RDatum) => [row('auction_id'), row('outcome')('body')('auction_version').default(0)]));
  }
  const auctions = db.table('auctions');
  if (!(await db.run(auctions.indexList())).includes('has_pending')) {
    await db.run(auctions.indexCreate('has_pending', (row: r.RDatum) => row('pending_decision').ne(null)));
  }
  await db.run(requests.indexWait());
  await db.run(auctions.indexWait());
}
