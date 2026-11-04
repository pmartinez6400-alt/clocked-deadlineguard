'use strict';

const { getConfig } = require('../config');
const { LiveClockedClient } = require('./live');
const { MockClockedClient } = require('./mock');

// Adapter factory. `auto` picks live when CLOCKED_API_KEY is set and mock
// otherwise, so the app (and the demo, and the tests) run with no key and
// no credits spent; setting the key switches every pipeline call to the
// real Clocked API without any code change.
function createClockedClient(config = getConfig()) {
  if (config.adapter === 'live') {
    return new LiveClockedClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  }
  return new MockClockedClient();
}

module.exports = { createClockedClient };
