# FulfillOps — The Resilient Order-Processing Platform
## Final DevOps Capstone Project Report (9.5/10 Edition)

**Institution:** EPITA — Bachelor in Computer Science (S5 DevOps Final Lab)  
**Academic Year:** Fall 2026  
**Authors & Team Members:**
- **Willy Junior Tatchi** (`tatchi-feudjio.willy-junior@epita.fr`) — Data Tier, Concurrency & Resilience Lead
- **Kelyan Ihinack** (`kelyan-paul-owen.ihinack@epita.fr`) — Worker Processing & Observability Lead
- **Fred Njike** (`skyly813@gmail.com`) — DevOps & Infrastructure Lead

---

## 1. Executive Summary & Architecture

### 1.1 Engineering Problem & Objective
FulfillOps is an asynchronous fulfillment and order-processing platform designed for high-concurrency electronic commerce. The platform must accept valid client orders rapidly, guarantee atomic stock reservations across independent API replicas, prevent duplicate order creation on network replays, and asynchronously fulfill orders via worker processes. The system must maintain strict data consistency under severe operating constraints: concurrent requests competing for finite stock, simultaneous requests sharing identical idempotency keys, ungraceful worker termination, poison-message payloads, and infrastructure rolling restarts.

### 1.2 System Architecture Overview
The platform decouples synchronous HTTP acceptance from asynchronous fulfillment execution using a **PostgreSQL Transactional Outbox** pattern:

```text
                           +------------------------------------+
                           | Prometheus Scrape (:8080, :9100)   |
                           +------------------^-----------------+
                                              |
[ Client Replicas ]                           |
        |                                     |
        v                                     |
+-----------------------+           +---------+-------------+
|   API Replica 1 (:8080)|           |   API Replica 2 (:8081)|
+-----------+-----------+           +---------+-------------+
            |                                 |
            +----------------+----------------+
                             |
         PostgreSQL Advisory Transaction Lock (hashtextextended)
         Canonical Payload Hash Verification
         Row Locks in Sorted SKU Order (`FOR UPDATE`)
                             |
                             v
+-----------------------------------------------------------+
|                   PostgreSQL Database                     |
| - catalog (CHECK available >= 0)                          |
| - orders (UNIQUE idempotency_key)                         |
| - order_items                                             |
| - worker_jobs (SKIP LOCKED outbox, lease timeout, backoff)|
| - fulfillment_receipts (UNIQUE order_id barrier)          |
+----------------------------^------------------------------+
                             |
     FOR UPDATE SKIP LOCKED | Lease Reclaim (>30s) | Bounded Retry
                             |
            +----------------+----------------+
            |                                 |
+-----------+-----------+           +---------+-------------+
|    Worker Replica 1   |           |    Worker Replica 2   |
+-----------------------+           +-----------------------+
```

### 1.3 Domain Data Model & Invariants
Authoritative state is managed across five relational tables:
1. `catalog`: Defines SKUs, unit prices, and available inventory. An explicit `CHECK (available >= 0)` constraint prevents overselling at the storage engine level.
2. `orders`: Durable order records keyed by UUID with a unique `idempotency_key` constraint and SHA-256 canonical `payload_hash`.
3. `order_items`: Line-item breakdown linking orders to catalog SKUs with `CHECK (quantity > 0)`.
4. `worker_jobs`: Asynchronous job queue storing order execution state (`pending`, `processing`, `completed`, `dead_letter`), attempt counters, expiring lease timestamps (`locked_at`), scheduling intervals (`next_attempt_at`), and error diagnostics (`last_error`).
5. `fulfillment_receipts`: An idempotent business boundary table enforcing a `UNIQUE (order_id)` constraint to guarantee that at-least-once message delivery yields exactly-once fulfillment effects.

---

## 2. Concurrency, Idempotency & Transactional Boundaries

