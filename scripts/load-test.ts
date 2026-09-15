import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import r from 'rethinkdb';
import { Database, assertWrite } from '../src/db/connection.js';
import { initialize } from '../src/db/initialize.js';
import type { Auction, BidRequest } from '../src/bids/bid.types.js';

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
const count = integer('LOAD_REQUESTS', 2000);
const concurrency = Math.min(count, integer('LOAD_CONCURRENCY', 1000));
const auctionCount = integer('LOAD_AUCTIONS', 1);
const instanceCount = integer('LOAD_INSTANCES', 2);
const mode = process.env.LOAD_MODE ?? 'equal';
if (!['equal', 'mixed'].includes(mode)) throw new Error('LOAD_MODE must be equal or mixed');
const db = new Database(`auction_load_${randomUUID().replaceAll('-', '')}`);
const children: ChildProcess[] = [];

async function startServer(): Promise<string> {
  const child = fork(new URL('./load-server.js', import.meta.url), {
    env: { ...process.env, DB_NAME: db.name }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Load server startup timed out')), 15_000);
    child.once('message', (message: { address: string }) => { clearTimeout(timer); resolve(message.address); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Load server exited: ${code}`)); });
  });
}

try {
  await db.connect(); await initialize(db);
  for (let offset = 0; offset < auctionCount; offset += 500) {
    assertWrite(await db.run(db.table('auctions').insert(Array.from({ length: Math.min(500, auctionCount - offset) }, (_, i) => ({
      id: `load-${offset + i}`, currency: 'INR', opening_amount: 100,
      opens_at: r.now().sub(60), closes_at: r.now().add(3600), created_at: r.now(),
      version: 0, top_bid: null, pending_decision: null,
    })))));
  }
  const addresses = await Promise.all(Array.from({ length: instanceCount }, startServer));
  let next = 0;
  const statuses: Record<string, number> = {};
  const latencies: number[] = [];
  const acceptedIds = new Set<string>();
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const i = next++;
      const before = performance.now();
      try {
        const response = await fetch(`${addresses[i % addresses.length]}/bid`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `request-${i}` },
          body: JSON.stringify({ auction_id: `load-${i % auctionCount}`, user_id: `user-${i}`, amount: mode === 'equal' ? 100 : 100 + i }),
          signal: AbortSignal.timeout(60_000),
        });
        const result = await response.json() as { bid_id?: string };
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status === 201 && result.bid_id) acceptedIds.add(result.bid_id);
      } catch { statuses.network_error = (statuses.network_error ?? 0) + 1; }
      latencies.push(performance.now() - before);
    }
  }));
  const duration = performance.now() - started;
  // Closing HTTP servers waits for active handlers before checking durable state.
  for (const child of children) { const exited = once(child, 'exit'); child.send('stop'); await exited; }
  children.length = 0;
  const requests = await (await db.run(db.table('bid_requests'))).toArray<BidRequest>();
  const auctions = await (await db.run(db.table('auctions'))).toArray<Auction>();
  let accepted = 0;
  for (const auction of auctions) {
    const history = requests.filter((request) => request.auction_id === auction.id && request.outcome?.statusCode === 201)
      .sort((a, b) => Number(a.outcome!.body.auction_version) - Number(b.outcome!.body.auction_version));
    accepted += history.length;
    for (let i = 1; i < history.length; i++) assert(history[i]!.amount > history[i - 1]!.amount, 'Accepted amounts must strictly increase');
    const last = history.at(-1);
    assert.equal(auction.top_bid?.bid_id ?? null, last?.id ?? null, 'Top bid must match durable history');
    assert.equal(auction.pending_decision, null, 'No pending decisions after successful completion');
    if (mode === 'equal') assert(history.length <= 1, 'Equal bids cannot both win');
    if ((statuses['201'] ?? 0) + (statuses['409'] ?? 0) === count) {
      const firstIndex = Number(auction.id.slice('load-'.length));
      if (firstIndex < count) {
        const lastIndex = firstIndex + Math.floor((count - 1 - firstIndex) / auctionCount) * auctionCount;
        assert.equal(auction.top_bid?.amount, mode === 'equal' ? 100 : 100 + lastIndex, 'All resolved requests must leave the maximum submitted amount on top');
      }
    }
  }
  for (const id of acceptedIds) assert(requests.some((request) => request.id === id && request.outcome?.statusCode === 201));
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] ?? 0);
  const result = {
    timestamp: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, hostMemoryGiB: Math.round(totalmem() / 1024 ** 3),
    database: 'Local Docker, one replica, hard durability, majority reads/writes',
    requests: count, concurrency, auctions: auctionCount, instances: instanceCount, mode,
    durationMs: Math.round(duration), responsesPerSecond: Math.round(count / (duration / 1000)),
    businessDecisionsPerSecond: Math.round(((statuses['201'] ?? 0) + (statuses['409'] ?? 0)) / (duration / 1000)),
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    statuses, acceptedLedgerEntries: accepted, invariantsPassed: true,
  };
  await mkdir('test-results', { recursive: true });
  const path = `test-results/load-${auctionCount}-${mode}-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`Saved ${path}`);
} finally {
  for (const child of children) child.kill();
  if (/^auction_load_[a-f0-9]{32}$/.test(db.name)) await db.run(r.dbDrop(db.name));
  await db.close();
}
