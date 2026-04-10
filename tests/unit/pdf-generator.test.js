const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPdfGenerator } = require('../../src/integrations/pdf-generator');

function buildDriveClient(uploadCalls) {
  return {
    async uploadFile(filePath, driveFolder, fileName) {
      uploadCalls.push({ filePath, driveFolder, fileName });
      return {
        drive_file_id: `drive-${uploadCalls.length}`,
        web_view_link: `https://drive.example/${encodeURIComponent(fileName)}`
      };
    }
  };
}

function buildGenerator({ outputRoot, uploadCalls, loaders }) {
  return createPdfGenerator({
    outputRoot,
    now: () => new Date('2026-04-10T15:30:00.000Z'),
    driveClient: buildDriveClient(uploadCalls),
    ...loaders
  });
}

async function assertGeneratedPdf(result, uploadCalls, expectedFolder) {
  assert.equal(result.size_bytes > 0, true);
  assert.equal(path.extname(result.file_name), '.pdf');
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].driveFolder, expectedFolder);

  const stats = await fs.promises.stat(result.file_path);
  assert.equal(stats.size > 0, true);
}

test('generateMeetingBrief writes a non-empty PDF and uploads it', async (t) => {
  const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-pdf-meeting-'));
  const uploadCalls = [];

  t.after(async () => {
    await fs.promises.rm(outputRoot, { recursive: true, force: true });
  });

  const generator = buildGenerator({
    outputRoot,
    uploadCalls,
    loaders: {
      async loadMeetingBriefData() {
        return {
          entity: {
            id: 'entity-1',
            name: 'Jordan Lee',
            type: 'person',
            source: 'test'
          },
          companies: [{ name: 'Lee Industrial LLC', type: 'llc', relationship: 'owner' }],
          portfolio: {
            properties: [
              {
                address: '123 Main St',
                city: 'Los Angeles',
                state: 'CA',
                property_type: 'industrial',
                assessed_value: 2500000,
                foreclosure: false
              }
            ],
            total_assessed_value: 2500000
          },
          recentConversations: [
            {
              title: 'Buyer call',
              summary: 'Looking for a new industrial acquisition.',
              action_items: ['Send updated package'],
              created_at: '2026-04-09T18:00:00.000Z'
            }
          ],
          activeOpportunities: [
            {
              property_address: '123 Main St',
              kind: 'match',
              status: 'suggested',
              score: 88,
              reasoning: 'Strong asset fit'
            }
          ],
          buyerProfile: {
            investment_strategy: 'value_add'
          },
          sellerProfiles: [],
          talkingPoints: ['Ask about timing', 'Confirm pricing expectations']
        };
      }
    }
  });

  const result = await generator.generateMeetingBrief('entity-1');
  await assertGeneratedPdf(result, uploadCalls, 'ISG-Brain/Briefs');
});

test('generateProposal writes a non-empty PDF and uploads it', async (t) => {
  const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-pdf-proposal-'));
  const uploadCalls = [];

  t.after(async () => {
    await fs.promises.rm(outputRoot, { recursive: true, force: true });
  });

  const generator = buildGenerator({
    outputRoot,
    uploadCalls,
    loaders: {
      async loadProposalData() {
        return {
          property: {
            id: 'prop-1',
            apn: '111-AAA-001',
            address: '123 Main St',
            city: 'Los Angeles',
            state: 'CA',
            property_type: 'industrial',
            sq_feet: 18000,
            lot_size: 30000,
            assessed_value: 3200000,
            foreclosure: true
          },
          sellerProfile: {
            asking_price: 3500000,
            minimum_acceptable: 3300000,
            estimated_equity: 1200000,
            situation_summary: 'Seller wants speed and certainty.'
          },
          documents: [],
          images: [],
          comparableProperties: [],
          salesComps: [],
          rentSignals: [],
          marketSnapshot: {
            sameTypeInventory: 8,
            nearbyForeclosures: 2,
            averageAssessedValue: 2800000
          },
          knowledgeHighlights: [{ summary: 'Urgent foreclosure timeline.' }],
          marketingPlan: ['Start with top buyers', 'Package title context']
        };
      }
    }
  });

  const result = await generator.generateProposal('prop-1');
  await assertGeneratedPdf(result, uploadCalls, 'ISG-Brain/Properties/111-aaa-001_123-main-st/Proposals');
});

test('generatePropertyFlyer writes a non-empty PDF and uploads it', async (t) => {
  const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-pdf-flyer-'));
  const uploadCalls = [];

  t.after(async () => {
    await fs.promises.rm(outputRoot, { recursive: true, force: true });
  });

  const generator = buildGenerator({
    outputRoot,
    uploadCalls,
    loaders: {
      async loadFlyerData() {
        return {
          property: {
            id: 'prop-2',
            apn: '222-BBB-002',
            address: '456 Market St',
            city: 'Torrance',
            state: 'CA',
            property_type: 'retail',
            sq_feet: 9500,
            lot_size: 15000,
            assessed_value: 2100000,
            foreclosure: false
          },
          sellerProfile: {
            asking_price: 2250000,
            timeline: '30_days',
            motivation: 'retirement'
          },
          heroImage: null,
          matchHeadline: 'Top current fit: Harbor Retail Group scored 84.',
          contact: {
            name: 'Alex Broker',
            email: 'alex@example.com',
            phone: '555-0100'
          }
        };
      }
    }
  });

  const result = await generator.generatePropertyFlyer('prop-2');
  await assertGeneratedPdf(result, uploadCalls, 'ISG-Brain/Properties/222-bbb-002_456-market-st/Marketing');
});

test('generateDailyBrief writes a non-empty PDF and uploads it', async (t) => {
  const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-pdf-daily-'));
  const uploadCalls = [];

  t.after(async () => {
    await fs.promises.rm(outputRoot, { recursive: true, force: true });
  });

  const generator = buildGenerator({
    outputRoot,
    uploadCalls,
    loaders: {
      async loadDailyBriefData() {
        return {
          actionItems: [
            {
              knowledge_entry_id: 'ke-1',
              summary: 'Call top buyer back.',
              action: 'Call buyer',
              created_at: '2026-04-10T09:00:00.000Z'
            }
          ],
          distressedSellers: [
            {
              entity_name: 'Main Street LLC',
              address: '789 Elm St',
              distress_level: 5
            }
          ],
          topMatches: [
            {
              buyer_name: 'Harbor Capital',
              seller_name: 'Main Street LLC',
              property_address: '789 Elm St',
              score: 92,
              reasoning: 'Excellent fit',
              status: 'suggested'
            }
          ]
        };
      }
    }
  });

  const result = await generator.generateDailyBrief();
  await assertGeneratedPdf(result, uploadCalls, 'ISG-Brain/Briefs/Daily');
});
