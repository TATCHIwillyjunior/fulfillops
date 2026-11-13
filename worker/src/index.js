'use strict';
const config = require('./config');
const { pool, claimJob, completeJob } = require('./db');
const { failJob } = require('./retry');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let running = true;

// The actual fulfilment step. A poison order always fails.
async function fulfil(job) {
  if (job.customer_id === config.poisonCustomer) {
    throw new Error('Poison message encountered during fulfillment execution');
  }
  await sleep(config.workDurationMs);
}

async function processOne() {
  const job = await claimJob();
  if (!job) return false;

  try {
    await fulfil(job);
    await completeJob(job);
    console.log(`job ${job.job_id} order ${job.order_id} completed (attempt ${job.attempts})`);
  } catch (err) {
    const { state, delay } = await failJob(pool, job, err);
    if (state === 'dead_letter') {
      console.error(`job ${job.job_id} dead-lettered after ${job.attempts} attempts: ${err.message}`);
    } else {
      console.warn(`job ${job.job_id} failed (attempt ${job.attempts}/${job.max_attempts}), retry in ${delay} ms`);
    }
  }
  return true;
}

async function main() {
  console.log('worker started');
  while (running) {
    try {
      const didWork = await processOne();
      if (!didWork) await sleep(config.pollIntervalMs);
    } catch (err) {
      console.error('worker loop error:', err.message);
      await sleep(config.pollIntervalMs);
    }
  }
  await pool.end();
}

main();
