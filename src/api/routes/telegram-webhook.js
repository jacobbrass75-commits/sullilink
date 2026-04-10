const express = require('express');
const { processUpdate } = require('../../ops/telegram-bot');

const defaultDependencies = {
  processUpdate,
  logger: console
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getWebhookPath() {
  return cleanText(process.env.TELEGRAM_WEBHOOK_PATH, '/api/integrations/telegram/webhook');
}

function getWebhookSecret() {
  return cleanText(process.env.TELEGRAM_WEBHOOK_SECRET, null);
}

function hasValidSecret(req) {
  const expected = getWebhookSecret();

  if (!expected) {
    return true;
  }

  return cleanText(req.get('x-telegram-bot-api-secret-token'), null) === expected;
}

function createTelegramWebhookRouter() {
  const router = express.Router();

  router.post(getWebhookPath(), (req, res) => {
    if (!hasValidSecret(req)) {
      return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
    }

    const update = req.body;
    res.status(202).json({ ok: true });

    Promise.resolve()
      .then(() => dependencies.processUpdate(update))
      .catch((error) => {
        dependencies.logger.error?.(`[telegram-webhook] ${error.message}`);
      });

    return undefined;
  });

  return router;
}

function __setDependencies(overrides = {}) {
  dependencies = {
    ...dependencies,
    ...overrides
  };
}

function __resetDependencies() {
  dependencies = { ...defaultDependencies };
}

module.exports = {
  createTelegramWebhookRouter,
  __setDependencies,
  __resetDependencies
};
