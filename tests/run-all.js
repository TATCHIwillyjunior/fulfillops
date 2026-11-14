'use strict';

/**
 * FulfillOps Master Test Runner
 * Executes the entire validation pipeline in a single command:
 *   1. Node.js test suite (unit tests, 2-API concurrency, worker recovery) -> 9 tests
 *   2. Database inventory reset
 *   3. Python black-box public contract checker (--concurrency --stress) -> 15 checks
 */

const { spawnSync } = require('node:child_process');

console.log('\n============================================================');
console.log(' STEP 1: Running Automated Suite (tests/all.test.js)');
console.log('============================================================\n');

const nodeTest = spawnSync(process.execPath, ['--test', 'tests/all.test.js'], {
  stdio: 'inherit',
  env: process.env
});

if (nodeTest.status !== 0) {
  console.error('\n❌ Node.js test suite failed.');
  process.exit(nodeTest.status || 1);
}

console.log('\n============================================================');
console.log(' STEP 2: Resetting Test Database Inventory');
console.log('============================================================\n');

const resetSql = 'TRUNCATE order_items, worker_jobs, orders CASCADE; UPDATE catalog SET available = 7 WHERE sku = \'KIT-100\'; UPDATE catalog SET available = 12 WHERE sku = \'PART-200\'; UPDATE catalog SET available = 5 WHERE sku = \'PACK-300\';';

const reset = spawnSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'fulfillops', '-d', 'fulfillops_db', '-c', resetSql], {
  stdio: 'inherit'
});

if (reset.status !== 0) {
  console.warn('⚠️ Warning: database reset exited with non-zero status. Proceeding to checker...');
}

console.log('\n============================================================');
console.log(' STEP 3: Running Official Public Contract Checker');
console.log('============================================================\n');

const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
const checker = spawnSync(pythonBin, [
  'tests/fulfillops_public_checker.py',
  '--base-url', 'http://localhost:8080',
  '--concurrency',
  '--stress'
], {
  stdio: 'inherit'
});

if (checker.status !== 0) {
  console.error('\n❌ Public contract checker failed.');
  process.exit(checker.status || 1);
}

console.log('\n============================================================');
console.log(' 🎉 ALL 24 TESTS PASSED SUCCESSFULLY! (9 Node.js + 15 Public)');
console.log('============================================================\n');
