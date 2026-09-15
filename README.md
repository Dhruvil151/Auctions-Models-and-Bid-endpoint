# Auctions — Models and Bid endpoint

A small Node.js / TypeScript API with durable bid history, idempotent retries, and atomic winner updates under concurrent load.

**Main endpoint:** `POST /bid`  
**Stack:** Node.js 24, TypeScript, Fastify, RethinkDB 2.4, Vitest.

## Run with Docker

Requires Docker with Compose. From this repository:

```sh
docker compose up --build -d
docker compose exec api node dist/scripts/seed.js demo-auction
```

The API listens on `http://localhost:3000`. `GET /health` is a process-liveness check. The seed creates an INR auction that opens immediately and closes in one hour; its opening amount is 100 paise. A duplicate seed ID fails rather than resetting an auction that already has bids. Use a new ID for another demo.

```sh
curl -i http://localhost:3000/bid \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-bid-1' \
  -d '{"auction_id":"demo-auction","user_id":"user-1","amount":12500}'
```

PowerShell equivalent:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/bid `
  -ContentType 'application/json' `
  -Headers @{ 'Idempotency-Key' = 'demo-bid-1' } `
  -Body '{"auction_id":"demo-auction","user_id":"user-1","amount":12500}'
```

Repeat the same request and key to replay its result. Change the key for a new intentional bid.

Stop the services with `docker compose down`. Data remains in the named Docker volume. Ports 3000, 8080 (database admin UI), and 28015 are bound to localhost.

## Run Node.js locally

Requires Node.js 24 and Docker for the database.

```sh
npm ci
docker compose up -d db
npm run db:init
npm run seed -- demo-auction
npm run dev
```

Defaults work without an environment file. Copy `.env.example` to `.env` to customize the port, database connection, logging, or work limits. For a compiled run: `npm run build`, then `npm start`.

Database initialization is an explicit setup step. It creates tables/indexes and configures hard durability with majority write acknowledgements. Run one initializer at a time. The API uses majority reads and does not change the schema at startup.

## API contract

`POST /bid` requires a JSON body containing exactly:

- `auction_id`: 1–128 letters, digits, underscores, or hyphens.
- `user_id`: the same identifier format.
- `amount`: a positive safe integer in the auction currency's minor units. For INR, `12500` means ₹125.00. Fractions, numeric strings, zero, negative values, and unsafe integers are rejected.

The required `Idempotency-Key` header is 1–128 letters, digits, `.`, `_`, `:`, or `-`. Generate a UUID per intentional bid. Keys are scoped to an auction, and reuse with a different user or amount conflicts.

Example accepted response, HTTP **201**:

```json
{
  "bid_id": "deterministic-request-hash",
  "auction_id": "demo-auction",
  "user_id": "user-1",
  "amount": 12500,
  "status": "accepted",
  "auction_version": 1,
  "accepted_at": "2026-09-15T08:00:00.000+00:00"
}
```

Errors contain `code` and `message`:

- **400** `INVALID_REQUEST`: missing/invalid fields or key, malformed JSON. Oversized bodies use 413; unsupported media types use 415.
- **404** `AUCTION_NOT_FOUND`: no auction at the initial registration check; stored for replay.
- **409** `BID_TOO_LOW`, `AUCTION_NOT_OPEN`, `AUCTION_CLOSED`, or `IDEMPOTENCY_KEY_REUSED`.
- **503** `RETRY_REQUIRED`: overload, deadline expiry, unavailable database, or an uncertain write result. Includes `Retry-After: 1`. Retry with the **same key and payload**; a 503 does not prove that the bid failed to commit.

An accepted response means the bid became top at its decision point. Another higher bid may replace it before its HTTP response arrives. Replays return the original status and body, including 201 for an accepted bid.

## Data model and rationale

### `auctions`

- `id`: primary key.
- `currency`, `opening_amount`: auction currency and minimum first bid.
- `opens_at`, `closes_at`: database time values in UTC.
- `top_bid`: `null` or `{ bid_id, user_id, amount, accepted_at }`.
- `version`: increasing number for atomic auction decisions; used to reject stale writers.
- `pending_decision`: `null` or `{ request_id, version, outcome }`.
- `created_at`: database timestamp.

The top bid, deadline, and version are in the same document so they can be checked and changed in one atomic operation. There is one pending slot, not an unbounded array of bids. The `has_pending` secondary index supports recovery.

### `bid_requests`

- `id`: SHA-256 of a JSON-encoded `[auction_id, idempotency_key]` pair.
- `auction_id`, `user_id`, `amount`, `idempotency_key`: immutable request payload.
- `outcome`: initially `null`, then `{ statusCode, body }`.
- `created_at`, `completed_at`: timestamps (`completed_at` is set when a pending request is completed).

Accepted request records are the bid history. Rejected records store retry responses. The compound `auction_version` index supports querying an auction's decision history; select accepted outcomes to retrieve bids. A rejection resolved from an already-too-low snapshot reports that observed version, so rejection versions need not be unique.

Separating history keeps the hot auction document bounded. No users table is required for this exercise: `user_id` is treated as a supplied identifier. Auction IDs are provisioned through setup scripts; live configuration changes, deletion, and ID reuse are outside the API contract. In particular, the opening amount is immutable and the top amount never decreases.

## Concurrency and interrupted writes

Single-document operations can be atomic, but writes spanning the auction and request ledger are not a transaction. The protocol handles that explicitly:

