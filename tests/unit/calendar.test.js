const test = require('node:test');
const assert = require('node:assert/strict');
const {
  syncBrainTasksToCalendar,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/calendar');

test.afterEach(() => {
  __resetDependencies();
});

test('syncBrainTasksToCalendar creates calendar events once and stays idempotent', async () => {
  const inserted = [];
  const updated = [];
  const listCalls = [];
  const dueAt = '2026-04-11T09:00:00.000-07:00';
  const queryResult = {
    rows: [
      {
        id: 'ke-1',
        title: 'Call back buyer',
        ai_summary: 'Follow up with active buyer',
        ai_action_items: [
          {
            title: 'Call buyer back',
            due_date: dueAt
          }
        ],
        entity_id: '11111111-1111-1111-1111-111111111111',
        created_at: '2026-04-10T08:00:00.000Z'
      }
    ]
  };
  const existingEvent = {
    id: 'evt-1',
    summary: 'Call buyer back',
    description: 'Follow up with active buyer',
    start: {
      dateTime: new Date(dueAt).toISOString()
    },
    end: {
      dateTime: new Date(new Date(dueAt).getTime() + 30 * 60 * 1000).toISOString()
    }
  };
  const calendarClient = {
    events: {
      list: async (params) => {
        listCalls.push(params);
        return listCalls.length === 1 ? { data: { items: [] } } : { data: { items: [existingEvent] } };
      },
      insert: async (params) => {
        inserted.push(params);
        return {
          data: {
            id: 'evt-1'
          }
        };
      },
      update: async (params) => {
        updated.push(params);
        return {
          data: {
            id: 'evt-1'
          }
        };
      }
    }
  };

  __setDependencies({
    query: async () => queryResult,
    getCalendarClient: async () => calendarClient
  });

  const firstRun = await syncBrainTasksToCalendar();
  const secondRun = await syncBrainTasksToCalendar();

  assert.equal(inserted.length, 1);
  assert.equal(updated.length, 0);
  assert.equal(firstRun.created, 1);
  assert.equal(secondRun.created, 0);
  assert.equal(secondRun.skipped >= 1, true);
  assert.equal(
    inserted[0].requestBody.extendedProperties.private.brain_knowledge_entry_id,
    'ke-1'
  );
});
