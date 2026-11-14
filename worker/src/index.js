'use strict';
const config = require('./config');
const { pool, claimJob, completeJob } = require('./db');
const { failJob } = require('./retry');
const metrics = require('./metrics');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let running = true;
let dbReady = false;

// The actual fulfilment step. A poison order always fails.
async function fulfil(job) {
  if (job.customer_id === config.poisonCustomer) {
    throw new Error('Poison message encountered during fulfillment execution');
  }
  await sleep(config.workDurationMs);
}

async function processOne() {
  const job = await claimJob();
  dbReady = true;
  if (!job) return false;

  const endTimer = metrics.jobDuration.startTimer();
  try {
    await fulfil(job);
    const completed = await completeJob(job);
    if (completed) {
      metrics.jobsProcessed.inc({ result: 'completed' });
      console.log(`job ${job.job_id} order ${job.order_id} completed (attempt ${job.attempts})`);
    } else {
      console.warn(`stale worker result ignored for job ${job.job_id} (attempt ${job.attempts})`);
    }
  } catch (err) {
    const { state, delay } = await failJob(pool, job, err);
    if (state === 'stale') {
      console.warn(`stale worker failure ignored for job ${job.job_id} (attempt ${job.attempts})`);
    } else if (state === 'dead_letter') {
      metrics.jobsProcessed.inc({ result: 'dead_letter' });
      console.error(`job ${job.job_id} dead-lettered after ${job.attempts} attempts: ${err.message}`);
    } else {
      metrics.retries.inc();
      metrics.jobsProcessed.inc({ result: 'retried' });
      console.warn(`job ${job.job_id} failed (attempt ${job.attempts}/${job.max_attempts}), retry in ${delay} ms`);
    }
  } finally {
    endTimer();
  }
  return true;
}

async function main() {
  const server = metrics.startServer(config.metricsPort, { pool, isReady: () => dbReady && running });
  console.log('worker started');
  while (running) {
    try {
      const didWork = await processOne();
      if (!didWork) await sleep(config.pollIntervalMs);
    } catch (err) {
      dbReady = false;
      console.error('worker loop error:', err.message);
      await sleep(config.pollIntervalMs);
    }
  }
  // Graceful shutdown: the current job finished above; anything we did not
  // finish is still 'processing' and will be reclaimed after the lock timeout.
  server.close();
  await pool.end();
  console.log('worker stopped');
}

function stop(signal) {
  console.log(`${signal} received, finishing current job then stopping`);
  running = false;
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

main();
