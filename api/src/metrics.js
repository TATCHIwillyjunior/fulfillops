'use strict';
// Shared Prometheus metrics for the API. Import it in api/src/index.js:
//   const { register, metricsMiddleware, ordersCreated, ordersFailed } = require('./metrics');
//   app.use(metricsMiddleware);
//   app.get('/metrics', async (req, res) => { res.set('Content-Type', register.contentType); res.send(await register.metrics()); });
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const ordersCreated = new client.Counter({
  name: 'fulfillops_orders_created_total',
  help: 'Total orders created successfully',
  registers: [register]
});
const ordersFailed = new client.Counter({
  name: 'fulfillops_orders_failed_total',
  help: 'Total orders failed',
  registers: [register]
});
const httpRequests = new client.Counter({
  name: 'fulfillops_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});
const httpDuration = new client.Histogram({
  name: 'fulfillops_http_request_duration_seconds',
  help: 'HTTP request duration, used for the p95 latency SLO',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2.5],
  registers: [register]
});

// Use the route pattern (/api/v1/orders/:order_id), not the raw path,
// so every order id does not create a new time series.
function routeOf(req) {
  return (req.route && req.baseUrl + req.route.path) || 'unmatched';
}

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routeOf(req);
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequests.inc({ method: req.method, route, status: res.statusCode });
    httpDuration.observe({ method: req.method, route }, seconds);
  });
  next();
}

module.exports = { register, metricsMiddleware, ordersCreated, ordersFailed, httpRequests, httpDuration };
