#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const {
  setTelegramWebhook,
  deleteTelegramWebhook,
  getTelegramWebhookInfo
} = require('../src/integrations/telegram');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const clear = args.has('--clear');
  const dropPending = args.has('--drop-pending');

  if (clear) {
    await deleteTelegramWebhook({
      dropPendingUpdates: dropPending
    });

    console.log(JSON.stringify({ ok: true, action: 'cleared' }, null, 2));
    return;
  }

  const webhookUrl = cleanText(process.env.TELEGRAM_WEBHOOK_URL, null);

  if (!webhookUrl) {
    throw new Error('TELEGRAM_WEBHOOK_URL is required to register the webhook');
  }

  await setTelegramWebhook({
    url: webhookUrl,
    secretToken: cleanText(process.env.TELEGRAM_WEBHOOK_SECRET, null),
    dropPendingUpdates: dropPending
  });

  const info = await getTelegramWebhookInfo();
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: 'registered',
        webhook_url: webhookUrl,
        info
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
