const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createServer } = require('node:http');
const {
  createTelegramWebhookRouter,
  __setDependencies,
  __resetDependencies
} = require('../../src/api/routes/telegram-webhook');

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

async function withServer(handler) {
  const app = express();
  app.use(express.json());
  app.use(createTelegramWebhookRouter());
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    return await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('telegram webhook accepts valid secret and processes the update asynchronously', async () => {
  const snapshot = {
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH
  };
  process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-1';
  process.env.TELEGRAM_WEBHOOK_PATH = '/api/integrations/telegram/webhook';
  let seen = null;
  let resolveSeen;
  const seenPromise = new Promise((resolve) => {
    resolveSeen = resolve;
  });

  __setDependencies({
    processUpdate: async (update) => {
      seen = update;
      resolveSeen();
    },
    logger: {
      error() {}
    }
  });

  const response = await withServer(async (baseUrl) =>
    fetch(`${baseUrl}/api/integrations/telegram/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret-1'
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          text: 'hello'
        }
      })
    })
  );

  assert.equal(response.status, 202);
  await seenPromise;
  assert.equal(seen.update_id, 1);
  restoreEnv(snapshot);
});

test('telegram webhook rejects invalid secret tokens', async () => {
  const snapshot = {
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH
  };
  process.env.TELEGRAM_WEBHOOK_SECRET = 'secret-1';
  process.env.TELEGRAM_WEBHOOK_PATH = '/api/integrations/telegram/webhook';
  let called = false;

  __setDependencies({
    processUpdate: async () => {
      called = true;
    },
    logger: {
      error() {}
    }
  });

  const response = await withServer(async (baseUrl) =>
    fetch(`${baseUrl}/api/integrations/telegram/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'wrong-secret'
      },
      body: JSON.stringify({
        update_id: 1
      })
    })
  );

  assert.equal(response.status, 401);
  assert.equal(called, false);
  restoreEnv(snapshot);
});
