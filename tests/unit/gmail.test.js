const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sendEmail,
  searchInbox,
  processInboundLeads,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/gmail');

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

function encodeBase64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

test('sendEmail stays in draft mode unless GMAIL_AUTO_SEND=true', async () => {
  const snapshot = {
    GMAIL_AUTO_SEND: process.env.GMAIL_AUTO_SEND
  };
  const draftCalls = [];
  const sendCalls = [];

  __setDependencies({
    getGmailClient: async () => ({
      users: {
        drafts: {
          create: async (params) => {
            draftCalls.push(params);
            return {
              data: {
                id: 'draft-1',
                message: {
                  id: 'msg-draft-1'
                }
              }
            };
          }
        },
        messages: {
          send: async (params) => {
            sendCalls.push(params);
            return {
              data: {
                id: 'msg-sent-1'
              }
            };
          }
        }
      }
    })
  });

  delete process.env.GMAIL_AUTO_SEND;
  const draftResult = await sendEmail('buyer@example.com', 'Hello', '<p>Test</p>');

  process.env.GMAIL_AUTO_SEND = 'true';
  const sentResult = await sendEmail('buyer@example.com', 'Hello', '<p>Test</p>');

  assert.equal(draftResult.delivery, 'draft');
  assert.equal(draftResult.draft_id, 'draft-1');
  assert.equal(draftCalls.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(sentResult.delivery, 'sent');
  assert.equal(sentResult.message_id, 'msg-sent-1');
  restoreEnv(snapshot);
});

test('searchInbox parses Gmail message payloads into simple message objects', async () => {
  const listCalls = [];

  __setDependencies({
    getGmailClient: async () => ({
      users: {
        messages: {
          list: async (params) => {
            listCalls.push(params);
            return {
              data: {
                messages: [{ id: 'msg-1' }]
              }
            };
          },
          get: async () => ({
            data: {
              id: 'msg-1',
              threadId: 'thread-1',
              internalDate: String(Date.parse('2026-04-10T10:00:00.000Z')),
              labelIds: ['UNREAD', 'INBOX'],
              snippet: 'Interested in buying a warehouse',
              payload: {
                headers: [
                  { name: 'From', value: 'buyer@example.com' },
                  { name: 'To', value: 'broker@example.com' },
                  { name: 'Subject', value: 'Warehouse search' }
                ],
                parts: [
                  {
                    mimeType: 'text/plain',
                    body: {
                      data: encodeBase64Url('Looking for 25,000 SF in Carson.')
                    }
                  }
                ]
              }
            }
          })
        }
      }
    })
  });

  const results = await searchInbox('from:buyer@example.com', 5);

  assert.equal(listCalls[0].q.includes('from:buyer@example.com'), true);
  assert.equal(listCalls[0].q.includes('newer_than:5d'), true);
  assert.equal(results.length, 1);
  assert.equal(results[0].from, 'buyer@example.com');
  assert.equal(results[0].subject, 'Warehouse search');
  assert.equal(results[0].body, 'Looking for 25,000 SF in Carson.');
  assert.equal(results[0].thread_id, 'thread-1');
});

test('processInboundLeads posts unread buyer emails to /api/ingest and marks them read', async () => {
  const snapshot = {
    INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL
  };
  const fetchCalls = [];
  const modifyCalls = [];
  const gmailClient = {
    users: {
      messages: {
        list: async () => ({
          data: {
            messages: [{ id: 'msg-22' }]
          }
        }),
        get: async () => ({
          data: {
            id: 'msg-22',
            threadId: 'thread-22',
            internalDate: String(Date.parse('2026-04-10T13:00:00.000Z')),
            snippet: 'Interested in buying industrial',
            payload: {
              headers: [
                { name: 'From', value: 'lead@example.com' },
                { name: 'Subject', value: 'Need industrial property' }
              ],
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: encodeBase64Url('I am looking for industrial property in Carson.')
                  }
                }
              ]
            }
          }
        }),
        modify: async (params) => {
          modifyCalls.push(params);
          return { data: { id: 'msg-22' } };
        }
      }
    }
  };

  process.env.INTERNAL_API_BASE_URL = 'http://127.0.0.1:3999';
  __setDependencies({
    getGmailClient: async () => gmailClient,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          summary: 'Inbound buyer lead',
          knowledge_entry_id: 'ke-22'
        })
      };
    }
  });

  const results = await processInboundLeads();
  const postedBody = JSON.parse(fetchCalls[0].options.body);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:3999/api/ingest');
  assert.equal(postedBody.source, 'email');
  assert.match(postedBody.message, /Need industrial property/);
  assert.match(postedBody.message, /looking for industrial property in Carson/i);
  assert.equal(modifyCalls.length, 1);
  assert.deepEqual(modifyCalls[0].requestBody.removeLabelIds, ['UNREAD']);
  assert.equal(results[0].knowledge_entry_id, 'ke-22');
  restoreEnv(snapshot);
});