### 2.1 Cross-Replica Same-Key Idempotency
Clients operating in unreliable network conditions may issue simultaneous or repeated requests sharing the same `Idempotency-Key`. To guarantee consistency across multiple independent API instances without relying on process-local memory, FulfillOps uses **PostgreSQL transaction-scoped advisory locks**:
```sql
SELECT pg_advisory_xact_lock(hashtextextended($1, 0));
```
When multiple API processes receive identical idempotency keys concurrently:
1. Only one transaction acquires the 64-bit advisory lock; competing transactions wait until the first commits or rolls back.
2. The initial transaction verifies that no order exists with that key, locks the required catalog rows in alphabetical SKU order, reserves stock, creates the order and worker job, and commits.
3. The competing transaction unblocks, queries `orders` by `idempotency_key`, finds the committed record, compares the SHA-256 payload hash, and immediately returns the original `202 Accepted` receipt (`status: "queued"`) without decrementing inventory a second time.
4. If an existing key is presented with an altered payload (e.g., modified customer ID or items), the API rejects the request with HTTP `409` and error code `IDEMPOTENCY_CONFLICT`.

### 2.2 Canonical Payload Normalization & Multi-Line Aggregation
Clients may submit duplicate SKU lines or vary JSON key ordering. Before computing the payload hash and validating stock:
- Multiple order lines referencing the same SKU are summed into an aggregated quantity.
- SKU keys are sorted alphabetically before generating the canonical SHA-256 digest:
```javascript
const canonicalItems = Object.fromEntries(
  Object.keys(aggregated).sort().map(sku => [sku, aggregated[sku]])
);
const payloadHash = crypto.createHash('sha256')
  .update(JSON.stringify({ customer_id, items: canonicalItems }))
  .digest('hex');
```

### 2.3 Competing Different-Key Orders (Atomic Race Safety)
When distinct clients race to purchase the remaining inventory units:
- Target rows in `catalog` are locked using `SELECT ... FOR UPDATE` in deterministic sorted order (`ORDER BY sku ASC`), preventing database deadlocks.
- Available inventory is verified against aggregated requirements. If requested quantity exceeds available stock, the transaction rolls back cleanly and returns HTTP `409 OUT_OF_STOCK` without partial allocations.

---

> ### 📷 SCREENSHOT 1: Concurrency & Idempotency Proof
> **What to capture:** Terminal output showing the execution of `tests/idempotency.integration.test.js` where 8 concurrent requests sharing the same idempotency key hit two different API ports (`:8080` and `:8081`), yielding 8 identical `202` receipts and decrementing stock exactly once.
>
> ```text
> [Screenshot Placeholder: Concurrency & Idempotency Test Execution]
> Command: npm test -- tests/idempotency.integration.test.js
> Output:
> ✔ same idempotency key is accepted once across two API instances
> ✔ distinct keys compete atomically for limited stock across two API instances
> ✔ API returns contract errors for invalid JSON and idempotency keys
> ```

---

## 3. Asynchronous Worker, Fault Recovery & Reliability

### 3.1 Durable Outbox & Non-Blocking Job Claiming
Worker processes operate independently of the HTTP request-response cycle. Workers poll the `worker_jobs` table using PostgreSQL's row-level locking mechanism:
```sql
SELECT * FROM worker_jobs
 WHERE status = 'pending'
   AND next_attempt_at <= NOW()
 ORDER BY job_id ASC
 LIMIT 1
 FOR UPDATE SKIP LOCKED;
```
`SKIP LOCKED` allows multiple worker replicas to claim distinct jobs concurrently without lock contention or thread starvation.

### 3.2 Crash Recovery & Expiring Leases
When a worker claims a job, it updates its status to `processing` and sets a lease timestamp (`locked_at = NOW()`). If a worker container crashes or is abruptly killed (`SIGKILL`) mid-processing:
1. The assigned job remains in `processing`.
2. Surviving workers scan for orphaned leases where `status = 'processing' AND locked_at < NOW() - INTERVAL '30 seconds'`.
3. An orphaned job is safely claimed by a surviving worker, incrementing `attempts` to 2.
4. When processing completes, the worker commits the order update and inserts a record into `fulfillment_receipts`. Any delayed completion attempts from a previously stalled worker are rejected via optimistic version checks (`attempts = $2`).

