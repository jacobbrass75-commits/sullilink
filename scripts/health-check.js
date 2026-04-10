#!/usr/bin/env node

function getHealthUrl() {
  const baseUrl = String(
    process.env.INTERNAL_API_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 3100}`
  ).replace(/\/$/, '');

  return `${baseUrl}/health`;
}

async function runHealthCheck(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const url = options.url || getHealthUrl();

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available for health checks');
  }

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.status !== 'ok') {
    throw new Error(
      payload?.error ||
        `Health check failed for ${url} with status ${response.status}`
    );
  }

  return payload;
}

async function main() {
  const payload = await runHealthCheck();
  console.log(JSON.stringify(payload, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  getHealthUrl,
  runHealthCheck
};
