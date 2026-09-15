# Local load-test results

Measured on September 15, 2026. Node.js 24.19.0 on Windows, AMD Ryzen 7 250, 16 logical CPUs, 31 GiB host memory. Database: Docker/WSL2, RethinkDB 2.4.4, one replica, hard durability and majority reads/writes. Two independent Node.js API processes. Real HTTP requests and database writes, not mocks.

Each workload sent 2,000 requests with a maximum of 1,000 concurrent clients. No automatic client retries were used. Every run checked that accepted amounts strictly increase, the final top matches the accepted ledger, HTTP acceptances have durable records, and pending decisions are cleared.

## One auction, equal amounts
- Duration: 2.896 seconds.
- Business decisions: 691/second.
- Latency: p50 1,137 ms; p95 1,607 ms; p99 1,752 ms.
- HTTP results: 1 accepted (201), 1,999 too low (409), zero temporary failures.
- Exactly one accepted ledger entry; all invariants passed.

## One auction, mixed amounts
- Duration: 17.192 seconds.
- Business decisions: 116/second.
- Latency: p50 7,803 ms; p95 9,169 ms; p99 9,517 ms.
- HTTP results: 46 accepted (201), 1,954 rejected (409), zero temporary failures.
- Accepted amounts strictly increased; all invariants passed.

## 2,000 auctions
- Duration: 4.478 seconds.
- Business decisions: 447/second.
- Latency: p50 1,907 ms; p95 2,269 ms; p99 2,400 ms.
- HTTP results: 2,000 accepted (201), zero temporary failures.
- All invariants passed.

## What the numbers mean
These are short local bursts, not production capacity guarantees or sustained arrival-rate measurements. The generator uses a fixed number of clients that issue their next request after a response, so this is a closed-loop workload. Mixed concurrent amounts naturally produce many rejected bids; 116 decisions/second is not 116 accepted bids/second. This does not measure a continuous stream where every request becomes the new highest bid.

Final-run raw results: [equal bids](benchmarks/equal.json), [mixed bids](benchmarks/mixed.json), and [distributed auctions](benchmarks/distributed.json). The final checks also verified that each auction's top equals the maximum submitted amount when all requests resolved to business outcomes.

The first hot-auction run wrote every rejection to the auction document. It completed only 420 business decisions and returned 1,580 temporary failures. Per-auction scheduling helped, but the substantial improvement came from allowing provably too-low rejections to complete in their separate request records. All potentially winning bids still use the database's atomic version check.

Replication, disk latency, sustained duration, a larger ledger, network distance and failover will change performance. One auction remains a serial decision point. If production requires thousands of accepted bids per second on one auction, benchmark a partitioned auction-owner architecture and a durable ordered command log against an explicit latency target.

## Reproduce
Start the database with `docker compose up -d db`, install dependencies with `npm ci`, then run `npm run load`. Each invocation creates and deletes only its own randomly named database and starts two temporary API processes. Results are saved as JSON under ignored `test-results/`.

Configuration: `LOAD_REQUESTS`, `LOAD_CONCURRENCY`, `LOAD_AUCTIONS`, `LOAD_INSTANCES`, `LOAD_MODE` (`equal` or `mixed`). Defaults: 2000, 1000, 1, 2, equal.

PowerShell example for the distributed run:

```powershell
$env:LOAD_AUCTIONS = '2000'
npm run load
Remove-Item Env:LOAD_AUCTIONS
```

PowerShell example for mixed bids:

```powershell
$env:LOAD_MODE = 'mixed'
npm run load
Remove-Item Env:LOAD_MODE
```