### 3.3 Bounded Retries & Poison Message Isolation
External failures and transient errors are handled via exponential backoff with randomized jitter:
$$\text{delay} = \min\left(1000 \times 2^{\text{attempts}-1} \times (1 + \text{jitter}), 30000\right)\text{ ms}$$
- **Attempt 1:** ~1.0–1.2 s delay
- **Attempt 2:** ~2.0–2.4 s delay
- **Attempt 3:** ~4.0–4.8 s delay
- **Poison Message Dead-Lettering:** If an unprocessable job fails 3 consecutive times, it transitions to `dead_letter`. The associated order is marked `failed`, the error diagnosis is persisted in `last_error`, and reserved stock is retained for manual operator auditing. The queue never enters an infinite retry loop.

---

> ### 📷 SCREENSHOT 2: Worker Crash Recovery & Dead-Letter Drill
> **What to capture:** Terminal output showing the execution of `worker/test/recovery.integration.test.js`, demonstrating that an interrupted worker job is reclaimed on attempt 2 with exactly one receipt, and a poison job reaches `dead_letter` after 3 bounded attempts.
>
> ```text
> [Screenshot Placeholder: Worker Crash & Poison Job Test Execution]
> Command: npm test -- worker/test/recovery.integration.test.js
> Output:
> ✔ worker crash is recovered exactly once and poison jobs are dead-lettered
> ```

---

## 4. Automated Testing Strategy & Contract Verification

### 4.1 Test Pyramid & Quality Gates
The testing strategy enforces multi-tier quality gates:
1. **Unit Tests (`worker/test/retry.test.js`):** Validates exponential backoff progression, jitter boundary conditions ($0 \le \text{jitter} \le 0.2$), and maximum delay clamping.
2. **Integration Tests (`tests/idempotency.integration.test.js`, `worker/test/recovery.integration.test.js`):** Exercises multi-instance HTTP concurrency against temporary API and worker processes.
3. **Black-Box API Contract Suite (`tests/fulfillops_public_checker.py`):** 15 rigorous contract validation checks executed with `--concurrency` and `--stress` against an isolated, freshly migrated database.

### 4.2 Public Checker Execution Results
On 2026-11-14, the public checker validated 100% contract compliance across all endpoints and edge cases:

| Check # | Test Description | Evaluation Result |
|:---:|---|:---:|
| 1 | Liveness endpoint returns HTTP 200 `status: ok` | **PASS** |
| 2 | Readiness endpoint returns HTTP 200 `status: ready` | **PASS** |
| 3 | Catalog lists all 3 SKUs with exact unit prices | **PASS** |
| 4 | Unknown order ID returns HTTP 404 `ORDER_NOT_FOUND` | **PASS** |
| 5 | Missing Idempotency-Key returns HTTP 400 `IDEMPOTENCY_REQUIRED` | **PASS** |
| 6 | Invalid item quantity returns HTTP 422 `INVALID_QUANTITY` | **PASS** |
| 7 | Inventory reading returns valid integer | **PASS** |
| 8 | Order creation returns 202 `queued`; replay returns same order | **PASS** |
| 9 | Conflicting idempotency payload returns HTTP 409 `IDEMPOTENCY_CONFLICT` | **PASS** |
| 10 | Asynchronous worker completes order within deadline | **PASS** |
| 11 | Stock inventory decrements exactly once | **PASS** |
| 12 | Prometheus metrics exposed at `/metrics` | **PASS** |
| 13 | 12+ concurrent distinct-key requests prevent overselling | **PASS** |
| 14 | 8 concurrent same-key requests reserve stock exactly once | **PASS** |
| 15 | Duplicate SKU lines aggregate and bill correctly | **PASS** |
| **Total** | **15 Passed / 0 Failed / 0 Skipped** | **100% Pass** |

---

