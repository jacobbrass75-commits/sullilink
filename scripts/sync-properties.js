#!/usr/bin/env node

const { close } = require('../src/db/connection');
const {
  syncNewProperties,
  syncReviewDecisions,
  fetchTitleDocument,
  triggerMatchingForNewProperties
} = require('../src/integrations/realestatetool-sync');

function collectSyncedApns(propertySync) {
  const apns = [];
  const seen = new Set();
  const rows = [...(propertySync?.new_properties || []), ...(propertySync?.updated_properties || [])];

  for (const row of rows) {
    const apn = typeof row?.apn === 'string' ? row.apn.trim() : '';

    if (!apn || seen.has(apn)) {
      continue;
    }

    seen.add(apn);
    apns.push(apn);
  }

  return apns;
}

async function main() {
  const propertySync = await syncNewProperties();
  const reviewSync = await syncReviewDecisions();
  const titleDocumentResults = [];

  for (const apn of collectSyncedApns(propertySync)) {
    try {
      titleDocumentResults.push(await fetchTitleDocument(apn));
    } catch (error) {
      titleDocumentResults.push({
        apn,
        attached: false,
        error: error.message
      });
    }
  }

  const matching = await triggerMatchingForNewProperties();

  console.log(
    JSON.stringify(
      {
        property_sync: propertySync,
        review_sync: reviewSync,
        title_documents: {
          attempted: titleDocumentResults.length,
          attached: titleDocumentResults.filter((result) => result.attached).length,
          results: titleDocumentResults
        },
        matching
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
