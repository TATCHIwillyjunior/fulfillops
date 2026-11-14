'use strict';
// Worker settings, all overridable with environment variables.
module.exports = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://fulfillops:fulfillops_pass@db:5432/fulfillops_db',
  pollIntervalMs: Number(process.env.WORKER_POLL_MS || 1000),     // wait when the queue is empty
  workDurationMs: Number(process.env.WORKER_WORK_MS || 2000),     // simulated fulfilment time
  lockTimeoutSec: Number(process.env.WORKER_LOCK_TIMEOUT_S || 30), // a job locked longer than this is reclaimed
  backoffBaseMs: Number(process.env.WORKER_BACKOFF_BASE_MS || 1000),
  backoffMaxMs: Number(process.env.WORKER_BACKOFF_MAX_MS || 30000),
  metricsPort: Number(process.env.WORKER_METRICS_PORT || 9100),
  poisonCustomer: process.env.WORKER_POISON_CUSTOMER || 'CUST-POISON'
};
