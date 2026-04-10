const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchStats,
  getLikedProperties,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/realestatetool');

test.afterEach(() => {
  __resetDependencies();
});

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('fetchStats uses the MCP SSE transport when REALESTATETOOL_URL points at /sse', async () => {
  const snapshot = {
    REALESTATETOOL_URL: process.env.REALESTATETOOL_URL,
    REALESTATETOOL_TRANSPORT: process.env.REALESTATETOOL_TRANSPORT
  };
  const connectCalls = [];
  const toolCalls = [];
  const createdTransports = [];

  process.env.REALESTATETOOL_URL = 'https://mcp.example.com/sse';
  delete process.env.REALESTATETOOL_TRANSPORT;

  __setDependencies({
    createMcpClient: () => ({
      connect: async (transport) => {
        connectCalls.push(transport);
      },
      callTool: async (params) => {
        toolCalls.push(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ total: 533, remaining: 400 })
            }
          ]
        };
      }
    }),
    createSseTransport: (url) => {
      const transport = {
        url,
        close: async () => {}
      };
      createdTransports.push(transport);
      return transport;
    }
  });

  const result = await fetchStats('la_county');

  assert.equal(createdTransports.length, 1);
  assert.equal(createdTransports[0].url, 'https://mcp.example.com/sse');
  assert.equal(connectCalls.length, 1);
  assert.deepEqual(toolCalls, [
    {
      name: 'get_property_stats',
      arguments: { region: 'la_county' }
    }
  ]);
  assert.deepEqual(result, { total: 533, remaining: 400 });
  restoreEnv(snapshot);
});

test('getLikedProperties falls back to direct JSON-RPC POST for non-SSE URLs', async () => {
  const snapshot = {
    REALESTATETOOL_URL: process.env.REALESTATETOOL_URL,
    REALESTATETOOL_TRANSPORT: process.env.REALESTATETOOL_TRANSPORT
  };
  const fetchCalls = [];

  process.env.REALESTATETOOL_URL = 'https://bridge.example.com/mcp';
  delete process.env.REALESTATETOOL_TRANSPORT;

  __setDependencies({
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            result: {
              liked_properties: [{ apn: '123-456-789' }]
            }
          })
      };
    }
  });

  const result = await getLikedProperties({ region: 'la_county' });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://bridge.example.com/mcp');
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.match(fetchCalls[0].options.body, /get_liked_properties/);
  assert.deepEqual(result, [{ apn: '123-456-789' }]);
  restoreEnv(snapshot);
});