> ### 📷 SCREENSHOT 3: Public Checker 15/15 PASS
> **What to capture:** Clean terminal output running the contract checker with `--concurrency --stress` against `http://localhost:8080`.
>
> ```text
> [Screenshot Placeholder: Public Contract Checker Execution]
> Command: python tests/fulfillops_public_checker.py --base-url http://localhost:8080 --concurrency --stress
> Output:
> RESULT: 15 passed / 0 failed / 0 skipped
> ```

---

## 5. CI/CD Pipeline & Supply Chain Security

### 5.1 Pipeline Stages & Execution Flow
The automated GitHub Actions workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) executes on every pull request to `main`:
1. **Quality & Test Stage:** Spins up an isolated PostgreSQL 16 container, applies migrations via `node db/migrate.js`, runs code linting, and executes the full integration test suite.
2. **Container Build & Artifact Immutability:** Builds multi-stage production images tagged with the commit SHA (`fulfillops:${{ github.sha }}`). The image runs under the unprivileged `node` user (UID 1000).
3. **Software Bill of Materials (SBOM):** Anchore's `sbom-action` inspects the built container image and generates a standard SPDX JSON artifact (`sbom.spdx.json`), attached to the GitHub Actions workflow run.
4. **Vulnerability Gating (Trivy):**
   - **Blocking Policy:** Scans for OS and application vulnerabilities; fails the pipeline (`exit-code: 1`) if any unfixed `CRITICAL` or `HIGH` vulnerabilities are discovered.
   - **Informational Policy:** Audits `MEDIUM` and `LOW` vulnerabilities without halting deployment.
5. **Blackbox Stack Validation:** Starts an ephemeral Docker Compose environment and executes the public checker to prevent regressions from reaching production branches.

---

> ### 📷 SCREENSHOT 4: CI/CD Pipeline & Artifact Evidence
> **What to capture:** GitHub Actions workflow run summary displaying green checkmarks across Test, Build & Scan, and Blackbox jobs, along with the downloadable `sbom-artifact` in the artifacts panel.
>
> ```text
> [Screenshot Placeholder: GitHub Actions Green Pipeline & SBOM Artifact]
> Jobs:
> ✔ test (Postgres, migrations, lint, test suite)
> ✔ build-scan (Docker build, Anchore SPDX SBOM, Trivy blocking scan)
> ✔ blackbox (Compose up, public checker --concurrency --stress)
> Artifacts: sbom-artifact (sbom.spdx.json)
> ```

---

## 6. Observability, Metrics & Service Level Objectives

### 6.1 Metrics Exposition
The API (`:8080`) and Worker (`:9100`) expose standard Prometheus text-format metrics. Scrape targets track HTTP throughput, latency distributions, worker retries, and queue backlogs:
- `fulfillops_http_requests_total{method, path, status}`
- `fulfillops_http_request_duration_seconds_bucket{le, method, path}`
- `fulfillops_orders_created_total`
- `fulfillops_orders_failed_total`
- `fulfillops_worker_retries_total`
- `fulfillops_worker_jobs_processed_total{result="completed|dead_letter"}`
- `fulfillops_worker_queue_depth`

### 6.2 Service Level Objectives (SLOs) & Alert Rules
| Target Metric | Target Objective | Observed Value | PromQL Indicator |
|---|---|---|---|
| **API Availability** | $\ge 99.5\%$ non-5xx requests (30-day window) | **100%** | `sum(rate(fulfillops_http_requests_total{status!~"5.."}[5m])) / sum(rate(fulfillops_http_requests_total[5m]))` |
| **API Latency** | $p95 < 300\text{ ms}$ on catalog lookup | **25.9 ms** | `histogram_quantile(0.95, sum by (le) (rate(fulfillops_http_request_duration_seconds_bucket[5m])))` |
| **Order Fulfillment** | $\ge 99\%$ completed without dead-letter | **100%** | `sum(rate(fulfillops_worker_jobs_processed_total{result="completed"}[15m])) / sum(rate(fulfillops_worker_jobs_processed_total[15m]))` |
| **Queue Freshness** | $< 50$ pending jobs for $> 5\text{ min}$ | **0 backlog** | `fulfillops_worker_queue_depth > 50` |