1. Register the request with an atomic create-if-absent operation. Concurrent retries use the same record. A payload conflict returns 409.
2. Return an existing outcome immediately.
3. Read the auction. If it has a pending decision, persist that decision's outcome and then conditionally clear its slot.
4. **After reading the auction**, reread the request outcome. This order matters for delayed duplicate requests.
5. For a potentially winning bid, atomically compare the auction version and require an empty pending slot. In that same update, check the time and amount, record the decision, update the top if accepted, and increment the version.
6. Persist the outcome to the request record before clearing the pending slot. Clearing compares both decision identity and version, so an old helper cannot clear a newer decision.
7. Return the durable outcome. Version conflicts retry with bounded backoff and jitter.

If the process stops after step 5, the pending decision preserves the result. A retry or another bidder can finish steps 6–7. If it stops after the result is saved, replay returns that saved response. The recovery command can finish idle auctions:

```sh
npm run recover
# Or, with the container setup:
docker compose exec api node dist/scripts/recover.js
```

Recovery processes only decisions already made; it does not submit undecided requests on behalf of clients. There is no required in-memory correctness lock or single API process. Hard durability, majority writes, and majority reads provide the database guarantees this protocol relies on. See the upstream [consistency documentation](https://rethinkdb.com/docs/consistency/) and [atomic update semantics](https://rethinkdb.com/api/javascript/update/).

### Safe concurrent low-bid rejection

A bid below the opening amount, or at/below a confirmed top, cannot become valid later because those values cannot decrease. After the ordered auction/request reads, its rejection can be stored directly in its request record without writing the auction. Concurrent copies replay whichever rejection outcome is stored first.

This optimization keeps losing bids from contending on the winner document. Potentially accepted bids always use the atomic check. A too-low bid may return `BID_TOO_LOW` even if the auction is also closed; both reasons are valid, and no winner state changes.

## Auction-close boundary

The acceptance window is:

```text
opens_at <= database decision-query time < closes_at
```

At exactly `closes_at`, a new bid is rejected. Client clocks and HTTP arrival/response times do not determine eligibility. The database's `now()` is fixed when the decision query starts; an eligible query may commit or respond after the wall-clock deadline. A request waiting in an application queue gets its time when its actual decision query starts. See [database time semantics](https://rethinkdb.com/api/javascript/now/).

No scheduled close job is required to reject late bids. Winner settlement is outside this endpoint; a future settlement implementation must account for eligible in-flight decision queries before treating the winner as final. The internal test-only time override exercises exact equality and is never exposed over HTTP.

## Duplicate requests and retries

- Same key and normalized payload: replay the stored result, even after closure or another bidder taking the lead.
- Same key and changed payload: 409; no new bid.
- Concurrent copies: one request record and one durable outcome.
- Lost response or unknown commit result: retry the same key. Never generate a fresh key merely because a connection failed.
- Invalid requests are rejected before persistence. A 503 is not stored as a business decision.
- Completed request records are retained indefinitely for this exercise. Production retention needs an explicit replay window; blindly expiring keys would allow old retries to become new requests.

## Bidding on your own current top bid

Allowed when the new amount is strictly higher. It applies the same pricing rule to everyone and lets a bidder intentionally increase their commitment. A duplicate of the previous bid is replayed first, not treated as a new self-raise.

## Tests and load measurements

Start the database before the integration suite:

```sh
npm run typecheck
npm test
npm run build
npm run load
```

`npm run test:unit` needs no database. Integration and load runs create isolated random databases and remove only those databases afterward; they do not reset the demo database.

Tests cover validation, first/higher/equal/lower/self bids, exact opening/closing comparisons, idempotency conflicts and replay, independent API instances, unscheduled competing atomic writes, crash points, stale helpers, and delayed duplicates. The load tool starts two real API processes and uses real HTTP requests.

Measured bursts use 2,000 requests and 1,000 concurrent clients: one equal-amount auction, one mixed-amount auction, and 2,000 separate auctions. The recorded runs completed without temporary failures and preserved the checked invariants. See [load results and methodology](docs/LOAD_RESULTS.md) for latency, throughput, workload caveats, and reproduction settings.

## Limits and production changes

- The default request deadline is 15 seconds. At most 64 bid workflows run per process, with 2,048 queued. Excess work receives 503. Per-auction decision attempts are locally serialized to reduce contention; database version checks still enforce correctness across processes.
- Database queries have a 5-second client timeout. A stalled connection is closed and later reconnected; writes on that connection can have uncertain outcomes, resolved through idempotency. These timeouts favor bounded resource use over waiting indefinitely.
- A single auction is an inherent serialization point. Many auctions can spread across shards. Local burst results do not establish sustained throughput or replicated-cluster failover behavior.
- The Docker setup uses one replica for easy evaluation. Majority on one replica is still one machine, not high availability. A production deployment needs replication, clock synchronization, and failure testing.
- Durable history grows with requests. Define archival and idempotency retention together. Recovery is opportunistic or explicitly invoked; a production operator could schedule the same idempotent recovery command.

### What is wrong or underspecified in the assignment?

“Two bids both being accepted as the top bid” is ambiguous. Concurrent bids of 110 and 120 can both legitimately be accepted if they are ordered 110 then 120. I would require: **each auction has one consistent decision order; each accepted amount exceeds the preceding top; exactly one current top exists.**

“Thousands of simultaneous bids” also needs a workload and latency target. Thousands of losing bids differ significantly from thousands of successful price increases. I would specify arrival rate, accepted-bid ratio, p95 latency, durability, and hardware before choosing a production architecture.

## Project notes

- [Implementation plan](IMPLEMENTATION_PLAN.md)
- [Task checklist](TASK_CHECKLIST.md)
- [Load-test results](docs/LOAD_RESULTS.md)

Authentication, rate limiting by user, payments, and deployment are deliberately outside the exercise's scope.
