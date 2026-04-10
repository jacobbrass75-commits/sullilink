const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleAssistantMessage,
  __setDependencies,
  __resetDependencies
} = require('../../src/assistant/chat');

test.afterEach(() => {
  __resetDependencies();
});

test('assistant can resolve a natural-language lookup request', async () => {
  __setDependencies({
    complete: async () =>
      JSON.stringify({
        tool_name: 'lookup_brain',
        tool_args: {
          identifier: 'Mike Chen'
        },
        requires_confirmation: false
      }),
    lookupEntityOrProperty: async () => ({
      kind: 'entity',
      entity: {
        id: 'entity-1',
        name: 'Mike Chen',
        type: 'person'
      },
      properties: [
        {
          address: '123 Main St'
        }
      ],
      knowledge_entries: [
        {
          ai_summary: 'Looking for industrial in Carson.'
        }
      ]
    })
  });

  const result = await handleAssistantMessage({
    message: 'What do we know about Mike Chen?',
    channel: 'telegram',
    channel_chat_id: 'chat-1'
  });

  assert.equal(result.tool_name, 'lookup_brain');
  assert.match(result.reply, /Mike Chen/);
  assert.match(result.reply, /123 Main St/);
});

test('assistant falls back to storing notes when no planner is available', async () => {
  let classifiedCalls = 0;
  let routedCalls = 0;

  __setDependencies({
    complete: async () => {
      throw new Error('planner unavailable');
    },
    classifyMessage: async (message) => {
      classifiedCalls += 1;
      return {
        classifications: ['buyer_intel'],
        entities: [{ name: 'Mike Chen', type: 'person' }],
        relationships: [],
        buyer_profile: null,
        seller_profile: null,
        property_ref: null,
        action_items: [],
        summary: `Stored: ${message}`
      };
    },
    routeClassifiedMessage: async () => {
      routedCalls += 1;
      return {
        summary: 'Stored buyer note',
        created: ['Created entity: Mike Chen (person)'],
        updated: [],
        action_items: [],
        knowledge_entry_id: 'ke-1'
      };
    }
  });

  const result = await handleAssistantMessage({
    message: 'Mike Chen wants Carson industrial and can move fast.',
    channel: 'telegram',
    channel_chat_id: 'chat-2'
  });

  assert.equal(result.tool_name, 'store_note');
  assert.equal(classifiedCalls, 1);
  assert.equal(routedCalls, 1);
  assert.match(result.reply, /Stored buyer note/);
});

test('assistant holds email sends for confirmation and executes on yes', async () => {
  const sent = [];

  __setDependencies({
    complete: async (prompt) => {
      if (prompt.includes('User message:\nYes')) {
        return JSON.stringify({
          tool_name: 'answer_only',
          tool_args: {},
          requires_confirmation: false
        });
      }

      return JSON.stringify({
        tool_name: 'send_email',
        tool_args: {
          to: 'buyer@example.com',
          subject: 'Carson options',
          body: '<p>I have a few options for you.</p>'
        },
        requires_confirmation: true
      });
    },
    sendEmail: async (to, subject, body) => {
      sent.push({ to, subject, body });
      return {
        delivery: 'sent',
        message_id: 'msg-1'
      };
    }
  });

  const first = await handleAssistantMessage({
    message: 'Send an email to buyer@example.com about Carson options.',
    channel: 'telegram',
    channel_chat_id: 'chat-3'
  });

  assert.equal(first.tool_name, 'send_email');
  assert.equal(first.requires_confirmation, true);
  assert.equal(sent.length, 0);
  assert.match(first.reply, /Reply yes to send/i);

  const second = await handleAssistantMessage({
    message: 'Yes',
    channel: 'telegram',
    channel_chat_id: 'chat-3'
  });

  assert.equal(sent.length, 1);
  assert.equal(second.confirmed, true);
  assert.match(second.reply, /Sent the email/);
});
