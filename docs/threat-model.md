# FulfillOps Threat Model (worker, queue and metrics)

Scope: the async worker, the `worker_jobs` outbox table and the Prometheus metrics.
Method: STRIDE. Each threat has a mitigation that exists in the code or the deployment.

## Assets
- Orders and their status (`orders`)
- Stock levels (`catalog.available`)
- The job queue (`worker_jobs`)
- Database credentials (`DATABASE_URL`)

## Trust boundaries
1. Client to API (public HTTP)
2. API and worker to PostgreSQL (internal network)
3. Prometheus to `/metrics` (internal scrape)

## Threats and mitigations

| # | STRIDE | Threat | Mitigation |
|---|--------|--------|------------|
| T1 | Tampering | Two workers process the same job and fulfil an order twice | Jobs are claimed with `FOR UPDATE SKIP LOCKED` in a transaction; only one worker can hold a job |
| T2 | Denial of service | A poison order fails forever and blocks the queue | Max 3 attempts, then `dead_letter`; the order is marked `failed` and the loop moves on |
| T3 | Denial of service | Failing jobs retry in a tight loop and overload the DB | Exponential backoff with jitter (`next_attempt_at`), capped at 30 s |
| T4 | Denial of service | A worker crashes mid-job and the job is stuck in `processing` | Locks older than 30 s are reclaimed by another worker |
| T5 | Repudiation | No trace of why an order failed | `last_error` is stored on the job; every attempt is logged |
| T6 | Information disclosure | DB password leaked through Git or logs | Password comes from env / Kubernetes Secret, `.env` is git-ignored, logs never print `DATABASE_URL` |
| T7 | Information disclosure | `/metrics` exposes internal data publicly | Worker metrics port 9100 is not published by a public Service; metrics hold counts only, no customer data |
| T8 | Elevation of privilege | Compromised container gets root | Image runs as the non-root `node` user; no privileged mode |
| T9 | Tampering | SQL injection through job data | All queries are parameterised (`$1`, `$2`), no string concatenation |
| T10 | Denial of service | Too many DB connections from many replicas | Pool limited to 5 connections per worker |

## Residual risks
- The DB user can read and write every table; a separate least-privilege role for the worker would be better.
- Dead-lettered jobs are not replayed automatically; an operator must requeue them.
