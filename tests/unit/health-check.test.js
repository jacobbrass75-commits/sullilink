const test = require('node:test');
const assert = require('node:assert/strict');
const { runHealthCheck } = require('../../scripts/health-check');

test('runHealthCheck returns payload for healthy responses', async () => {
  const payload = await runHealthCheck({
    url: 'http://127.0.0.1:3100/health',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'ok',
          database: 'connected'
        };
      }
    })
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.database, 'connected');
});

test('runHealthCheck throws when the endpoint reports unhealthy status', async () => {
  await assert.rejects(
    () =>
      runHealthCheck({
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          async json() {
            return {
              status: 'error'
            };
          }
        })
      }),
    /Health check failed/
  );
});
