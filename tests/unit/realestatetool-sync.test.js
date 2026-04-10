const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealEstateToolSync } = require('../../src/integrations/realestatetool-sync');

function buildAsyncBatchSource(batches) {
  return async function* listPropertyBatches() {
    for (const batch of batches) {
      yield batch;
    }
  };
}

test('syncNewProperties imports only properties newer than the last sync and tracks creates vs updates', async () => {
  const recordedStates = [];
  const upsertCalls = [];
  const entityCalls = [];
  const scoreCalls = [];
  const propertyRowsById = {
    'prop-new': {
      id: 'prop-new',
      apn: 'NEW-1',
      region: 'la_county',
      foreclosure: true,
      owner_entity_id: 'owner-1',
      assessed_value: 1200000,
      default_amount: 150000,
      loan_amount: 900000
    },
    'prop-existing': {
      id: 'prop-existing',
      apn: 'EXIST-2',
      region: 'la_county',
      foreclosure: true,
      owner_entity_id: 'owner-2',
      assessed_value: 2400000,
      default_amount: 300000,
      loan_amount: 1600000
    }
  };
  const sync = createRealEstateToolSync({
    api: {
      listPropertyBatches: buildAsyncBatchSource([
        [
          {
            apn: 'OLD-0',
            region: 'la_county',
            imported_at: '2026-04-08T08:00:00.000Z'
          },
          {
            apn: 'NEW-1',
            region: 'la_county',
            imported_at: '2026-04-10T08:00:00.000Z'
          },
          {
            apn: 'EXIST-2',
            region: 'la_county',
            imported_at: '2026-04-10T09:00:00.000Z'
          }
        ]
      ])
    },
    repository: {
      async getLatestSyncState(kind) {
        assert.equal(kind, 'properties');
        return { synced_at: '2026-04-09T12:00:00.000Z' };
      },
      async findPropertiesByKeys(keys) {
        assert.deepEqual(
          keys.map((key) => key.apn).sort(),
          ['EXIST-2', 'NEW-1']
        );
        return [{ id: 'prop-existing', apn: 'EXIST-2', region: 'la_county' }];
      },
      async getPropertiesByIds(ids) {
        return ids.map((id) => propertyRowsById[id]);
      },
      async countOwnerForeclosures() {
        return 0;
      },
      async recordSyncState(kind, state) {
        recordedStates.push({ kind, state });
        return state;
      }
    },
    normalizeProperty(rawProperty) {
      return {
        apn: rawProperty.apn,
        region: rawProperty.region,
        source: 'realestatetool',
        owner_name: `Owner ${rawProperty.apn}`
      };
    },
    async upsertProperties(properties) {
      upsertCalls.push(properties);
      return properties.map((property) => ({
        id: property.apn === 'NEW-1' ? 'prop-new' : 'prop-existing',
        apn: property.apn,
        region: property.region,
        owner_name: property.owner_name,
        trustee_name: null,
        beneficiary_name: null,
        source: property.source
      }));
    },
    async processPropertyEntities(rows) {
      entityCalls.push(rows);
      return {
        created: 2,
        existing: 0,
        linked: 2
      };
    },
    async scoreProperties(rows) {
      scoreCalls.push(rows);
      return {
        created: 1,
        updated: 1,
        skipped: 0
      };
    }
  });

  const summary = await sync.syncNewProperties();

  assert.equal(summary.scanned, 3);
  assert.equal(summary.synced, 2);
  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped_stale, 1);
  assert.equal(upsertCalls.length, 1);
  assert.deepEqual(
    upsertCalls[0].map((property) => property.apn).sort(),
    ['EXIST-2', 'NEW-1']
  );
  assert.equal(entityCalls.length, 1);
  assert.equal(scoreCalls.length, 1);
  assert.equal(recordedStates.length, 1);
  assert.equal(recordedStates[0].kind, 'properties');
  assert.deepEqual(recordedStates[0].state.new_property_ids, ['prop-new']);
  assert.deepEqual(recordedStates[0].state.updated_property_ids, ['prop-existing']);
});

