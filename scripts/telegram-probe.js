#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const { sendTelegramMessage } = require('../src/integrations/telegram');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const message = process.argv.slice(2).join(' ').trim() || 'Soleil Telegram probe OK.';
  const result = await sendTelegramMessage({
    text: message
  });

  console.log(JSON.stringify({ ok: true, message_id: result?.message_id || null }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
