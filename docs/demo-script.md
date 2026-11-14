# FulfillOps — 12–15 Minute Live Demonstration Script

> **Speaker:** Willy Junior Tatchi (Data Tier, Concurrency & Resilience Lead)  
> **Scope:** Docker Compose Multi-Replica Environment (Excluding Kubernetes)  
> **Target Duration:** 12–15 Minutes  
> **Core Focus:** Multi-Instance API Concurrency, Advisory Transaction Locks, Worker Crash Recovery, Poison Message Isolation, Contract Verification, and Observability.

---

## 🖥️ Pre-Demo Setup Checklist (Do this 5 minutes before presenting)

1. Open **three terminal windows** (PowerShell or Bash) side by side:
   - **Terminal 1 (Left):** `LOGS` — dedicated to continuous container logs.
   - **Terminal 2 (Top Right):** `DATABASE & INSPECTION` — dedicated to checking database tables and state.
   - **Terminal 3 (Bottom Right):** `COMMANDS & TESTS` — where you will run requests, checkers, and tests.
2. Make sure Docker Desktop is running.
3. Clean and launch the fresh Docker Compose stack in **Terminal 1**:
   ```powershell
   docker compose down -v
   docker compose up -d --build --wait
   docker compose logs -f
   ```
4. Reset database inventory to initial state in **Terminal 2**:
   ```powershell
   docker compose exec -T db psql -U fulfillops -d fulfillops_db -c "TRUNCATE order_items, worker_jobs, orders CASCADE; UPDATE catalog SET available = 7 WHERE sku = 'KIT-100'; UPDATE catalog SET available = 12 WHERE sku = 'PART-200'; UPDATE catalog SET available = 5 WHERE sku = 'PACK-300';"
   ```

---

## ⏱️ Live Demo Timeline & Step-by-Step Script

```text
+--------------------------------------------------------------------------------+
| Time          | Phase                          | Key Action / Demonstration    |
+---------------+--------------------------------+-------------------------------+
| 00:00 - 02:00 | 1. Introduction & Architecture | Show architecture & containers|
| 02:00 - 04:00 | 2. Health & Seeded Catalog     | Query /health/ready & catalog |
| 04:00 - 07:00 | 3. Concurrency & Idempotency   | Same-key replay & race safety |
| 07:00 - 10:00 | 4. Worker Crash & Poison Drill | Kill worker mid-job & poison  |
| 10:00 - 12:00 | 5. Automated Tests & Checker   | 9/9 npm test & 15/15 checker  |
| 12:00 - 13:30 | 6. Observability & Metrics     | Query /metrics & show p95 SLO |
| 13:30 - 15:00 | 7. CI/CD Pipeline & Q&A Wrap   | GitHub Actions SBOM & wrap-up |
+--------------------------------------------------------------------------------+
```

---

### Phase 1: Introduction & Architecture (00:00 – 02:00)

#### What to Do:
In **Terminal 3**, run:
```powershell
docker compose ps
```

#### What to Say:
> *"Hello, professors. Today I will present **FulfillOps**, our resilient, high-concurrency order fulfillment platform.
> As you can see from our running Docker Compose stack, the platform is architected around separate, horizontally scalable services:
> - We have **two independent API instances** running on port 8080 and 8081.
> - We have **two asynchronous worker instances** processing background fulfillment jobs.
> - A shared **PostgreSQL 16 database** acting as our single source of truth and transactional outbox.
> 
> In this demonstration, I will prove how our system achieves three core engineering guarantees:
> 1. Strict cross-replica idempotency and zero overselling under heavy concurrency.
> 2. Automatic worker crash recovery without human intervention and without double-fulfillment.
> 3. Resilient poison-message isolation with bounded exponential backoff."*

---

### Phase 2: Health Readiness & Catalog Inspection (02:00 – 04:00)

#### What to Do:
In **Terminal 3**, run:
```powershell
# 1. Check readiness on both API replicas
Invoke-RestMethod http://localhost:8080/health/ready
Invoke-RestMethod http://localhost:8081/health/ready

# 2. Check catalog products
Invoke-RestMethod http://localhost:8080/api/v1/catalog

# 3. Check initial stock for KIT-100
Invoke-RestMethod http://localhost:8080/api/v1/inventory/KIT-100
```

#### What to Say:
> *"First, notice that both API replicas on port 8080 and 8081 report `status: ready`. Our readiness probe does not simply check process liveness—it actively verifies that all five database tables and the retry schema columns are present.
> Our catalog exposes our three fixed products. For example, `KIT-100` currently has 7 units available."*

---

### Phase 3: Cross-Replica Idempotency & Race Protection (04:00 – 07:00)

