# FulfillOps — The Resilient Order-Processing Platform

> **Final Graded DevOps Capstone (9.5/10 Edition)**  
> Built from scratch for resilient, concurrent, and observable fulfillment operations.

---

## 1. Overview & Architecture

FulfillOps is an asynchronous, highly available order-processing platform designed to withstand node failures, high-concurrency order surges, worker restarts, and poison-message attacks. It adheres strictly to the authoritative `API_CONTRACT_EN.md` specification and demonstrates production-grade DevOps engineering practices: container hardening, cross-replica transactional idempotency, durable outbox worker claiming, GitOps-driven Kubernetes deployments, continuous observability, and supply-chain security (SBOM + automated vulnerability gating).

```text
                                  +------------------------------------+
                                  | Prometheus Scrape (:8080, :9100)   |
                                  +------------------^-----------------+
                                                     |
  [ HTTP Clients / Replicas ]                        |
              |                                      |
              v                                      |
  +-----------------------+              +-----------+------------+
  |   API Replica 1 (:8080)|              |  API Replica 2 (:8081) |
  +-----------+-----------+              +-----------+------------+
              |                                      |
              +------------------+-------------------+
                                 |
           PostgreSQL Advisory Transaction Lock (hashtextextended(key, 0))
           Canonical Payload Hash Deduplication
           Row Locks in Sorted SKU Order (`FOR UPDATE`)
                                 |
                                 v
  +---------------------------------------------------------------+
  |                     PostgreSQL Database                       |
  |  - catalog (CHECK available >= 0)                             |
  |  - orders (UNIQUE idempotency_key)                            |
  |  - order_items                                                |
  |  - worker_jobs (SKIP LOCKED outbox, lease timeout, backoff)   |
  |  - fulfillment_receipts (UNIQUE order_id exactly-once barrier)|
  +------------------------------^--------------------------------+
                                 |
        FOR UPDATE SKIP LOCKED | Lease Reclaim (>30s) | Bounded Retry
                                 |
              +------------------+-------------------+
              |                                      |
  +-----------+-----------+              +-----------+------------+
  |     Worker Replica 1   |              |     Worker Replica 2   |
  +-----------------------+              +------------------------+
```

---

## 2. Core Invariants & Engineering Guarantees

1. **Inventory Non-Negativity (`available >= 0`):**
   - Catalog quantities are protected by database-level check constraints and row-level locks acquired in deterministic sorted SKU order, preventing race-condition deadlocks.
2. **Cross-Replica Same-Key Idempotency:**
   - Competing requests with the same `Idempotency-Key` are serialized across all API replicas via PostgreSQL advisory transaction locks (`pg_advisory_xact_lock(hashtextextended(key, 0))`).
   - Identical payloads return the same original `202 Accepted` receipt without re-allocating stock.
   - Altered payloads sharing a previously used key are rejected with `409 IDEMPOTENCY_CONFLICT`.
3. **Durable Outbox & Exactly-Once Business Outcome:**
   - Order creation, stock reservation, and worker job insertion occur in a single atomic transaction.
   - Workers claim pending or expired jobs using `FOR UPDATE SKIP LOCKED`.
   - Expired processing leases (>30 s) are safely reclaimed by surviving workers if a worker dies mid-flight.
   - The `fulfillment_receipts` table enforces a unique `order_id` constraint in the completion transaction, preventing double-fulfillment on duplicate job deliveries.
4. **Bounded Retries & Poison-Message Isolation:**
   - Failing jobs retry up to 3 attempts with exponential backoff and randomized jitter (`next_attempt_at`).
   - Poison messages are moved to `dead_letter`, marking the order `failed` and preserving `last_error` for audit without blocking subsequent orders or entering infinite loops.

---

## 3. Team Members & Individual Ownership

| Contributor | Role & Core Ownership |
|---|---|
| **Willy Junior Tatchi** (`tatchi-feudjio.willy-junior@epita.fr`) | **Data Tier, Concurrency & Resilience Lead:** Implemented transactional advisory locking for cross-replica idempotency, multi-line SKU aggregation, receipt tracking schema/migrations, lease-timeout worker recovery, contract error handlers, integration test suite (`idempotency.integration.test.js`, `recovery.integration.test.js`), latency benchmarking, and postmortem documentation. |
| **Kelyan Ihinack** (`kelyan-paul-owen.ihinack@epita.fr`) | **Asynchronous Worker & Observability Lead:** Authored the worker polling loop with atomic `SKIP LOCKED` job claiming, exponential backoff with jitter and dead-letter logic, worker graceful shutdown, Prometheus metrics modules (`api/src/metrics.js`, `worker/src/metrics.js`), SLO definitions, and STRIDE threat modeling. |
| **Fred Njike** (`skyly813@gmail.com`) | **DevOps & Infrastructure Lead:** Designed multi-stage non-root Dockerfiles, Docker Compose multi-service architecture, GitHub Actions CI pipeline (lint, tests, SBOM generation, Trivy blocking/informational scans), Kubernetes manifests (`infra/k8s`), and Argo CD GitOps Application (`infra/argocd`). |

