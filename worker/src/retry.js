'use strict';
const config = require('./config');

// Exponential backoff: base * 2^(attempt-1), capped, plus up to 20% random jitter
// so that many failing jobs do not retry at exactly the same moment.
function backoffMs(attempt, { base = config.backoffBaseMs, max = config.backoffMaxMs, random = Math.random } = {}) {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp + exp * 0.2 * random());
}

// Decide what happens to a failed job: retry later, or dead-letter it.
function nextState(attempts, maxAttempts) {
  return attempts >= maxAttempts ? 'dead_letter' : 'pending';
}

// Record a failure in one transaction.
// - attempts left  -> back to 'pending', claimable again after the backoff delay
// - no attempts left -> 'dead_letter' and the order becomes 'failed'
async function failJob(pool, job, err) {
  const state = nextState(job.attempts, job.max_attempts);
  const delay = backoffMs(job.attempts);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (state === 'dead_letter') {
      const { rowCount } = await client.query(
        `UPDATE worker_jobs SET status = 'dead_letter', locked_at = NULL, last_error = $1, updated_at = NOW()
          WHERE job_id = $2 AND status = 'processing' AND attempts = $3`,
        [String(err.message).slice(0, 500), job.job_id, job.attempts]
      );
      if (rowCount === 0) {
        await client.query('COMMIT');
        return { state: 'stale', delay: 0 };
      }
      await client.query(
        `UPDATE orders SET status = 'failed', updated_at = NOW() WHERE order_id = $1`,
        [job.order_id]
      );
    } else {
      const { rowCount } = await client.query(
        `UPDATE worker_jobs
            SET status = 'pending', locked_at = NULL, last_error = $1, updated_at = NOW(),
                next_attempt_at = NOW() + make_interval(secs => $2)
          WHERE job_id = $3 AND status = 'processing' AND attempts = $4`,
        [String(err.message).slice(0, 500), delay / 1000, job.job_id, job.attempts]
      );
      if (rowCount === 0) {
        await client.query('COMMIT');
        return { state: 'stale', delay: 0 };
      }
      await client.query(
        `UPDATE orders SET status = 'queued', updated_at = NOW() WHERE order_id = $1`,
        [job.order_id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { state, delay };
}

module.exports = { backoffMs, nextState, failJob };
