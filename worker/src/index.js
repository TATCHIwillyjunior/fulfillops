'use strict';
const config = require('./config');
const { pool, claimJob, completeJob } = require('./db');

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
  await fulfil(job);
  await completeJob(job);
  console.log(`job ${job.job_id} order ${job.order_id} completed`);
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
