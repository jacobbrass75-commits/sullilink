const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { query, close } = require('../../src/db/connection');
const {
  attachToBrain,
  getDocsForEntity,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/drive');

const ROOT = path.join(__dirname, '..', '..');

function runNodeScript(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
}

async function resetTables() {
  await query(`
    TRUNCATE
      drive_attachments,
      buyer_purchases,
      property_documents,
      property_import_records,
      wiki_promotion_queue,
      knowledge_entities,
      knowledge_properties,
      property_groups,
      entity_relationships,
      deals,
      matches,
      seller_profiles,
      buyer_profiles,
      knowledge_entries,
      properties,
      entities
    RESTART IDENTITY CASCADE
  `);
}

function isPortOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(value) {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, host);
  });
}

test('Drive attachments persist metadata and are discoverable by entity', async (t) => {
  t.after(async () => {
    __resetDependencies();
    await close();
  });

  const postgresHost = process.env.POSTGRES_HOST || 'localhost';
  const postgresPort = Number(process.env.POSTGRES_PORT || 5433);

  if (!(await isPortOpen(postgresHost, postgresPort))) {
    t.skip(`Postgres is not available at ${postgresHost}:${postgresPort}`);
    return;
  }

  const migrateRun = runNodeScript(path.join(ROOT, 'scripts', 'migrate.js'));
  assert.equal(migrateRun.status, 0, migrateRun.stderr || migrateRun.stdout);

  await resetTables();

  const entityId = '11111111-1111-1111-1111-111111111111';
  await query(
    `
      INSERT INTO entities (id, entity_type, name, normalized_name, source)
      VALUES ($1, 'person', 'Broker Test', 'broker test', 'test')
    `,
    [entityId]
  );

  __setDependencies({
    getDriveClient: async () => ({
      files: {
        get: async () => ({
          data: {
            id: 'drive-file-1',
            name: 'brief.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-1'],
            webViewLink: 'https://drive.example.com/view/brief',
            webContentLink: 'https://drive.example.com/download/brief'
          }
        })
      }
    })
  });

  const attachment = await attachToBrain('drive-file-1', {
    entityId,
    metadata: {
      category: 'meeting_brief'
    }
  });
  const countResult = await query('SELECT COUNT(*)::int AS count FROM drive_attachments');
  const docs = await getDocsForEntity(entityId);

  assert.equal(attachment.drive_file_id, 'drive-file-1');
  assert.equal(countResult.rows[0].count, 1);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].file_name, 'brief.pdf');
  assert.equal(docs[0].entity_id, entityId);
  assert.equal(docs[0].metadata.category, 'meeting_brief');
});