test('syncReviewDecisions creates liked seller profiles and toggles active flags for existing decisions', async () => {
  const createdProfiles = [];
  const updatedProfiles = [];
  const sync = createRealEstateToolSync({
    api: {
      async getLikedProperties() {
        return [{ apn: 'LIKE-NEW' }, { property: { apn: 'LIKE-OLD' } }];
      },
      async getPassedProperties() {
        return [{ apn: 'PASS-1' }];
      }
    },
    repository: {
      async getPropertyByApn(apn) {
        return {
          'LIKE-NEW': { id: 'prop-like-new', apn },
          'LIKE-OLD': { id: 'prop-like-old', apn },
          'PASS-1': { id: 'prop-pass', apn }
        }[apn] || null;
      },
      async recordSyncState() {
        return null;
      }
    },
    sellers: {
      async getSellerProfileByProperty(propertyId) {
        return {
          'prop-like-new': null,
          'prop-like-old': { id: 'seller-like-old', active: false, status: 'monitoring' },
          'prop-pass': { id: 'seller-pass', active: true, status: 'monitoring' }
        }[propertyId];
      },
      async createSellerProfile(payload) {
        createdProfiles.push(payload);
        return payload;
      },
      async updateSellerProfile(id, updates) {
        updatedProfiles.push({ id, updates });
        return { id, ...updates };
      }
    }
  });

  const summary = await sync.syncReviewDecisions();

  assert.equal(summary.created, 1);
  assert.equal(summary.activated, 1);
  assert.equal(summary.deactivated, 1);
  assert.deepEqual(createdProfiles, [
    {
      property_id: 'prop-like-new',
      status: 'monitoring',
      source: 'realestatetool_review_sync'
    }
  ]);
  assert.deepEqual(updatedProfiles, [
    {
      id: 'seller-like-old',
      updates: {
        active: true,
        status: 'monitoring'
      }
    },
    {
      id: 'seller-pass',
      updates: {
        active: false
      }
    }
  ]);
});

test('fetchTitleDocument attaches the returned recording link to the matching property', async () => {
  const attachments = [];
  const sync = createRealEstateToolSync({
    api: {
      async getRecordingDocument(apn) {
        assert.equal(apn, '123-456-789');
        return {
          document: {
            drive_link: 'https://drive.google.com/file/d/abc123/view?usp=sharing'
          }
        };
      }
    },
    repository: {
      async getPropertyByApn(apn) {
        assert.equal(apn, '123-456-789');
        return {
          id: 'property-1',
          apn,
          property_group_id: null
        };
      },
      async attachExternalDocument(property, document) {
        attachments.push({ property, document });
        return {
          id: 'document-1',
          storage_path: document.storage_path
        };
      }
    }
  });

  const result = await sync.fetchTitleDocument('123-456-789');

  assert.equal(result.attached, true);
  assert.equal(result.document_id, 'document-1');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].property.id, 'property-1');
  assert.equal(
    attachments[0].document.storage_path,
    'https://drive.google.com/file/d/abc123/view?usp=sharing'
  );
  assert.equal(
    attachments[0].document.metadata.external_url,
    'https://drive.google.com/file/d/abc123/view?usp=sharing'
  );
});

test('triggerMatchingForNewProperties runs matching for every newly added property from the latest sync state', async () => {
  const matchedPropertyIds = [];
  const sync = createRealEstateToolSync({
    repository: {
      async getLatestSyncState(kind) {
        assert.equal(kind, 'properties');
        return {
          new_property_ids: ['property-1', 'property-2']
        };
      }
    },
    matching: {
      async runMatchingForProperty(propertyId) {
        matchedPropertyIds.push(propertyId);
        return propertyId === 'property-1' ? [{ id: 'match-1' }] : [{ id: 'match-2' }, { id: 'match-3' }];
      }
    }
  });

  const summary = await sync.triggerMatchingForNewProperties();

  assert.equal(summary.processed, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(matchedPropertyIds, ['property-1', 'property-2']);
  assert.deepEqual(summary.results, [
    {
      property_id: 'property-1',
      matches: 1
    },
    {
      property_id: 'property-2',
      matches: 2
    }
  ]);
});
