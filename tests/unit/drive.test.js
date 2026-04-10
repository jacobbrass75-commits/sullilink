const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachToBrain,
  getDocsForEntity,
  __setDependencies,
  __resetDependencies
} = require('../../src/integrations/drive');

test.afterEach(() => {
  __resetDependencies();
});

test('attachToBrain stores Drive metadata and getDocsForEntity returns attachments', async () => {
  const queries = [];
  const storedAttachment = {
    id: 'attachment-1',
    drive_file_id: 'drive-file-1',
    drive_folder_id: 'folder-1',
    file_name: 'brief.pdf',
    mime_type: 'application/pdf',
    web_view_link: 'https://drive.example.com/view/brief',
    web_content_link: 'https://drive.example.com/download/brief',
    knowledge_entry_id: null,
    property_id: null,
    entity_id: 'entity-1',
    source: 'google_drive',
    metadata: {
      category: 'meeting_brief'
    }
  };

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
    }),
    query: async (sql, params = []) => {
      queries.push({ sql, params });

      if (sql.includes('FROM drive_attachments') && sql.includes('LIMIT 1')) {
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO drive_attachments')) {
        return { rows: [storedAttachment] };
      }

      if (sql.includes('SELECT DISTINCT ON (da.id)')) {
        return { rows: [storedAttachment] };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    }
  });

  const attachment = await attachToBrain('drive-file-1', {
    entityId: 'entity-1',
    metadata: {
      category: 'meeting_brief'
    }
  });
  const docs = await getDocsForEntity('entity-1');

  assert.equal(attachment.drive_file_id, 'drive-file-1');
  assert.equal(attachment.file_name, 'brief.pdf');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].entity_id, 'entity-1');
  assert.equal(docs[0].metadata.category, 'meeting_brief');
  assert.equal(
    queries.some(({ sql }) => sql.includes('INSERT INTO drive_attachments')),
    true
  );
});
