'use strict';
const http = require('node:http');
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'fulfillops_worker_' });

const jobsProcessed = new client.Counter({
  name: 'fulfillops_worker_jobs_processed_total',
  help: 'Jobs finished by the worker, by result',
  labelNames: ['result'], // completed | retried | dead_letter
  registers: [register]
});
const retries = new client.Counter({
  name: 'fulfillops_worker_retries_total',
  help: 'Total worker processing retries',
  registers: [register]
});
const jobDuration = new client.Histogram({
  name: 'fulfillops_worker_job_duration_seconds',
  help: 'Time to process one job',
  buckets: [0.1, 0.5, 1, 2, 3, 5, 10],
  registers: [register]
});
const queueDepth = new client.Gauge({
  name: 'fulfillops_worker_queue_depth',
  help: 'Jobs per status in worker_jobs',
  labelNames: ['status'],
  registers: [register]
});

// Small HTTP server so Prometheus (and Kubernetes probes) can reach the worker.
function startServer(port, { pool, isReady }) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        const { rows } = await pool.query('SELECT status, COUNT(*)::int AS n FROM worker_jobs GROUP BY status');
        queueDepth.reset();
        for (const r of rows) queueDepth.set({ status: r.status }, r.n);
      } catch { /* DB down: still expose the other metrics */ }
      res.writeHead(200, { 'Content-Type': register.contentType });
      return res.end(await register.metrics());
    }
    if (req.url === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (req.url === '/health/ready') {
      const ok = isReady();
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: ok ? 'ready' : 'not_ready' }));
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, () => console.log(`worker metrics on :${port}/metrics`));
  return server;
}

module.exports = { register, jobsProcessed, retries, jobDuration, queueDepth, startServer };