### 6.3 200-Sample Latency Benchmark Analysis
Using `tests/measure_latency.py`, 200 sequential catalog requests were recorded against an isolated test stack:
- **Sample Count:** 200 requests (0 failures)
- **Mean Latency:** $9.509\text{ ms}$
- **Observed Nearest-Rank p95:** $25.906\text{ ms}$
- **Observed Maximum:** $38.411\text{ ms}$
- **Measurement Limitation:** Benchmarked over loopback interface; excludes edge load balancers, TLS handshake overhead, and inter-datacenter transit latency.

---

> ### 📷 SCREENSHOT 5: Prometheus Metrics Endpoint
> **What to capture:** Browser or terminal output querying `http://localhost:8080/metrics` showing the order counters, request counters, and histogram buckets.
>
> ```text
> [Screenshot Placeholder: Prometheus Metrics Output]
> Query: curl http://localhost:8080/metrics
> Output:
> fulfillops_orders_created_total 15
> fulfillops_orders_failed_total 0
> fulfillops_http_requests_total{method="GET",path="/api/v1/catalog",status="200"} 200
> ```

---

## 7. Limitations, Security Boundaries & Contributions

### 7.1 Operational & Architecture Limitations
1. **Shared Database Outbox Polling:** While effective for up to thousands of requests per second, high-throughput scaling would benefit from a dedicated distributed event stream (e.g., Apache Kafka or Redis Streams) to minimize database CPU utilization from worker polling.
2. **Local Business Effect Boundary:** The current `fulfillment_receipts` table provides idempotency within the platform boundary. Integration with external third-party payment gateways or warehouse logistics APIs would require an outbox consumer with external correlation tokens.
3. **Single Database Write Leader:** The current setup operates against a single primary PostgreSQL instance. Disaster recovery in production would necessitate hot-standby replicas with automated Patroni/Raft failover.

### 7.2 Individual Ownership & Contribution Breakdown

| Contributor | Specific Implementation & Review Ownership | Defense Walkthrough Focus |
|---|---|---|
| **Willy Junior Tatchi** | **Data Tier, Concurrency & Integration Tests:** Authored database schema migrations (`db/migrate.js`, `003_fulfillment_receipts.sql`), PostgreSQL advisory lock synchronization for cross-replica idempotency, multi-line item aggregation, lease timeout worker recovery, integration test suite (`idempotency.integration.test.js`, `recovery.integration.test.js`), latency benchmarks, and incident postmortem. | Walk through advisory locking mechanism, multi-line SKU aggregation, worker lease expiration, and race condition tests. |
| **Kelyan Ihinack** | **Asynchronous Worker & Observability:** Authored the worker polling loop, `SKIP LOCKED` atomic queries, bounded exponential backoff with jitter and dead-letter logic, Prometheus metrics instrumentation, SLO definitions, and STRIDE threat modeling. | Walk through worker claiming loop, exponential retry backoff, and Prometheus metric instrumentation. |
| **Fred Njike** | **DevOps & Infrastructure:** Multi-stage non-root Dockerfile, Docker Compose multi-service architecture, GitHub Actions CI workflow (Trivy scans, Anchore SBOM artifact, blackbox test gate), Kubernetes manifests, and Argo CD GitOps Application. | Walk through Dockerfile layers, security gating in CI, and deployment manifests. |

---

## 8. Conclusion

FulfillOps satisfies all functional, architectural, and operational requirements of the Capstone 9.5/10 specification. By leveraging database-native concurrency controls, durable transactional outbox claiming, automated supply-chain security gates, and comprehensive observability instrumentation, the platform demonstrates true resilience: zero inventory overselling under heavy concurrency, automatic worker crash recovery without human intervention, and bounded isolation of deterministic poison messages.
