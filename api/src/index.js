const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const client = require('prom-client');

const app = express();
app.use(express.json({ limit: '16kb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://fulfillops:fulfillops_pass@db:5432/fulfillops_db'
});

// Prometheus Metrics Setup
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const ordersCreatedCounter = new client.Counter({
  name: 'fulfillops_orders_created_total',
  help: 'Total orders created successfully'
});
const ordersFailedCounter = new client.Counter({
  name: 'fulfillops_orders_failed_total',
  help: 'Total orders failed'
});
const httpRequestsCounter = new client.Counter({
  name: 'fulfillops_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status']
});
const httpRequestDuration = new client.Histogram({
  name: 'fulfillops_http_request_duration_seconds',
  help: 'HTTP request duration histogram for p95 calculation',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2.5]
});

register.registerMetric(ordersCreatedCounter);
register.registerMetric(ordersFailedCounter);
register.registerMetric(httpRequestsCounter);
register.registerMetric(httpRequestDuration);

// Metrics Middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer({ method: req.method, route: req.path });
  res.on('finish', () => {
    httpRequestsCounter.inc({ method: req.method, route: req.path, status: res.statusCode });
    end();
  });
  next();
});

// 1. Health Liveness
app.get('/health/live', (req, res) => res.status(200).json({ status: 'ok' }));

// 2. Health Readiness
app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready' });
  }
});

// 3. Catalog API
app.get('/api/v1/catalog', async (req, res) => {
  const { rows } = await pool.query('SELECT sku, unit_price_cents FROM catalog');
  res.status(200).json({ products: rows });
});

// 4. Inventory Lookup
app.get('/api/v1/inventory/:sku', async (req, res) => {
  const { rows } = await pool.query('SELECT sku, available FROM catalog WHERE sku = $1', [req.params.sku]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { code: 'SKU_NOT_FOUND', message: 'SKU not found' } });
  }
  res.status(200).json({ sku: rows[0].sku, available: rows[0].available });
});

// 5. Order Creation (Atomic Reservation + Idempotency)
app.post('/api/v1/orders', async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return res.status(400).json({ error: { code: 'IDEMPOTENCY_REQUIRED', message: 'Missing or invalid Idempotency-Key' } });
  }

  const { customer_id, items } = req.body;
  if (!customer_id || typeof customer_id !== 'string' || customer_id.length > 64 || !Array.isArray(items) || items.length === 0 || items.length > 10) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request body' } });
  }

  // Aggregate SKU lines
  const aggregated = {};
  for (const item of items) {
    if (!item.sku || typeof item.sku !== 'string') {
      return res.status(422).json({ error: { code: 'INVALID_SKU', message: 'Invalid SKU' } });
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      return res.status(422).json({ error: { code: 'INVALID_QUANTITY', message: 'Invalid quantity' } });
    }
    aggregated[item.sku] = (aggregated[item.sku] || 0) + item.quantity;
  }

  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ customer_id, items: aggregated })).digest('hex');
  const dbClient = await pool.connect();

  try {
    await dbClient.query('BEGIN');

    // Idempotency check with DB lock
    const existingOrder = await dbClient.query(
      'SELECT order_id, payload_hash, status FROM orders WHERE idempotency_key = $1 FOR UPDATE',
      [idempotencyKey]
    );

    if (existingOrder.rows.length > 0) {
      const existing = existingOrder.rows[0];
      if (existing.payload_hash !== payloadHash) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key payload mismatch' } });
      }
      await dbClient.query('COMMIT');
      return res.status(202).json({ order_id: existing.order_id, status: 'queued' });
    }

    // Verify catalog and stock with ROW LOCKING (FOR UPDATE)
    let totalCents = 0;
    const skus = Object.keys(aggregated).sort();
    
    for (const sku of skus) {
      const catRes = await dbClient.query('SELECT unit_price_cents, available FROM catalog WHERE sku = $1 FOR UPDATE', [sku]);
      if (catRes.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        return res.status(422).json({ error: { code: 'INVALID_SKU', message: `SKU ${sku} not found` } });
      }
      const itemPrice = catRes.rows[0].unit_price_cents;
      const available = catRes.rows[0].available;
      const qtyNeeded = aggregated[sku];

      if (available < qtyNeeded) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: { code: 'OUT_OF_STOCK', message: 'Insufficient stock' } });
      }
      totalCents += itemPrice * qtyNeeded;
    }

    // Deduct stock immediately
    for (const sku of skus) {
      await dbClient.query('UPDATE catalog SET available = available - $1 WHERE sku = $2', [aggregated[sku], sku]);
    }

    // Insert Order & Job
    const orderId = crypto.randomUUID();
    await dbClient.query(
      'INSERT INTO orders (order_id, customer_id, status, total_cents, idempotency_key, payload_hash) VALUES ($1, $2, $3, $4, $5, $6)',
      [orderId, customer_id, 'queued', totalCents, idempotencyKey, payloadHash]
    );

    for (const sku of skus) {
      await dbClient.query('INSERT INTO order_items (order_id, sku, quantity) VALUES ($1, $2, $3)', [orderId, sku, aggregated[sku]]);
    }

    await dbClient.query('INSERT INTO worker_jobs (order_id) VALUES ($1)', [orderId]);

    await dbClient.query('COMMIT');
    ordersCreatedCounter.inc();
    return res.status(202).json({ order_id: orderId, status: 'queued' });

  } catch (err) {
    await dbClient.query('ROLLBACK');
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Database error' } });
  } finally {
    dbClient.release();
  }
});

// 6. Get Order Status
app.get('/api/v1/orders/:order_id', async (req, res) => {
  const { rows } = await pool.query('SELECT order_id, status, total_cents FROM orders WHERE order_id = $1', [req.params.order_id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
  }
  res.status(200).json({ order_id: rows[0].order_id, status: rows[0].status, total_cents: rows[0].total_cents });
});

// 7. Prometheus Metrics Exposition
app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));