import { buildApp } from './app.js';
import { config } from './config.js';
import { Database } from './db/connection.js';
import { BidRepository } from './bids/bid.repository.js';
import { BidService } from './bids/bid.service.js';

const db = new Database();
await db.connect();
const app = buildApp(new BidService(new BidRepository(db)));
app.addHook('onClose', () => db.close());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void app.close().catch((error: unknown) => { app.log.error(error); process.exitCode = 1; }); });
}
try { await app.listen({ host: config.host, port: config.port }); }
catch (error) { await app.close(); throw error; }
