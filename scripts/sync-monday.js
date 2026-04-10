#!/usr/bin/env node

const { close, query } = require('../src/db/connection');
const {
  pushMatchToMonday,
  pullDealUpdates,
  pushDailyActions
} = require('../src/integrations/monday-sync');

async function syncNegotiationMatches() {
  const result = await query(
    `
      SELECT m.id
      FROM matches m
      WHERE m.status = 'in_negotiation'
        AND NOT EXISTS (
          SELECT 1
          FROM monday_links links
          WHERE links.entity_id = m.id
        )
      ORDER BY m.updated_at DESC
    `
  );

  const synced = [];

  for (const row of result.rows) {
    synced.push(await pushMatchToMonday(row.id));
  }

  return synced;
}

async function main() {
  const created = await syncNegotiationMatches();
  const dealUpdates = await pullDealUpdates();
  const dailyActions = await pushDailyActions();

  console.log(
    JSON.stringify(
      {
        created_matches: created,
        deal_updates: dealUpdates,
        daily_actions: dailyActions
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
