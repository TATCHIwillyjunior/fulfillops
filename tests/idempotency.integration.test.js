'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

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

function startApi(port) {
  const child = spawn(process.execPath, ['api/src/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
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

test('same idempotency key is accepted once across two API instances', {
  skip: !databaseUrl && 'Set DATABASE_URL to a freshly migrated isolated test database'
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ports = await unusedPorts(2);
  const instances = ports.map(startApi);
  const urls = ports.map(port => `http://127.0.0.1:${port}`);
  const key = `same-key-${require('node:crypto').randomUUID()}`;
  let orderId;

  try {
    await Promise.all(instances.map((instance, index) => waitUntilReady(instance, urls[index])));
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

test('distinct keys compete atomically for limited stock across two API instances', {
  skip: !databaseUrl && 'Set DATABASE_URL to a freshly migrated isolated test database'
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ports = await unusedPorts(2);
  const instances = ports.map(startApi);
  const urls = ports.map(port => `http://127.0.0.1:${port}`);
  const prefix = `distinct-${require('node:crypto').randomUUID()}-`;

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

test('API returns contract errors for invalid JSON and idempotency keys', {
  skip: !databaseUrl && 'Set DATABASE_URL to a freshly migrated isolated test database'
}, async () => {
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
