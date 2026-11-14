# Controlled worker interruption and poison-job exercise

**Environment:** isolated local PostgreSQL test database; no production or
shared classroom services were used.
**Exercise date:** 2026-11-14
**Result:** recovery and bounded failure behavior passed.

## Summary

This was a deliberate fault-injection test, not an unplanned production
incident. A worker was terminated while its job was in `processing`. A second
worker reclaimed the stale lease and completed the order. A separate poison
order exhausted its retry budget and was retained for operator review.

## Timeline and observed evidence

1. Inserted a test order and durable worker job in a freshly migrated database.
2. Started a worker with a long simulated processing duration. The database
   showed the job as `processing` with `attempts = 1`.
3. Force-terminated that worker before it could complete the job.
4. Started a replacement worker with a one-second lock timeout. The job was
   reclaimed and reached `completed` with `attempts = 2`.
5. Queried the persisted receipt table: exactly one receipt existed for the
   recovered order. Receipt insertion and job/order completion share one
   transaction.
6. Submitted a stale attempt-1 completion and failure after attempt 2 had
   completed. Both were ignored; the order and job remained completed and the
   receipt count remained one.
7. Inserted a deterministic poison job. It reached `dead_letter` after exactly
   three attempts; its order was `failed`, `last_error` was retained, and no
   fulfillment receipt was written.

The automated evidence is
`worker/test/recovery.integration.test.js`, which reports
`worker crash is recovered exactly once and poison jobs are dead-lettered`.
The observed test took approximately seven seconds with the test's shortened
retry settings.

## Impact, cause and recovery

The first worker interruption left an accepted job durably recorded with an
expired processing lease. No order or inventory record was erased. The
replacement worker recovered the job through the persisted lease timeout.
The poison message was isolated by the bounded retry policy rather than
blocking subsequent work.

## Follow-up and limitations

- Keep the lease timeout longer than normal processing time and monitor
  expired processing jobs and dead-letter counts.
- The receipt is the lab's local persisted fulfillment effect. No external
  shipping/payment side effect is integrated or claimed.
- A separate healthy API rolling restart was observed in kind: the
  30-second probe recorded 121/121 HTTP 200 responses. The raw samples are in
  `docs/evidence/rollout-probe-2026-11-14.csv`.
- A faulty API revision and its restoration through GitOps were not performed.
  The successful restart is not a substitute for that recovery drill.