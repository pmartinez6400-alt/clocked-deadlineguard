'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createServer } = require('../src/server');
const { getConfig } = require('../src/config');

const demo = (name) => fs.readFileSync(path.join(__dirname, '..', 'demo', name), 'utf8');

test('server: health, analyze, approve, ICS export — full loop over HTTP', async (t) => {
  const server = createServer({ config: getConfig({ adapter: 'mock', apiKey: '' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.adapter, 'mock');

  const analysis = await (await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: demo('sample-broadband-contract.txt'), title: 'Broadband' }),
  })).json();
  assert.equal(analysis.fields.noticeDeadline, '2027-01-16');
  assert.ok(analysis.obligations.length >= 4);

  const target = analysis.obligations[0];
  const approved = await (await fetch(`${base}/api/obligations/${target.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  assert.equal(approved.obligation.status, 'approved');

  const icsRes = await fetch(`${base}/api/export.ics`);
  assert.match(icsRes.headers.get('content-type'), /text\/calendar/);
  const ics = await icsRes.text();
  assert.ok(ics.includes('BEGIN:VEVENT'));

  const missing = await fetch(`${base}/api/obligations/nope/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(missing.status, 404);
});