#### What to Do:
**Step 3.1: Submit an order to API Replica 1 (`:8080`)**
In **Terminal 3**, run:
```powershell
$key = "DEMO-KEY-" + [guid]::NewGuid().ToString()
$body = '{"customer_id":"CUST-EPITA","items":[{"sku":"KIT-100","quantity":2}]}'

# Submit to API 1 (:8080)
$order1 = Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/v1/orders -Headers @{"Idempotency-Key"=$key} -ContentType "application/json" -Body $body
$order1
```
*(Notice output: `order_id: <UUID>`, `status: queued`)*

**Step 3.2: Replay the EXACT same key on API Replica 2 (`:8081`)**
In **Terminal 3**, run:
```powershell
# Replay identical request against API 2 (:8081)
$order2 = Invoke-RestMethod -Method Post -Uri http://localhost:8081/api/v1/orders -Headers @{"Idempotency-Key"=$key} -ContentType "application/json" -Body $body
$order2

# Check remaining inventory of KIT-100
Invoke-RestMethod http://localhost:8080/api/v1/inventory/KIT-100
```
*(Point to screen: Order ID is identical, and stock decremented by ONLY 2 units, from 7 down to 5!)*

**Step 3.3: Submit the SAME key with an ALTERED payload (Conflict Detection)**
In **Terminal 3**, run:
```powershell
try {
    $conflictBody = '{"customer_id":"DIFFERENT-CUSTOMER","items":[{"sku":"KIT-100","quantity":2}]}'
    Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/v1/orders -Headers @{"Idempotency-Key"=$key} -ContentType "application/json" -Body $conflictBody
} catch {
    $_.Exception.Response.StatusCode.value__
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    $reader.ReadToEnd()
}
```
*(Point to screen: Returns HTTP 409 with `{"error":{"code":"IDEMPOTENCY_CONFLICT",...}}`)*

#### What to Say:
> *"Here is our concurrency and idempotency guarantee in action:
> 1. We submitted an order for 2 units of `KIT-100` to API replica 1. It returned order ID with status `queued`.
> 2. We then immediately sent the exact same request to API replica 2 on port 8081. Replica 2 returned the exact same order receipt, and inventory was decremented only once—from 7 down to 5.
> 3. How do we achieve this across processes? We do not use process-local memory. We acquire a PostgreSQL transaction advisory lock hashed from the idempotency key: `SELECT pg_advisory_xact_lock(hashtextextended(key, 0))`. This serializes requests for the same key across any number of replicas.
> 4. Furthermore, when we sent the same key with an altered customer ID, our canonical SHA-256 payload comparison detected the conflict and rejected it with HTTP 409 `IDEMPOTENCY_CONFLICT`."*

---

### Phase 4: Worker Crash Recovery & Poison Job Drill (07:00 – 10:00)

#### What to Do:
**Step 4.1: Inspect the Completed Order in the Database**
In **Terminal 2**, run:
```powershell
docker compose exec -T db psql -U fulfillops -d fulfillops_db -c "SELECT order_id, status, attempts FROM worker_jobs; SELECT * FROM fulfillment_receipts;"
```
*(Show that the order has `status: completed` and exactly 1 receipt in `fulfillment_receipts`)*

**Step 4.2: Demonstrate Worker Crash Recovery & Poison Job Isolation**
In **Terminal 3**, simply run:
```powershell
npm test
```
*(Runs all 9 tests automatically, including worker crash recovery, poison job isolation, and concurrency races)*
*(Point to screen: `✔ worker crash is recovered exactly once and poison jobs are dead-lettered`)*

#### What to Say:
> *"Now let's examine worker reliability and fault recovery.
> In FulfillOps, workers poll the outbox table using `SELECT ... FOR UPDATE SKIP LOCKED`. This guarantees that workers never claim the same job simultaneously.
> What happens if a worker is abruptly killed while processing an order?
> 1. When a worker claims a job, it writes an expiring lease timestamp: `locked_at = NOW()`.
> 2. If the worker container dies, after 30 seconds the lease expires. Surviving workers detect the stale lock and reclaim the job on attempt 2.
> 3. To guarantee exactly-once business effects, we maintain a `fulfillment_receipts` table with a unique `order_id` constraint. Even if an order is retried due to a crash, only one fulfillment receipt can ever be written.
> 4. For poison messages that crash repeatedly, our bounded retry policy retries with exponential backoff up to 3 attempts, then moves the job to `dead_letter` and marks the order `failed`. The queue is never blocked by poison messages."*

---

### Phase 5: Automated Test Suite & 15/15 Public Contract Checker (10:00 – 12:00)

#### What to Do:
**Step 5.1: Reset Test Database**
In **Terminal 2**, run:
```powershell
docker compose exec -T db psql -U fulfillops -d fulfillops_db -c "TRUNCATE order_items, worker_jobs, orders CASCADE; UPDATE catalog SET available = 7 WHERE sku = 'KIT-100'; UPDATE catalog SET available = 12 WHERE sku = 'PART-200'; UPDATE catalog SET available = 5 WHERE sku = 'PACK-300';"
```

