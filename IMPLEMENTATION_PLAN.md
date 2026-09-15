# Implementation plan

Build a Node.js / TypeScript bidding API backed by RethinkDB. The core contract is a consistent order of decisions per auction, strictly increasing accepted amounts, durable idempotency, and recoverable multi-document writes.

## Decisions
- POST /bid accepts auction_id, user_id and a positive safe-integer amount in currency minor units.
- Require an Idempotency-Key header, scoped to the auction. Same key and payload replays the stored response; changed payload conflicts.
- Allow the current top bidder to raise their own bid.
- Use the bidding window opens_at <= database decision-query time < closes_at. Equality at closing is rejected. Query start time, not HTTP arrival or response time, determines eligibility.
- First bid must meet the opening amount. Subsequent accepted bids must strictly exceed the top.
- Acceptance means the bid was top at its decision point, not that it remains top at response delivery.

## Persistence protocol
Auctions contain configuration, one top bid, a version, and at most one pending decision. A separate request ledger stores immutable payloads and completed responses; accepted outcomes form bid history. No growing bid array lives on the auction.

Register a deterministic request ID, resolve any pending auction decision, reread the request, then atomically compare the auction version and empty pending slot. Store the decision and update the top together. Persist the outcome to the request ledger before conditionally clearing the pending slot. Helpers can complete the same steps after a crash. Version comparison fences stale actors, including delayed duplicate requests.

Use hard durability, majority write acknowledgement, and majority reads. Do not assume cross-document transactions. Bound retries and database concurrency; independent auctions share no correctness lock.

## Measured refinement during implementation
Load testing showed contention from writing every rejected bid to the auction. The final implementation can durably reject a bid below the confirmed top directly in its request record: the top never decreases, so that rejection remains valid. It reads the auction before rereading the request outcome to fence delayed duplicates. Concurrent rejection writers replay the first stored outcome. Such rejections report the observed auction version without incrementing it. Potentially winning bids still use the atomic decision protocol. Local scheduling serializes only decision-write attempts for a given auction; stable low-bid rejections run concurrently.

## Stages
1. Initialize repository and record plan/checklist.
2. Scaffold strict TypeScript, Fastify, database startup and seed scripts.
3. Implement atomic decisions, durable retry outcomes and recovery.
4. Add validation, boundary, real-database concurrency and crash-recovery tests.
5. Add reproducible load tooling, run available verification, and document measured limitations.
6. Complete README and submission checks.

Each stage includes a checklist update and commit. Push each commit when a remote is available; record any external blockers without claiming success.

## Validation
Test equal and mixed concurrent bids, duplicate requests, changed-payload conflicts, self-raises, exact deadline comparisons, retries after closing/outbidding, multiple API instances, and interruption after each persistence step. Load tooling covers one hot auction and thousands of independent auctions, with observed latency and throughput rather than an unverified performance promise.

## Required critique
The assignment's wording about two accepted concurrent bids is ambiguous: increasing bids may both be accepted in a valid serial order. Require one consistent decision order and one current top instead. Production throughput also needs concrete workload and latency targets.
