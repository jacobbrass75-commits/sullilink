#!/usr/bin/env node

const { close } = require('../src/db/connection');
const { syncBrainTasksToCalendar } = require('../src/integrations/calendar');

async function main() {
  const result = await syncBrainTasksToCalendar();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
