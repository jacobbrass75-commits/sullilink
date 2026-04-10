const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getDefaultTelegramChatId,
  sendTelegramMessage,
  getTelegramFile,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/telegram');

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

test('getDefaultTelegramChatId returns configured chat id', () => {
  const snapshot = {
    TELEGRAM_DEFAULT_CHAT_ID: process.env.TELEGRAM_DEFAULT_CHAT_ID
  };

  process.env.TELEGRAM_DEFAULT_CHAT_ID = '-1001234567890';
  assert.equal(getDefaultTelegramChatId(), '-1001234567890');

  restoreEnv(snapshot);
});

test('sendTelegramMessage posts the expected payload', async () => {
  const snapshot = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN
  };
  const calls = [];

  process.env.TELEGRAM_BOT_TOKEN = 'token-123';
  __setDependencies({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            message_id: 22
          }
        })
      };
    }
  });

  const result = await sendTelegramMessage({
    chatId: '123',
    text: 'Hello from Soleil'
  });

  assert.equal(result.message_id, 22);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  assert.equal(JSON.parse(calls[0].options.body).chat_id, '123');
  restoreEnv(snapshot);
});

test('getTelegramFile requests metadata for the given file id', async () => {
  const snapshot = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN
  };

  process.env.TELEGRAM_BOT_TOKEN = 'token-123';
  __setDependencies({
    fetch: async (_url, options) => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          file_id: 'file-1',
          file_path: 'voice/file.ogg',
          echoed: JSON.parse(options.body)
        }
      })
    })
  });

  const result = await getTelegramFile('file-1');

  assert.equal(result.file_path, 'voice/file.ogg');
  assert.equal(result.echoed.file_id, 'file-1');
  restoreEnv(snapshot);
});
