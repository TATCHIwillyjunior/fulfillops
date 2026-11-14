-- Migration 002: retry scheduling for the outbox worker
-- next_attempt_at lets a failed job wait (exponential backoff) before it can be claimed again.

ALTER TABLE worker_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE worker_jobs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Fast lookup of the next claimable job
CREATE INDEX IF NOT EXISTS idx_worker_jobs_claimable
  ON worker_jobs (status, next_attempt_at, job_id);
