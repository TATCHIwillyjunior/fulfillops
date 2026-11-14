'use strict';

/**
 * FulfillOps Master Test Suite
 * Consolidates all unit, concurrency, idempotency, and worker crash recovery tests into a single file.
 * Run directly with: node --test tests/all.test.js  (or npm test)
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { Pool } = require('pg');

// Resolve database URL for host execution (replaces Docker internal 'db' hostname with 127.0.0.1)
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL.replace('@db:5432', '@127.0.0.1:5432');
  }
  return 'postgres://fulfillops:CHANGE_ME_LOCAL_ONLY@127.0.0.1:5432/fulfillops_db';
}

const databaseUrl = resolveDatabaseUrl();
process.env.DATABASE_URL = databaseUrl;

// Require worker modules AFTER DATABASE_URL has been resolved for localhost
const { backoffMs, nextState, failJob } = require('../worker/src/retry');
const { pool: workerPool, completeJob } = require('../worker/src/db');

// Reset stock before starting tests so tests are always idempotent
before(async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      UPDATE catalog SET available = 7 WHERE sku = 'KIT-100';
      UPDATE catalog SET available = 12 WHERE sku = 'PART-200';
      UPDATE catalog SET available = 5 WHERE sku = 'PACK-300';
    `);
  } finally {
    await pool.end();
  }
});

// Helper: find unused ports for spinning up isolated API replicas
async function unusedPorts(count) {
  const servers = Array.from({ length: count }, () => net.createServer());
  await Promise.all(servers.map(server => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  })));
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  })));
  return ports;
}

// Helper: spawn API process
function startApi(port) {
  const child = spawn(process.execPath, ['api/src/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, getOutput: () => output };
}

async function stopApi(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill();
  await new Promise(resolve => instance.child.once('exit', resolve));
}

async function waitUntilReady(instance, url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(`API process exited before readiness:\n${instance.getOutput()}`);
    }
    try {
      const response = await fetch(`${url}/health/ready`);
      if (response.status === 200) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`API did not become ready:\n${instance.getOutput()}`);
}

// Helper: spawn Worker process
function startWorker(overrides = {}) {
  const child = spawn(process.execPath, ['worker/src/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
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

// ============================================================================
// 1. UNIT TESTS: RETRY, BACKOFF & JITTER
// ============================================================================

test('backoff doubles with each attempt', () => {
  const noJitter = () => 0;
  assert.equal(backoffMs(1, { base: 1000, max: 30000, random: noJitter }), 1000);
  assert.equal(backoffMs(2, { base: 1000, max: 30000, random: noJitter }), 2000);
  assert.equal(backoffMs(3, { base: 1000, max: 30000, random: noJitter }), 4000);
});

test('backoff is capped at the maximum', () => {
  assert.equal(backoffMs(10, { base: 1000, max: 30000, random: () => 0 }), 30000);
});

test('jitter adds at most 20%', () => {
  assert.equal(backoffMs(1, { base: 1000, max: 30000, random: () => 1 }), 1200);
});

test('job is retried while attempts remain', () => {
  assert.equal(nextState(1, 3), 'pending');
  assert.equal(nextState(2, 3), 'pending');
});

test('job is dead-lettered after max attempts', () => {
  assert.equal(nextState(3, 3), 'dead_letter');
});

// ============================================================================
// 2. INTEGRATION TESTS: CONCURRENCY & IDEMPOTENCY ACROSS 2 API INSTANCES
// ============================================================================

test('same idempotency key is accepted once across two API instances', async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ports = await unusedPorts(2);
  const instances = ports.map(startApi);
  const urls = ports.map(port => `http://127.0.0.1:${port}`);
  const key = `same-key-${crypto.randomUUID()}`;
  let orderId;

  try {
    await Promise.all(instances.map((instance, index) => waitUntilReady(instance, urls[index])));
    await pool.query("UPDATE catalog SET available = 7 WHERE sku = 'KIT-100'; UPDATE catalog SET available = 12 WHERE sku = 'PART-200';");

    const before = await pool.query(
      'SELECT sku, available FROM catalog WHERE sku = ANY($1)',
      [['KIT-100', 'PART-200']]
    );
    assert.equal(before.rows.length, 2, 'test database must contain seeded inventory');
    const initialInventory = Object.fromEntries(before.rows.map(row => [row.sku, row.available]));

    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      fetch(`${urls[index % urls.length]}/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key
        },
        body: JSON.stringify({
          customer_id: 'CUST-IDEMPOTENCY-TEST',
          items: [
            { sku: 'KIT-100', quantity: 1 },
            { sku: 'PART-200', quantity: 1 },
            { sku: 'KIT-100', quantity: 1 }
          ]
        })
      }).then(async response => ({ status: response.status, body: await response.json() }))
    ));

    assert.deepEqual(responses.map(response => response.status), Array(8).fill(202));
    const orderIds = new Set(responses.map(response => response.body.order_id));
    assert.equal(orderIds.size, 1, 'all replicas must return the same order ID');
    orderId = responses[0].body.order_id;
    assert.ok(orderId);
    assert.ok(responses.every(response => response.body.status === 'queued'));

    const after = await pool.query(
      'SELECT sku, available FROM catalog WHERE sku = ANY($1)',
      [['KIT-100', 'PART-200']]
    );
    const reservedInventory = Object.fromEntries(after.rows.map(row => [row.sku, row.available]));
    assert.equal(reservedInventory['KIT-100'], initialInventory['KIT-100'] - 2);
    assert.equal(reservedInventory['PART-200'], initialInventory['PART-200'] - 1);

    const persisted = await pool.query(
      'SELECT COUNT(*)::int AS count FROM orders WHERE idempotency_key = $1',
      [key]
    );
    assert.equal(persisted.rows[0].count, 1);

    // Restart API 1 and verify that replaying returns the exact same receipt without re-decrementing
    await stopApi(instances[0]);
    instances[0] = startApi(ports[0]);
    await waitUntilReady(instances[0], urls[0]);
    const replay = await fetch(`${urls[0]}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key
      },
      body: JSON.stringify({
        customer_id: 'CUST-IDEMPOTENCY-TEST',
        items: [
          { sku: 'PART-200', quantity: 1 },
          { sku: 'KIT-100', quantity: 2 }
        ]
      })
    });
    const replayBody = await replay.json();
    assert.equal(replay.status, 202);
    assert.deepEqual(replayBody, { order_id: orderId, status: 'queued' });

    const afterReplay = await pool.query(
      'SELECT sku, available FROM catalog WHERE sku = ANY($1)',
      [['KIT-100', 'PART-200']]
    );
    assert.deepEqual(
      Object.fromEntries(afterReplay.rows.map(row => [row.sku, row.available])),
      reservedInventory
    );
  } finally {
    await Promise.all(instances.map(stopApi));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE catalog c
            SET available = c.available + oi.quantity
           FROM order_items oi
           JOIN orders o ON o.order_id = oi.order_id
          WHERE o.idempotency_key = $1 AND c.sku = oi.sku`,
        [key]
      );
      await client.query('DELETE FROM orders WHERE idempotency_key = $1', [key]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await pool.end();
  }
});

test('distinct keys compete atomically for limited stock across two API instances', async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ports = await unusedPorts(2);
  const instances = ports.map(startApi);
  const urls = ports.map(port => `http://127.0.0.1:${port}`);
  const prefix = `distinct-${crypto.randomUUID()}-`;

  try {
    await Promise.all(instances.map((instance, index) => waitUntilReady(instance, urls[index])));
    await pool.query("UPDATE catalog SET available = 5 WHERE sku = 'PACK-300'");

    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      fetch(`${urls[index % urls.length]}/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `${prefix}${index}`
        },
        body: JSON.stringify({
          customer_id: 'CUST-DISTINCT-RACE-TEST',
          items: [{ sku: 'PACK-300', quantity: 1 }]
        })
      }).then(async response => ({ status: response.status, body: await response.json() }))
    ));

    assert.equal(responses.filter(response => response.status === 202).length, 5);
    const rejected = responses.filter(response => response.status === 409);
    assert.equal(rejected.length, 3);
    assert.ok(rejected.every(response => response.body.error.code === 'OUT_OF_STOCK'));

    const inventory = await pool.query(
      "SELECT available FROM catalog WHERE sku = 'PACK-300'"
    );
    assert.equal(inventory.rows[0].available, 0);

    const persisted = await pool.query(
      "SELECT COUNT(*)::int AS count FROM orders WHERE idempotency_key LIKE $1",
      [`${prefix}%`]
    );
    assert.equal(persisted.rows[0].count, 5);
  } finally {
    await Promise.all(instances.map(stopApi));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE catalog c
            SET available = c.available + reserved.quantity
           FROM (
             SELECT oi.sku, SUM(oi.quantity)::int AS quantity
               FROM order_items oi
               JOIN orders o ON o.order_id = oi.order_id
              WHERE o.idempotency_key LIKE $1
              GROUP BY oi.sku
           ) reserved
          WHERE c.sku = reserved.sku`,
        [`${prefix}%`]
      );
      await client.query('DELETE FROM orders WHERE idempotency_key LIKE $1', [`${prefix}%`]);
      await client.query("UPDATE catalog SET available = 5 WHERE sku = 'PACK-300'");
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await pool.end();
  }
});

test('API returns contract errors for invalid JSON and idempotency keys', async () => {
  const [port] = await unusedPorts(1);
  const instance = startApi(port);
  const url = `http://127.0.0.1:${port}`;

  try {
    await waitUntilReady(instance, url);
    const unknownOrder = await fetch(`${url}/api/v1/orders/not-a-uuid`);
    assert.equal(unknownOrder.status, 404);
    assert.equal((await unknownOrder.json()).error.code, 'ORDER_NOT_FOUND');

    const invalidJson = await fetch(`${url}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'invalid-json-test'
      },
      body: '{"customer_id":'
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON');

    const invalidKey = await fetch(`${url}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${'a'.repeat(7)}\u00e9`
      },
      body: JSON.stringify({
        customer_id: 'CUST-IDEMPOTENCY-TEST',
        items: [{ sku: 'KIT-100', quantity: 1 }]
      })
    });
    assert.equal(invalidKey.status, 400);
    assert.equal((await invalidKey.json()).error.code, 'IDEMPOTENCY_REQUIRED');

    const invalidSku = await fetch(`${url}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'invalid-sku-test'
      },
      body: JSON.stringify({
        customer_id: 'CUST-IDEMPOTENCY-TEST',
        items: [{ sku: '__proto__', quantity: 1 }]
      })
    });
    assert.equal(invalidSku.status, 422);
    assert.equal((await invalidSku.json()).error.code, 'INVALID_SKU');

    const tooLarge = await fetch(`${url}/api/v1/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'oversized-body-test'
      },
      body: JSON.stringify({
        customer_id: 'CUST-IDEMPOTENCY-TEST',
        items: [{ sku: 'KIT-100', quantity: 1 }],
        extra: 'x'.repeat(17 * 1024)
      })
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error.code, 'REQUEST_TOO_LARGE');
  } finally {
    await stopApi(instance);
  }
});

// ============================================================================
// 3. INTEGRATION TESTS: WORKER CRASH RECOVERY & POISON-MESSAGE ISOLATION
// ============================================================================

test('worker crash is recovered exactly once and poison jobs are dead-lettered', async () => {
  const pool = new Pool({ connectionString: databaseUrl });
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
  }
});
