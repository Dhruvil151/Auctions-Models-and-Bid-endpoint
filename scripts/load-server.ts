import { Database } from '../src/db/connection.js';
import { BidRepository } from '../src/bids/bid.repository.js';
import { BidService } from '../src/bids/bid.service.js';
import { buildApp } from '../src/app.js';

const db = new Database();
await db.connect();
const app = buildApp(new BidService(new BidRepository(db)), { logger: false });
app.addHook('onClose', () => db.close());
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ address });
process.once('message', () => { void app.close().then(() => process.disconnect?.()); });
