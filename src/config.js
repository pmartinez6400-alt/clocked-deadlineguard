'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env reader (no dependencies). Real environment variables win.
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env file — fine, env vars only */
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const DEFAULT_BASE_URL = 'https://clocked.rezolve.ai/clocked';

function getConfig(overrides = {}) {
  const apiKey = overrides.apiKey ?? process.env.CLOCKED_API_KEY ?? '';
  const requested = (overrides.adapter ?? process.env.CLOCKED_ADAPTER ?? 'auto').toLowerCase();
  let adapter = requested;
  if (adapter === 'auto') adapter = apiKey ? 'live' : 'mock';
  if (adapter === 'live' && !apiKey) adapter = 'mock';
  return {
    apiKey,
    baseUrl: (overrides.baseUrl ?? process.env.CLOCKED_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    adapter,
    requestedAdapter: requested,
    port: Number(overrides.port ?? process.env.PORT ?? 4317),
  };
}

module.exports = { getConfig, DEFAULT_BASE_URL };
