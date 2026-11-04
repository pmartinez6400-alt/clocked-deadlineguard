'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MockClockedClient } = require('../src/clocked/mock');
const { LiveClockedClient, ClockedError } = require('../src/clocked/live');
const { getConfig } = require('../src/config');

const demo = (name) => fs.readFileSync(path.join(__dirname, '..', 'demo', name), 'utf8');

test('config: auto adapter falls back to mock without a key, live with one', () => {
  const noKey = getConfig({ apiKey: '', adapter: 'auto' });
  assert.equal(noKey.adapter, 'mock');
  const withKey = getConfig({ apiKey: 'test-key', adapter: 'auto' });
  assert.equal(withKey.adapter, 'live');
  const forcedMock = getConfig({ apiKey: 'test-key', adapter: 'mock' });
  assert.equal(forcedMock.adapter, 'mock');
});

test('live client posts to the documented base URL with bearer auth and an idempotency key', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ fields: { monthly_amount: '$79.99' } }),
    };
  };
  const client = new LiveClockedClient({
    apiKey: 'secret-key',
    baseUrl: 'https://clocked.rezolve.ai/clocked',
    fetchImpl,
  });
  const body = { text: demo('sample-broadband-contract.txt'), fields: { monthly_amount: 'monthly' } };
  const result = await client.extract(body);
  assert.equal(seen.url, 'https://clocked.rezolve.ai/clocked/extract');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.Authorization, 'Bearer secret-key');
  assert.ok(seen.opts.headers['Idempotency-Key'], 'idempotency key header present');
  assert.deepEqual(JSON.parse(seen.opts.body), body);
  assert.equal(result.fields.monthly_amount, '$79.99');
});

test('live client maps API error statuses onto ClockedError', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 402,
    text: async () => JSON.stringify({ error: 'Insufficient credits' }),
  });
  const client = new LiveClockedClient({ apiKey: 'k', baseUrl: 'https://example.test/clocked', fetchImpl });
  await assert.rejects(
    () => client.decide({ state: 'x', questions: {} }),
    (err) => err instanceof ClockedError && err.status === 402 && /Insufficient credits/.test(err.message),
  );
});

test('live client covers all eight endpoints the pipeline uses', () => {
  const client = new LiveClockedClient({
    apiKey: 'k', baseUrl: 'https://example.test', fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
  });
  for (const m of ['decide', 'extract', 'fill', 'pii', 'injection', 'grounding', 'compare', 'rerank']) {
    assert.equal(typeof client[m], 'function', `missing ${m}`);
    assert.equal(typeof new MockClockedClient()[m], 'function', `mock missing ${m}`);
  }
});
