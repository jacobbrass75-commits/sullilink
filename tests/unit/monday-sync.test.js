const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pushMatchToMonday,
  pullDealUpdates,
  pushDailyActions,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/monday-sync');

function createFetchStub(responses) {
  const calls = [];

  async function fetch(_url, options = {}) {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);

    const next = responses.shift();

    if (next instanceof Error) {
      throw next;
    }

    return {
      ok: true,
      async json() {
        return next;
      }
    };
  }

  fetch.calls = calls;
  return fetch;
}

test.afterEach(() => {
  __resetDependencies();
});

test('pushMatchToMonday creates a group, seeds items, and links the match and deal', async () => {
  process.env.MONDAY_API_TOKEN = 'test-token';
  process.env.MONDAY_LISTINGS_TEMPLATE_GROUP_ID = 'template-group';
  const queries = [];
  const fetch = createFetchStub([
    {
      data: {
        create_group: {
          id: 'group-1',
          title: '123 Main St'
        }
      }
    },
    {
      data: {
        boards: [
          {
            groups: [
              {
                items_page: {
                  items: [
                    { id: 'template-1', name: 'Initial outreach' },
                    { id: 'template-2', name: 'Property package' }
                  ]
                }
              }
            ]
          }
        ]
      }
    },
    {
      data: {
        create_item: {
          id: 'item-1',
          name: 'Initial outreach'
        }
      }
    },
    {
      data: {
        create_item: {
          id: 'item-2',
          name: 'Property package'
        }
      }
    }
  ]);

  __setDependencies({
    fetch,
    query: async (sql, params = []) => {
      queries.push({ sql, params });

      if (sql.includes('FROM matches m')) {
        return {
          rows: [
            {
              id: '11111111-1111-1111-1111-111111111111',
              status: 'in_negotiation',
              property_id: '22222222-2222-2222-2222-222222222222',
              address: '123 Main St',
              apn: '111-AAA-001',
              deal_id: '33333333-3333-3333-3333-333333333333'
            }
          ]
        };
      }

      if (sql.includes('INSERT INTO monday_links')) {
        return { rows: [] };
      }

      if (sql.includes('SELECT entity_id, monday_board_id, monday_item_id, created_at')) {
        return {
          rows: [
            {
              entity_id: params[0],
              monday_board_id: params[1],
              monday_item_id: params[2],
              created_at: '2026-04-10T00:00:00.000Z'
            }
          ]
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  });

  const result = await pushMatchToMonday('11111111-1111-1111-1111-111111111111');

  assert.equal(result.group_id, 'group-1');
  assert.deepEqual(
    result.created_items.map((item) => item.id),
    ['item-1', 'item-2']
  );
  assert.equal(fetch.calls.length, 4);
  assert.equal(
    queries.filter(({ sql }) => sql.includes('INSERT INTO monday_links')).length,
    4
  );
});

test('pullDealUpdates closes linked deals when Monday items move to Done', async () => {
  process.env.MONDAY_API_TOKEN = 'test-token';
  const fetch = createFetchStub([
    {
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: 'item-1',
                  updated_at: '2026-04-10T11:00:00.000Z',
                  column_values: [
                    { id: 'status', title: 'Status', text: 'Done' },
                    { id: 'close_date', title: 'Close Date', text: '2026-04-15' }
                  ]
                }
              ]
            }
          }
        ]
      }
    },
    { data: { boards: [{ items_page: { items: [] } }] } },
    { data: { boards: [{ items_page: { items: [] } }] } }
  ]);
  const queries = [];

  __setDependencies({
    fetch,
    query: async (sql, params = []) => {
      queries.push({ sql, params });

      if (sql.includes('SELECT entity_id, monday_item_id')) {
        return {
          rows: [
            {
              entity_id: '33333333-3333-3333-3333-333333333333',
              monday_item_id: 'item-1'
            }
          ]
        };
      }

      if (sql.includes('UPDATE deals')) {
        return {
          rows: [{ id: '33333333-3333-3333-3333-333333333333' }]
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  });

  const result = await pullDealUpdates();

  assert.equal(result.updated, 1);
  assert.equal(result.updates[0].close_date, '2026-04-15');
  assert.equal(
    queries.some(({ sql }) => sql.includes('UPDATE deals')),
    true
  );
});

test('pushDailyActions posts overdue action updates to linked Monday items', async () => {
  process.env.MONDAY_API_TOKEN = 'test-token';
  const fetch = createFetchStub([
    {
      data: {
        create_update: {
          id: 'upd-1'
        }
      }
    }
  ]);
  const overdueActions = [
    {
      entity_id: '11111111-1111-1111-1111-111111111111',
      title: 'Call buyer back',
      due_at: '2026-04-09T09:00:00.000Z',
      notes: 'Discuss warehouse options',
      summary: 'Hot inbound lead'
    }
  ];

  __setDependencies({
    fetch,
    query: async (sql) => {
      if (sql.includes('SELECT monday_board_id, monday_item_id')) {
        return {
          rows: [
            {
              monday_board_id: '8147757682',
              monday_item_id: 'item-7'
            }
          ]
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  });

  const result = await pushDailyActions(overdueActions);

  assert.equal(result.posted, 1);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0].variables.body, /Call buyer back/);
  assert.match(fetch.calls[0].variables.body, /Hot inbound lead/);
});
