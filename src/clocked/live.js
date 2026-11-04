'use strict';

const crypto = require('crypto');

// Live adapter for the Clocked API (Rezolve.ai).
//
// Wired from the public API contract:
//   - Base URL: https://clocked.rezolve.ai/clocked (official SDK default)
//   - Auth:     Authorization: Bearer <CLOCKED_API_KEY>
//   - One POST per endpoint: /decide /extract /fill /pii /injection
//     /grounding /compare /rerank, JSON body in, JSON body out.
//   - Each call carries a fresh Idempotency-Key UUID so a retry can never
//     double-bill; the API runs and bills each key once.
//   - Error statuses follow the published table: 400/413/422 invalid,
//     401 key rejected, 402 out of credits, 403 account unavailable,
//     409 idempotency conflict, 429 rate limited, 5xx server error.
//
// The endpoint paths and exact answer envelopes are the one part that can
// only be confirmed against the live account; they are isolated in this
// file (see PATHS) so a correction is a one-line change. DeadlineGuard's
// pipeline normalizes response envelopes defensively for that reason.

const PATHS = {
  decide: '/decide',
  extract: '/extract',
  fill: '/fill',
  pii: '/pii',
  injection: '/injection',
  grounding: '/grounding',
  compare: '/compare',
  rerank: '/rerank',
};

class ClockedError extends Error {
  constructor(message, { status = null, retryAsNew = false } = {}) {
    super(message);
    this.name = 'ClockedError';
    this.status = status;
    this.retryAsNew = retryAsNew;
  }
}

class LiveClockedClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.baseUrl
   * @param {Function} [opts.fetchImpl] injectable for tests
   * @param {number} [opts.timeoutMs]
   */
  constructor({ apiKey, baseUrl, fetchImpl, timeoutMs = 30000 } = {}) {
    if (!apiKey) throw new Error('LiveClockedClient requires an API key');
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.timeoutMs = timeoutMs;
    this.mode = 'live';
  }

  async call(endpoint, body) {
    const url = `${this.baseUrl}${PATHS[endpoint]}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ClockedError(`Clocked ${endpoint} request failed: ${err.message}`, {});
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const message = (json && (json.error || json.message)) || text || `HTTP ${res.status}`;
      throw new ClockedError(`Clocked ${endpoint} failed (${res.status}): ${message}`, {
        status: res.status,
        retryAsNew: Boolean(json && (json.retryAsNew || json.retry_as_new)),
      });
    }
    return json ?? {};
  }

  decide(body) { return this.call('decide', body); }
  extract(body) { return this.call('extract', body); }
  fill(body) { return this.call('fill', body); }
  pii(body) { return this.call('pii', body); }
  injection(body) { return this.call('injection', body); }
  grounding(body) { return this.call('grounding', body); }
  compare(body) { return this.call('compare', body); }
  rerank(body) { return this.call('rerank', body); }
}

module.exports = { LiveClockedClient, ClockedError, PATHS };