### Individual Notes (Willy Junior Tatchi)
- **Personally Implemented:** PostgreSQL migration runner (`db/migrate.js`), transactional advisory lock serialization across multiple API instances, multi-line item aggregation before inventory check, `fulfillment_receipts` idempotency barrier, integration race tests, and worker crash recovery tests.
- **Reviewed:** Docker Compose healthcheck dependencies, worker exponential backoff module, and CI vulnerability scan rules.
- **Next Steps / Improvements:** Implement read-only database replicas for catalog endpoints and a dedicated operator dashboard to review and requeue dead-lettered jobs.

---

## 4. Local Quickstart (Docker Compose)

The Compose stack starts **1 PostgreSQL database**, **1 one-shot migration runner**, **2 API replicas** (`:8080`, `:8081`), and **2 Worker replicas**.

### Prerequisites
- Docker Engine & Docker Compose v2 (e.g., Docker Desktop)
- Python 3.11+ (for public verification scripts)
- Node.js 22 LTS (optional, only if running tests directly on host)

### Fresh Install
```bash
# 1. Clone repository and navigate to root
cd fulfillops

# 2. Configure environment from template
cp .env.example .env
# On Windows PowerShell:
# if (!(Test-Path .env)) { Copy-Item .env.example .env }

# 3. Build and launch all services with healthchecks
docker compose up -d --build --wait

# 4. Verify running containers
docker compose ps
```

### Health & Readiness Probes
```bash
# API Replica 1
curl -s http://localhost:8080/health/ready
# Expected: {"status":"ready"}

# API Replica 2
curl -s http://localhost:8081/health/ready
# Expected: {"status":"ready"}

# View seeded catalog
curl -s http://localhost:8080/api/v1/catalog
```

### Test Data Reset (Isolated Test DB Only)
```bash
# Reset catalog inventory to initial state (7 KIT-100, 12 PART-200, 5 PACK-300)
# Linux/macOS/Git Bash:
./scripts/reset-test-data.sh

# Windows PowerShell:
docker compose exec -T db psql -U fulfillops -d fulfillops_db -c "TRUNCATE order_items, worker_jobs, orders CASCADE; UPDATE catalog SET available = 7 WHERE sku = 'KIT-100'; UPDATE catalog SET available = 12 WHERE sku = 'PART-200'; UPDATE catalog SET available = 5 WHERE sku = 'PACK-300';"
```

### Teardown
```bash
# Stop containers (preserves database volume)
docker compose down

# Stop and permanently erase database volume (fresh start next run)
docker compose down -v
```

---

## 5. Automated Testing & Verification

### 1. Public API Contract Checker (15 Checks)
Always run against a freshly reset test database:
```bash
# Reset test database first
docker compose exec -T db psql -U fulfillops -d fulfillops_db -c "TRUNCATE order_items, worker_jobs, orders CASCADE; UPDATE catalog SET available = 7 WHERE sku = 'KIT-100'; UPDATE catalog SET available = 12 WHERE sku = 'PART-200'; UPDATE catalog SET available = 5 WHERE sku = 'PACK-300';"

# Run all 15 public contract checks including concurrency and stress tests
python tests/fulfillops_public_checker.py --base-url http://localhost:8080 --concurrency --stress
# Expected: RESULT: 15 passed / 0 failed / 0 skipped
```

### 2. Comprehensive Test Suite (`npm test`)
Exercises unit tests, multi-instance API races, duplicate-key replays, worker crash recovery, and poison message dead-letter handling:
```bash
# Point to your local PostgreSQL port (e.g. 5432)
# Windows PowerShell:
$env:DATABASE_URL = "postgres://fulfillops:CHANGE_ME_LOCAL_ONLY@127.0.0.1:5432/fulfillops_db"
npm test
Remove-Item Env:DATABASE_URL

# Linux / macOS:
DATABASE_URL="postgres://fulfillops:CHANGE_ME_LOCAL_ONLY@127.0.0.1:5432/fulfillops_db" npm test
# Expected: 9 passed / 0 failed
```

### 3. API Latency Benchmark (SLO Proof)
```bash
python tests/measure_latency.py --base-url http://localhost:8080 --count 200 --output docs/evidence/local-latency-2026-11-14.csv
```

