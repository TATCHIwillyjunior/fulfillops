# FulfillOps architecture

## Components and request flow

```text
Client
  |
  v
API replicas (Express) ---------------------> Prometheus scrape: /metrics
  |  validate request; normalize item lines
  |  PostgreSQL transaction:
  |    1. advisory transaction lock for the idempotency key
  |    2. replay check and payload comparison
  |    3. lock catalog rows in SKU order
  |    4. reserve stock, persist order/items, enqueue worker job
  v
PostgreSQL (catalog, orders, order_items, worker_jobs, fulfillment_receipts)
  ^
  |  SKIP LOCKED claim; expiring processing lease; bounded retry/backoff
  |
Worker replicas ---------------------------> Prometheus scrape: /metrics
```

The API and worker are separate processes. PostgreSQL is the shared source of
truth for inventory, idempotency, accepted orders, work delivery and the
fulfillment receipt. Docker Compose starts two API instances and two workers;
the Kubernetes manifests declare the same replica counts.

## Data and invariants

- `catalog.available` has a nonnegative database check constraint. Reservation
  is performed while the relevant catalog rows are locked and is committed in
  the same transaction as the order and its worker job.
- An idempotency key is unique in `orders`. PostgreSQL transaction advisory
  locks serialize simultaneous submissions of that key across API processes.
  The request hash is based on the customer and SKU lines after aggregation
  and SKU sorting, so line ordering and duplicate SKU lines do not change the
  payload identity.
- A successful acceptance has a durable `orders` row, `order_items`, reserved
  inventory and a `worker_jobs` row before the API sends `202`.
- Workers claim work with `FOR UPDATE SKIP LOCKED`. A stale processing lease
  can be reclaimed. Attempts and retry scheduling are persisted; exhausted
  work is marked dead-lettered and the order failed. Completion and failure
  updates must match the current processing attempt, so a late result from an
  expired worker cannot overwrite the replacement worker's state. Reserved
  stock is not automatically restored.
- `fulfillment_receipts.order_id` is unique. Receipt insertion, order
  completion and job completion occur in one transaction. This gives the
  local lab's persisted fulfillment effect one receipt per order even if job
  delivery is at least once. The current fulfillment operation is simulated;
  a future external side effect would need its own idempotency mechanism.

## Operational boundaries

The API readiness endpoint checks database connectivity, while liveness is
independent of the database. Database credentials are supplied through
environment configuration or Kubernetes Secret references, not source files.
The API exposes request counters and latency histograms; the worker exposes
retry, processing and queue-depth metrics on its internal metrics listener.

Database migrations are in `db/migrations/`. A clean local test database must
run all migrations before API or worker tests. The public checker and reset
script are for an isolated test database only.