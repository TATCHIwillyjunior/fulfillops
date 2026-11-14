'use strict';
const { Pool } = require('pg');
const crypto = require('node:crypto');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });

// Claim ONE job atomically. SKIP LOCKED lets several worker replicas run
// without ever taking the same job. A job stuck in 'processing' (worker died)
// is reclaimed once its lock is older than lockTimeoutSec.
async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT j.job_id, j.order_id, j.attempts, j.max_attempts, o.customer_id
         FROM worker_jobs j
         JOIN orders o ON o.order_id = j.order_id
        WHERE (j.status = 'pending' AND j.next_attempt_at <= NOW())
           OR (j.status = 'processing' AND j.locked_at < NOW() - make_interval(secs => $1))
        ORDER BY j.job_id
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1`,
      [config.lockTimeoutSec]
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const job = rows[0];
    await client.query(
      `UPDATE worker_jobs
          SET status = 'processing', locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
        WHERE job_id = $1`,
      [job.job_id]
    );
    await client.query(
      `UPDATE orders SET status = 'processing', updated_at = NOW() WHERE order_id = $1`,
      [job.order_id]
    );
    await client.query('COMMIT');
    job.attempts += 1;
    return job;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Mark the job and its order completed in one transaction.
async function completeJob(job) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `UPDATE worker_jobs
          SET status = 'completed', locked_at = NULL, updated_at = NOW()
        WHERE job_id = $1 AND status = 'processing' AND attempts = $2
        RETURNING order_id`,
      [job.job_id, job.attempts]
    );
    if (claimed.rowCount === 0) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      `INSERT INTO fulfillment_receipts (order_id, receipt_id)
       VALUES ($1, $2)
       ON CONFLICT (order_id) DO NOTHING`,
      [job.order_id, crypto.randomUUID()]
    );
    await client.query(
      `UPDATE orders SET status = 'completed', updated_at = NOW() WHERE order_id = $1`,
      [job.order_id]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, claimJob, completeJob };
