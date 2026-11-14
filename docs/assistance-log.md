# FulfillOps — Assistance and External Code Log

> Required by Capstone Assignment Section 7:  
> *"Cite external code and any AI assistance in docs/assistance-log.md and be able to explain it."*

---

## 1. Team Disclosures & AI Assistance

### AI Assistance (Google Gemini & Anthropic Claude)
- **Architecture & Design Review:** Used for brainstorming edge cases in distributed idempotency, reviewing the PostgreSQL transaction outbox pattern, and designing STRIDE threat mitigations.
- **Scaffolding & Templates:** Initial drafts for multi-stage Dockerfile, GitHub Actions CI workflow skeleton, and PromQL calculation templates.
- **Test Harness Ideas:** Formulation of race condition simulations using Node.js child processes and thread pool execution patterns in the public contract checker.
- **Documentation & Postmortem Structuring:** Formatting templates for `ADR-001.md`, `threat-model.md`, and `incident-postmortem.md` based on industry-standard blameless postmortem conventions.

---

## 2. What We Personally Authored, Debugged, and Verified

### Willy Junior Tatchi (Data Tier, Concurrency & Resilience Lead)
- **Personally Authored & Fixed:**
  - Implemented the cross-replica transactional serialization using PostgreSQL 64-bit advisory locks: `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`.
  - Implemented canonical JSON payload sorting and multi-line SKU aggregation before computing the SHA-256 hash.
  - Authored the database migration engine (`db/migrate.js`) with advisory lock synchronization to prevent concurrent migration collisions.
  - Implemented the idempotent business boundary table `fulfillment_receipts` with a unique constraint on `order_id`.
  - Resolved contract edge cases: UUID format validation for `/api/v1/orders/:order_id` (preventing Postgres syntax crash 500 into proper 404 `ORDER_NOT_FOUND`), Express body-parser error handling for `INVALID_JSON` (400) and `REQUEST_TOO_LARGE` (413).
  - Authored the integration test suite: `tests/idempotency.integration.test.js` (cross-replica 8-request race and competing stock race) and `worker/test/recovery.integration.test.js` (worker crash recovery and poison message dead-lettering).
  - Ran and validated the 15/15 public contract checks with `--concurrency --stress`.
  - Benchmark script `tests/measure_latency.py` recording 200 sequential samples for observed p95 SLO calculation.

### Kelyan Ihinack (Worker Processing & Observability Lead)
- **Personally Authored & Fixed:**
  - Developed the outbox worker polling loop with `FOR UPDATE SKIP LOCKED`.
  - Implemented bounded exponential backoff with randomized jitter and dead-letter queue routing (`worker/src/retry.js`).
  - Authored unit test suite for retry logic (`worker/test/retry.test.js`).
  - Implemented Prometheus metrics exposition using `prom-client` on API (`:8080/metrics`) and Worker (`:9100/metrics`).
  - Authored SLO definitions, PromQL queries, alert thresholds, and the STRIDE threat model (`docs/threat-model.md`, `docs/slo.md`).

### Fred Njike (DevOps & Infrastructure Lead)
- **Personally Authored & Fixed:**
  - Multi-stage non-root Dockerfile using `node:22-alpine` running as the unprivileged `node` user (UID 1000).
  - Docker Compose multi-service architecture with service healthchecks, network segmentation, and volume persistence.
  - GitHub Actions CI workflow with Anchore SPDX SBOM generation, Trivy vulnerability gating (blocking on CRITICAL/HIGH), and ephemeral blackbox testing.
  - Kubernetes manifests (`infra/k8s/`) and Argo CD GitOps Application (`infra/argocd/application.yaml`).

---

## 3. External Libraries & Official References

All external runtime dependencies are open-source packages pinned in `package.json`:
- `express` (v5.3.0) — Lightweight web framework for HTTP API routing.
- `pg` (v8.23.1) — PostgreSQL client and connection pooling.
- `prom-client` (v15.1.3) — Standard Prometheus metrics client for Node.js.

### Official Documentation Consulted:
- PostgreSQL 16 Advisory Locks: https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
- PostgreSQL `SKIP LOCKED`: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
- Node.js Test Runner: https://nodejs.org/api/test.html
- Docker Multi-stage Builds: https://docs.docker.com/build/building/multi-stage/
- Trivy Security Scanner: https://aquasecurity.github.io/trivy/
- Anchore SBOM Action: https://github.com/anchore/sbom-action
- Prometheus Exposition Formats: https://prometheus.io/docs/instrumenting/exposition_formats/
