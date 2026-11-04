'use strict';

// DeadlineGuard web server — dependency-free Node http.
// The browser never sees the Clocked API key: all Clocked calls happen
// here, server-side, through the adapter chosen by config.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { getConfig } = require('./config');
const { createClockedClient } = require('./clocked');
const { DeadlineGuard } = require('./pipeline');
const { ObligationStore } = require('./store');
const { toICS } = require('./ics');

const DEMO_DIR = path.join(__dirname, '..', 'demo');
const SAMPLES = {
  broadband: { file: 'sample-broadband-contract.txt', label: 'Broadband contract (auto-renew trap)' },
  'insurance-old': { file: 'sample-insurance-old.txt', label: 'Insurance policy — current terms' },
  'insurance-new': { file: 'sample-insurance-renewal.txt', label: 'Insurance renewal — new terms (conflicts)' },
};

function readSample(key) {
  const s = SAMPLES[key];
  if (!s) return null;
  return fs.readFileSync(path.join(DEMO_DIR, s.file), 'utf8');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function createServer({ config = getConfig(), guard = null } = {}) {
  const g = guard || new DeadlineGuard(createClockedClient(config), { store: new ObligationStore() });
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(indexHtml);
      }
      if (route === 'GET /api/health') {
        return json(res, 200, { ok: true, adapter: g.client.mode, today: g.today });
      }
      if (route === 'GET /api/samples') {
        return json(res, 200, Object.entries(SAMPLES).map(([key, s]) => ({ key, label: s.label })));
      }
      if (route.startsWith('GET /api/samples/')) {
        const key = decodeURIComponent(url.pathname.split('/').pop());
        const text = readSample(key);
        if (text === null) return json(res, 404, { error: 'unknown sample' });
        return json(res, 200, { key, text });
      }
      if (route === 'POST /api/analyze') {
        const body = await readBody(req);
        const result = await g.analyzeDocument(body.text || '', { title: body.title || 'Document' });
        return json(res, 200, result);
      }
      if (route === 'POST /api/compare') {
        const body = await readBody(req);
        const result = await g.compareDocuments(body.textA || '', body.textB || '', {
          titleA: body.titleA || 'Older document',
          titleB: body.titleB || 'Newer document',
        });
        return json(res, 200, result);
      }
      if (route === 'GET /api/obligations') {
        return json(res, 200, { obligations: g.store.list() });
      }
      const decideMatch = url.pathname.match(/^\/api\/obligations\/([\w-]+)\/(approve|dismiss)$/);
      if (req.method === 'POST' && decideMatch) {
        const [, id, verb] = decideMatch;
        const body = verb === 'approve' ? await readBody(req) : {};
        const item = verb === 'approve' ? g.store.approve(id, body) : g.store.dismiss(id);
        if (!item) return json(res, 404, { error: 'unknown obligation' });
        return json(res, 200, { obligation: item });
      }
      if (route === 'GET /api/export.json') {
        return json(res, 200, { exportedAt: new Date().toISOString(), obligations: g.store.approved() });
      }
      if (route === 'GET /api/export.ics') {
        const ics = toICS(g.store.approved());
        res.writeHead(200, {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="deadlineguard.ics"',
        });
        return res.end(ics);
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });
}

if (require.main === module) {
  const config = getConfig();
  const server = createServer({ config });
  server.listen(config.port, () => {
    console.log(`DeadlineGuard listening on http://localhost:${config.port}`);
    console.log(`Clocked adapter: ${config.adapter}${config.adapter === 'mock' ? ' (no API key — set CLOCKED_API_KEY for live)' : ''}`);
  });
}

module.exports = { createServer, SAMPLES };
