const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { processAudioFile } = require('../knowledge/transcribe');
const { getGoogleClient } = require('./google-auth');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
};

const defaultDependencies = {
  fs,
  query,
  processAudioFile,
  getDriveClient: () => getGoogleClient('drive', 'v3', DRIVE_SCOPES)
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function sanitizeFolderName(value, fallback = 'item') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');

  return cleaned || fallback;
}

function guessMimeType(filePath) {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function getRootFolderName() {
  return cleanText(process.env.GOOGLE_DRIVE_ROOT_FOLDER, 'ISG-Brain');
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeFolderSegments(folder) {
  const input = Array.isArray(folder) ? folder : String(folder || '').split('/');
  const segments = input
    .map((segment) => sanitizeFolderName(segment, 'item'))
    .filter(Boolean);
  const rootFolder = getRootFolderName();

  if (segments[0] !== rootFolder) {
    segments.unshift(rootFolder);
  }

  return segments;
}

async function findFolder(drive, parentId, name) {
  const response = await drive.files.list({
    q: [
      `name = '${escapeDriveQueryValue(name)}'`,
      `mimeType = '${FOLDER_MIME_TYPE}'`,
      `'${parentId}' in parents`,
      'trashed = false'
    ].join(' and '),
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  return response.data?.files?.[0] || null;
}

async function createFolder(drive, parentId, name) {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId]
    },
    fields: 'id, name',
    supportsAllDrives: true
  });

  return response.data;
}

async function ensureDriveFolder(folder) {
  const drive = await dependencies.getDriveClient();
  const segments = normalizeFolderSegments(folder);
  let parentId = 'root';

  for (const segment of segments) {
    const existing = await findFolder(drive, parentId, segment);
    const folderRecord = existing || (await createFolder(drive, parentId, segment));
    parentId = folderRecord.id;
  }

  return parentId;
}

async function uploadFile(localPath, driveFolder, fileName) {
  const absolutePath = path.resolve(localPath);
  await dependencies.fs.promises.access(absolutePath, dependencies.fs.constants.R_OK);
  const drive = await dependencies.getDriveClient();
  const folderId = await ensureDriveFolder(driveFolder);
  const resolvedFileName = cleanText(fileName, path.basename(absolutePath));
  const response = await drive.files.create({
    requestBody: {
      name: resolvedFileName,
      parents: [folderId]
    },
    media: {
      mimeType: guessMimeType(absolutePath),
      body: dependencies.fs.createReadStream(absolutePath)
    },
    fields: 'id, name, mimeType, parents, webViewLink, webContentLink',
    supportsAllDrives: true
  });
  const file = response.data || {};

  return {
    drive_file_id: file.id || null,
    drive_folder_id: folderId,
    file_name: file.name || resolvedFileName,
    mime_type: file.mimeType || guessMimeType(absolutePath),
    web_view_link: file.webViewLink || null,
    web_content_link: file.webContentLink || null
  };
}

async function createPropertyFolder(apn, address) {
  const folderName = `${sanitizeFolderName(apn, 'unknown-apn')}_${sanitizeFolderName(address, 'property')}`;
  return ensureDriveFolder(['Properties', folderName]);
}

async function getDriveFileMetadata(driveFileId) {
  const drive = await dependencies.getDriveClient();
  const response = await drive.files.get({
    fileId: driveFileId,
    fields: 'id, name, mimeType, parents, webViewLink, webContentLink',
    supportsAllDrives: true
  });

  return response.data || {};
}

function normalizeAttachTarget(target = {}) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('attach target must be an object containing entityId, propertyId, or knowledgeEntryId');
  }

  const normalized = {
    knowledgeEntryId: cleanText(target.knowledgeEntryId, null),
    propertyId: cleanText(target.propertyId, null),
    entityId: cleanText(target.entityId, null),
    source: cleanText(target.source, 'google_drive'),
    metadata: target.metadata && typeof target.metadata === 'object' ? target.metadata : {}
  };

  if (!normalized.knowledgeEntryId && !normalized.propertyId && !normalized.entityId) {
    throw new Error('attach target must include at least one of knowledgeEntryId, propertyId, or entityId');
  }

  return normalized;
}

