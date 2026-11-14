'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

function startWorker(overrides = {}) {
  const child = spawn(process.execPath, ['worker/src/index.js'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      WORKER_METRICS_PORT: '0',
      WORKER_POLL_MS: '25',
      ...overrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, getOutput: () => output };
}

async function stopWorker(worker, signal = 'SIGTERM') {
  if (!worker || worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill(signal);
  await new Promise(resolve => worker.child.once('exit', resolve));
}

async function waitForOrder(pool, orderId, expectedStatus, worker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (worker && (worker.child.exitCode !== null || worker.child.signalCode !== null)) {
      throw new Error(`Worker exited unexpectedly:\n${worker.getOutput()}`);
    }
    const { rows } = await pool.query(
      'SELECT status FROM orders WHERE order_id = $1',
      [orderId]
    );
    if (rows[0] && rows[0].status === expectedStatus) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Order did not reach ${expectedStatus}:\n${worker ? worker.getOutput() : ''}`);
}

async function insertJob(pool, customerId, key) {
  const orderId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO orders
         (order_id, customer_id, status, total_cents, idempotency_key, payload_hash)
       VALUES ($1, $2, 'queued', 0, $3, $4)`,
      [orderId, customerId, key, crypto.createHash('sha256').update(key).digest('hex')]
    );
    await client.query('INSERT INTO worker_jobs (order_id) VALUES ($1)', [orderId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return orderId;
}

test('worker crash is recovered exactly once and poison jobs are dead-lettered', {
  skip: !databaseUrl && 'Set DATABASE_URL to a freshly migrated isolated test database'
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const { pool: workerPool, completeJob } = require('../src/db');
  const { failJob } = require('../src/retry');
  const recoveryKey = `worker-recovery-${crypto.randomUUID()}`;
  const poisonKey = `worker-poison-${crypto.randomUUID()}`;
  const children = [];
  let recoveryOrderId;
  let poisonOrderId;

  try {
    recoveryOrderId = await insertJob(pool, 'CUST-CRASH-RECOVERY-TEST', recoveryKey);
    const crashedWorker = startWorker({
      WORKER_WORK_MS: '10000',
      WORKER_LOCK_TIMEOUT_S: '1'
    });
    children.push(crashedWorker);

    const processingDeadline = Date.now() + 10000;
    let attempts = 0;
    while (Date.now() < processingDeadline) {
      const { rows } = await pool.query(
        'SELECT status, attempts FROM worker_jobs WHERE order_id = $1',
        [recoveryOrderId]
      );
      if (rows[0] && rows[0].status === 'processing') {
        attempts = rows[0].attempts;
        break;
      }
      if (crashedWorker.child.exitCode !== null || crashedWorker.child.signalCode !== null) {
        throw new Error(`Worker exited before claiming the job:\n${crashedWorker.getOutput()}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(attempts, 1, 'first worker should have claimed the job once');
    await stopWorker(crashedWorker, 'SIGKILL');

    const recoveredWorker = startWorker({
      WORKER_WORK_MS: '10',
      WORKER_LOCK_TIMEOUT_S: '1',
      WORKER_BACKOFF_BASE_MS: '10',
      WORKER_BACKOFF_MAX_MS: '20'
    });
    children.push(recoveredWorker);
    await waitForOrder(pool, recoveryOrderId, 'completed', recoveredWorker);

    const recovered = await pool.query(
      `SELECT j.job_id, j.status AS job_status, j.attempts, COUNT(r.order_id)::int AS receipts
         FROM worker_jobs j
         LEFT JOIN fulfillment_receipts r ON r.order_id = j.order_id
        WHERE j.order_id = $1
        GROUP BY j.job_id, j.status, j.attempts`,
      [recoveryOrderId]
    );
    assert.deepEqual(recovered.rows[0], {
      job_id: recovered.rows[0].job_id,
      job_status: 'completed',
      attempts: 2,
      receipts: 1
    });
    const staleClaim = {
      job_id: recovered.rows[0].job_id,
      order_id: recoveryOrderId,
      attempts: 1,
      max_attempts: 3
    };
    assert.equal(await completeJob(staleClaim), false);
    assert.deepEqual(
      await failJob(workerPool, staleClaim, new Error('stale attempt')),
      { state: 'stale', delay: 0 }
    );
    const afterStaleResult = await pool.query(
      `SELECT o.status AS order_status, j.status AS job_status,
              COUNT(r.order_id)::int AS receipts
         FROM orders o
         JOIN worker_jobs j ON j.order_id = o.order_id
         LEFT JOIN fulfillment_receipts r ON r.order_id = o.order_id
        WHERE o.order_id = $1
        GROUP BY o.status, j.status`,
      [recoveryOrderId]
    );
    assert.deepEqual(afterStaleResult.rows[0], {
      order_status: 'completed',
      job_status: 'completed',
      receipts: 1
    });
    await stopWorker(recoveredWorker);

    poisonOrderId = await insertJob(pool, 'CUST-POISON', poisonKey);
    const poisonWorker = startWorker({
      WORKER_WORK_MS: '1',
      WORKER_LOCK_TIMEOUT_S: '1',
      WORKER_BACKOFF_BASE_MS: '10',
      WORKER_BACKOFF_MAX_MS: '20'
    });
    children.push(poisonWorker);
    await waitForOrder(pool, poisonOrderId, 'failed', poisonWorker);

    const poison = await pool.query(
      `SELECT o.status AS order_status, j.status AS job_status, j.attempts,
              j.max_attempts, j.last_error,
              COUNT(r.order_id)::int AS receipts
         FROM orders o
         JOIN worker_jobs j ON j.order_id = o.order_id
         LEFT JOIN fulfillment_receipts r ON r.order_id = o.order_id
        WHERE o.order_id = $1
        GROUP BY o.status, j.status, j.attempts, j.max_attempts, j.last_error`,
      [poisonOrderId]
    );
    assert.deepEqual(poison.rows[0], {
      order_status: 'failed',
      job_status: 'dead_letter',
      attempts: 3,
      max_attempts: 3,
      last_error: 'Poison message encountered during fulfillment execution',
      receipts: 0
    });
  } finally {
    await Promise.all(children.map(child => stopWorker(child)));
    if (recoveryOrderId || poisonOrderId) {
      await pool.query(
        'DELETE FROM orders WHERE order_id = ANY($1)',
        [[recoveryOrderId, poisonOrderId].filter(Boolean)]
      );
    }
    await pool.end();
    await workerPool.end();
  }
});