### 4. Continuous Rolling-Update Availability Probe
```bash
python tests/fulfillops_rollout_probe.py --base-url http://localhost:8080 --path /health/ready --duration 30 --interval 0.25 --output docs/evidence/rollout-probe-2026-11-14.csv
```

---

## 6. Kubernetes & GitOps (Argo CD)

Manifests are located in `infra/k8s/` and include:
- `namespace.yaml`: dedicated `fulfillops` namespace.
- `postgres.yaml`: PersistentVolumeClaim + PostgreSQL StatefulSet/Deployment with secret references.
- `api-deployment.yaml`: **2 API replicas**, non-root user (UID 1000), CPU/memory requests and limits, readiness/liveness HTTP probes, initContainer migrator.
- `worker-deployment.yaml`: **2 Worker replicas**, non-root user, probe endpoints on `:9100`, initContainer migrator.

### Deployment on a Local `kind` Cluster
```bash
# 1. Create kind cluster
kind create cluster --name fulfillops --wait 120s

# 2. Build and load local application image
docker build -t fulfillops:local .
kind load docker-image fulfillops:local --name fulfillops

# 3. Create namespace and database secret (never committed to git)
kubectl apply -f infra/k8s/namespace.yaml
kubectl -n fulfillops create secret generic db-secret \
  --from-literal=DATABASE_URL="postgres://fulfillops:secret_password@postgres:5432/fulfillops_db" \
  --from-literal=POSTGRES_USER="fulfillops" \
  --from-literal=POSTGRES_PASSWORD="secret_password" \
  --from-literal=POSTGRES_DB="fulfillops_db"

# 4. Apply Kubernetes manifests
kubectl apply -k infra/k8s/
# or: kubectl apply -f infra/k8s/

# 5. Verify rollout status
kubectl -n fulfillops rollout status deployment/fulfillops-api
kubectl -n fulfillops rollout status deployment/fulfillops-worker

# 6. Port forward API service
kubectl -n fulfillops port-forward svc/fulfillops-api 8080:80
```

### Argo CD GitOps Application
The GitOps configuration is managed in `infra/argocd/application.yaml`. When installed into the cluster, Argo CD watches the `main` branch and reconciles cluster state automatically:
```bash
# Install Argo CD into the cluster
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Apply the FulfillOps Application
kubectl apply -f infra/argocd/application.yaml
```

---

## 7. CI/CD & Supply Chain Security

The GitHub Actions workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) triggers on every push and PR to `main`:

1. **Test Job:** Spins up a service container with PostgreSQL 16, runs database migrations (`node db/migrate.js`), executes linting, and runs integration tests.
2. **Build & Supply Chain Scan Job:**
   - Multi-stage Docker build producing an immutable image tag (`fulfillops:${{ github.sha }}`).
   - Generates an SPDX JSON **Software Bill of Materials (SBOM)** via Anchore and publishes it as a build artifact.
   - Executes **Trivy vulnerability scanning** with an enforced quality gate:
     - **Blocking:** Fails the pipeline if any unfixed `CRITICAL` or `HIGH` vulnerabilities exist.
     - **Informational:** Reports `MEDIUM` and `LOW` issues without failing.
3. **Blackbox Verification Job:** Spins up an ephemeral Compose stack and executes `fulfillops_public_checker.py --concurrency --stress` to ensure contract conformity before merging.

---

## 8. Observability & SLOs

Prometheus metrics are exposed on:
- API: `GET http://localhost:8080/metrics`
- Worker: `GET http://localhost:9100/metrics`

### Key Exposed Metrics
- `fulfillops_http_requests_total{method, path, status}`
- `fulfillops_http_request_duration_seconds{method, path}` (Histogram)
- `fulfillops_orders_created_total`
- `fulfillops_orders_failed_total`
- `fulfillops_worker_retries_total`
- `fulfillops_worker_jobs_processed_total{result="completed|dead_letter"}`
- `fulfillops_worker_queue_depth`

For complete PromQL alerts and local latency analysis, see [docs/slo.md](docs/slo.md).

---

## 9. Documentation Index

- [Architecture & Invariants Guide](docs/architecture.md)
- [ADR-001: PostgreSQL Transactions & Outbox Worker Table](docs/ADR-001.md)
- [STRIDE Threat Model](docs/threat-model.md)
- [Incident Postmortem & Fault Drills](docs/incident-postmortem.md)
- [SLO Targets, PromQL & Latency Analysis](docs/slo.md)
- [Validation Evidence Log](docs/validation.md)
- [Assistance & External Code Log](docs/assistance-log.md)

---

## 10. License

Educational and capstone laboratory use only (Epita Bachelor in Computer Science).