async function attachToBrain(driveFileId, target) {
  const fileId = cleanText(driveFileId, null);

  if (!fileId) {
    throw new Error('driveFileId is required');
  }

  const normalizedTarget = normalizeAttachTarget(target);
  const file = await getDriveFileMetadata(fileId);
  const existing = await dependencies.query(
    `
      SELECT id
      FROM drive_attachments
      WHERE drive_file_id = $1
        AND COALESCE(knowledge_entry_id::text, '') = COALESCE($2::text, '')
        AND COALESCE(property_id::text, '') = COALESCE($3::text, '')
        AND COALESCE(entity_id::text, '') = COALESCE($4::text, '')
      LIMIT 1
    `,
    [
      fileId,
      normalizedTarget.knowledgeEntryId,
      normalizedTarget.propertyId,
      normalizedTarget.entityId
    ]
  );

  if (existing.rows[0]) {
    await dependencies.query(
      `
        UPDATE drive_attachments
        SET
          drive_folder_id = $2,
          file_name = $3,
          mime_type = $4,
          web_view_link = $5,
          web_content_link = $6,
          source = $7,
          metadata = $8::jsonb,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        existing.rows[0].id,
        file.parents?.[0] || null,
        cleanText(file.name, null),
        cleanText(file.mimeType, null),
        cleanText(file.webViewLink, null),
        cleanText(file.webContentLink, null),
        normalizedTarget.source,
        JSON.stringify(normalizedTarget.metadata)
      ]
    );

    const refreshed = await dependencies.query(
      `
        SELECT *
        FROM drive_attachments
        WHERE id = $1
      `,
      [existing.rows[0].id]
    );

    return refreshed.rows[0];
  }

  const id = uuidv4();
  const result = await dependencies.query(
    `
      INSERT INTO drive_attachments (
        id,
        drive_file_id,
        drive_folder_id,
        file_name,
        mime_type,
        web_view_link,
        web_content_link,
        knowledge_entry_id,
        property_id,
        entity_id,
        source,
        metadata
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      )
      RETURNING *
    `,
    [
      id,
      fileId,
      file.parents?.[0] || null,
      cleanText(file.name, null),
      cleanText(file.mimeType, null),
      cleanText(file.webViewLink, null),
      cleanText(file.webContentLink, null),
      normalizedTarget.knowledgeEntryId,
      normalizedTarget.propertyId,
      normalizedTarget.entityId,
      normalizedTarget.source,
      JSON.stringify(normalizedTarget.metadata)
    ]
  );

  return result.rows[0];
}

async function getDocsForEntity(entityId) {
  const result = await dependencies.query(
    `
      SELECT DISTINCT ON (da.id)
        da.*
      FROM drive_attachments da
      LEFT JOIN knowledge_entries ke ON ke.id = da.knowledge_entry_id
      LEFT JOIN knowledge_entities ke_links ON ke_links.knowledge_entry_id = da.knowledge_entry_id
      LEFT JOIN properties p ON p.id = da.property_id
      WHERE da.entity_id = $1
         OR ke.entity_id = $1
         OR ke_links.entity_id = $1
         OR p.owner_entity_id = $1
         OR p.trustee_entity_id = $1
         OR p.lender_entity_id = $1
      ORDER BY da.id, da.created_at DESC
    `,
    [entityId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    drive_file_id: row.drive_file_id,
    drive_folder_id: row.drive_folder_id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    web_view_link: row.web_view_link,
    web_content_link: row.web_content_link,
    knowledge_entry_id: row.knowledge_entry_id,
    property_id: row.property_id,
    entity_id: row.entity_id,
    source: row.source,
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

async function uploadCallRecording(audioPath, brainEntityId) {
  const upload = await uploadFile(audioPath, ['Recordings'], path.basename(audioPath));
  const attachment = await attachToBrain(upload.drive_file_id, {
    entityId: brainEntityId,
    source: 'call_recording',
    metadata: {
      uploaded_from: path.resolve(audioPath)
    }
  });
  const transcription = await dependencies.processAudioFile(audioPath, {
    source: 'voice_memo'
  });

  return {
    upload,
    attachment,
    transcription
  };
}

function __setDependencies(overrides = {}) {
  dependencies = {
    ...dependencies,
    ...overrides
  };
}

function __resetDependencies() {
  dependencies = { ...defaultDependencies };
}

module.exports = {
  uploadFile,
  createPropertyFolder,
  attachToBrain,
  getDocsForEntity,
  uploadCallRecording,
  ensureDriveFolder,
  __setDependencies,
  __resetDependencies
};