**Step 5.2: Run the Official Public Contract Checker with Concurrency & Stress**
In **Terminal 3**, run:
```powershell
python tests/fulfillops_public_checker.py --base-url http://localhost:8080 --concurrency --stress
```
*(Wait ~15 seconds while the 15 checks print PASS)*

#### What to Say:
> *"To verify complete behavioral conformity with the instructor's specification, we run the official public checker with both `--concurrency` and `--stress` enabled.
> As you can see live on screen:
> - All 15 contract checks pass: 0 failed, 0 skipped.
> - This proves: correct error formats, asynchronous worker completion within 15 seconds, atomic inventory reservation under 12+ competing threads, duplicate SKU line aggregation, and 8 simultaneous identical-key replays across replicas."*

---

### Phase 6: Observability, Metrics & SLOs (12:00 – 13:30)

#### What to Do:
In **Terminal 3**, run:
```powershell
# 1. Query Prometheus metrics on API
(Invoke-RestMethod http://localhost:8080/metrics) -split "`n" | Select-String "fulfillops_orders"

# 2. Check p95 latency benchmark results
Get-Content docs/evidence/local-latency-2026-11-14.csv | Measure-Object -Line
```

#### What to Say:
> *"Observability is built directly into our services.
> - Our API exposes `/metrics` in Prometheus format, tracking orders created, failed, and request latency histograms.
> - Our worker exposes internal metrics on port 9100 tracking queue depth and retry counts.
> - For our Service Level Objectives (SLOs), we recorded 200 sequential samples in `local-latency-2026-11-14.csv`. Our observed p95 response time was **25.9 ms**, well below our 300 ms SLO threshold, with 100% availability."*

---

### Phase 7: CI/CD Quality Gate & Wrap-Up (13:30 – 15:00)

#### What to Do:
Open your browser or IDE showing `.github/workflows/ci.yml`.

#### What to Say:
> *"Finally, our supply chain and deployment pipeline in GitHub Actions enforces strict quality gates:
> 1. Automated testing with throw-away PostgreSQL services.
> 2. Multi-stage Docker image building under the unprivileged `node` user.
> 3. Machine-readable **SBOM generation** in SPDX JSON format via Anchore.
> 4. **Trivy vulnerability scanning** with an enforced blocking gate on Critical and High vulnerabilities.
> 5. Ephemeral Docker Compose contract verification before merging to main.
> 
> In summary, FulfillOps achieves zero overselling, robust worker recovery, full API contract compliance, and production-grade observability. Thank you, and I am now ready for your questions."*

---

## 💡 Anticipated Defense Questions & Answers (Cheat Sheet for Willy)

### Q1: *"How do you prevent race conditions when two clients submit the same idempotency key at the exact same millisecond to two different API replicas?"*
> **Answer:** *"We use PostgreSQL transaction-scoped advisory locks: `pg_advisory_xact_lock(hashtextextended(key, 0))`. Because this lock is acquired inside the transaction before checking existing orders or reserving stock, whichever API instance reaches Postgres first holds the lock. The second instance pauses until the first commits. When the second resumes, it immediately sees the committed order in `orders`, verifies the payload hash, and returns the original queued receipt without touching catalog inventory."*

### Q2: *"How do you prevent deadlocks when an order contains multiple items?"*
> **Answer:** *"We lock target catalog rows in deterministic sorted order: `ORDER BY sku ASC`. By ensuring that all concurrent transactions request row locks in the exact same alphabetical order, a cyclical lock dependency (deadlock) is mathematically impossible."*

### Q3: *"What happens if a worker process crashes while processing an order?"*
> **Answer:** *"When a worker claims a job with `FOR UPDATE SKIP LOCKED`, it writes an expiring lease timestamp `locked_at = NOW()`. If the worker is killed, after 30 seconds the lease is considered stale. Surviving workers query for stale leases and reclaim the job on attempt 2. To prevent duplicate fulfillment side effects, we insert into `fulfillment_receipts` with a unique constraint on `order_id` in the same transaction as job completion. If attempt 1 ever tried to complete late, it is rejected because the attempt number no longer matches."*

### Q4: *"Why did you use a PostgreSQL Outbox table instead of RabbitMQ or Redis?"*
> **Answer:** *"A separate message broker introduces the dual-write problem: you can save the order to Postgres, but the queue write might fail, or vice-versa. With a PostgreSQL transactional outbox, order creation, inventory reservation, and worker job insertion occur inside **one single atomic database transaction**. Either everything commits, or nothing commits. `FOR UPDATE SKIP LOCKED` gives us concurrent worker claiming without broker overhead."*
