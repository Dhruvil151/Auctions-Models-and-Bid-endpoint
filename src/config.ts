import 'dotenv/config';

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: positiveInteger('PORT', 3000),
  dbHost: process.env.DB_HOST ?? '127.0.0.1',
  dbPort: positiveInteger('DB_PORT', 28015),
  dbName: process.env.DB_NAME ?? 'auctions',
  dbUser: process.env.DB_USER ?? 'admin',
  dbPassword: process.env.DB_PASSWORD ?? '',
  dbConnections: positiveInteger('DB_CONNECTIONS', 4),
  bidTimeoutMs: positiveInteger('BID_TIMEOUT_MS', 15_000),
  maxActiveBids: positiveInteger('MAX_ACTIVE_BIDS', 64),
  maxQueuedBids: positiveInteger('MAX_QUEUED_BIDS', 2048),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
