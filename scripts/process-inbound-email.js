#!/usr/bin/env node

const { close } = require('../src/db/connection');
const { processInboundLeads } = require('../src/integrations/gmail');

async function main() {
  const result = await processInboundLeads();
  console.log(JSON.stringify({ processed: result.length, results: result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
