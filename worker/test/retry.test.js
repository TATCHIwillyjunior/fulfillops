'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { backoffMs, nextState } = require('../src/retry');

const noJitter = () => 0;

test('backoff doubles with each attempt', () => {
  assert.equal(backoffMs(1, { base: 1000, max: 30000, random: noJitter }), 1000);
  assert.equal(backoffMs(2, { base: 1000, max: 30000, random: noJitter }), 2000);
  assert.equal(backoffMs(3, { base: 1000, max: 30000, random: noJitter }), 4000);
});

test('backoff is capped at the maximum', () => {
  assert.equal(backoffMs(10, { base: 1000, max: 30000, random: noJitter }), 30000);
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
