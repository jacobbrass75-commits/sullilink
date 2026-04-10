#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const { runTelegramBot } = require('../src/ops/telegram-bot');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  console.log('Starting Telegram bot in assistant mode...');

  await runTelegramBot({
    onCycle(result) {
      if (result.updates_received > 0) {
        console.log(
          `[telegram] processed ${result.updates_received} update(s), next offset ${result.next_update_id}`
        );
      }
    },
    onError(error) {
      console.error(`[telegram] worker error: ${error.message}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
