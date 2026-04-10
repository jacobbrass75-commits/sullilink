const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const {
  fetchAllProperties,
  getLikedProperties,
  getPassedProperties,
  getRecordingDocument
} = require('./realestatetool');
const {
  normalizeImportedProperty,
  upsertProperties: upsertImportedProperties
} = require('../../scripts/import-from-realestatetool');
const { processPropertyEntities } = require('../entities/extract');
const { getDistressAssessment } = require('../sellers/distress-score');
const { classifyForeclosureStage } = require('../sellers/foreclosure-stage');
const {
  createSellerProfile,
  getSellerProfileByProperty,
  updateSellerProfile
} = require('../sellers/profiles');
const { runMatchingForProperty } = require('../matching/runner');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildPropertyKey(property) {
  const apn = cleanText(property?.apn, '');
  const region = cleanText(property?.region, 'la_county');

  if (!apn) {
    return '';
  }

  return `${apn}::${region}`;
}

function computeEstimatedEquity(property) {
  const directEquity = toNumber(property?.equity_amount);

  if (directEquity != null) {
    return directEquity;
  }

  const assessedValue = toNumber(property?.assessed_value);
  const loanAmount = toNumber(property?.loan_amount);

  if (assessedValue != null && loanAmount != null) {
    return assessedValue - loanAmount;
  }

  const rawEquityPercent = toNumber(property?.equity_percent);

  if (assessedValue != null && rawEquityPercent != null) {
    const equityPercent = rawEquityPercent <= 1 ? rawEquityPercent * 100 : rawEquityPercent;
    return assessedValue * (equityPercent / 100);
  }

  return null;
}

function deriveTimeline(stage, distressLevel) {
  if (stage === 'auction_pending' || stage === 'reo' || distressLevel >= 4) {
    return 'urgent';
  }

  if (stage === 'notice_of_sale') {
    return '30_days';
  }

  if (stage === 'notice_of_default') {
    return '60_days';
  }

  if (stage === 'pre_foreclosure') {
    return '90_days';
  }

  return 'flexible';
}

function dedupePropertyCandidates(candidates) {
  const deduped = new Map();

  for (const candidate of candidates) {
    const key = buildPropertyKey(candidate.normalized);

    if (!key) {
      continue;
    }

    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }

    const existingTime = existing.imported_at ? existing.imported_at.getTime() : -Infinity;
    const nextTime = candidate.imported_at ? candidate.imported_at.getTime() : -Infinity;

    if (nextTime >= existingTime) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}

function extractDecisionApn(decision) {
  if (typeof decision === 'string') {
    return cleanText(decision);
  }

  return cleanText(
    decision?.apn ||
      decision?.property_apn ||
      decision?.parcel_number ||
      decision?.parcelNumber ||
      decision?.property?.apn ||
      decision?.property?.property_apn ||
      decision?.property?.parcel_number ||
      null
  );
}

function extractRecordingDocumentLink(payload) {
  const visited = new Set();

  function search(node) {
    if (!node) {
      return null;
    }

    if (typeof node === 'string') {
      const trimmed = node.trim();
      return /^https?:\/\//i.test(trimmed) ? trimmed : null;
    }

    if (typeof node !== 'object') {
      return null;
    }

    if (visited.has(node)) {
      return null;
    }

    visited.add(node);

    const directKeys = [
      'drive_link',
      'driveLink',
      'url',
      'link',
      'document_url',
      'documentUrl',
      'recording_doc_link',
      'recordingDocLink',
      'share_url',
      'shareUrl',
      'download_url',
      'downloadUrl'
    ];

    for (const key of directKeys) {
      const direct = cleanText(node[key]);

      if (direct && /^https?:\/\//i.test(direct)) {
        return direct;
      }
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = search(entry);

        if (found) {
          return found;
        }
      }

      return null;
    }

    for (const value of Object.values(node)) {
      const found = search(value);

      if (found) {
        return found;
      }
    }

    return null;
  }

  return search(payload);
}

function sanitizeFileName(fileName) {
  return String(fileName || 'recording-document.pdf')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getFileNameFromLink(apn, link) {
  try {
    const url = new URL(link);
    const segment = url.pathname.split('/').filter(Boolean).pop();

    if (segment && segment.includes('.')) {
      return sanitizeFileName(decodeURIComponent(segment));
    }
  } catch (_error) {
    // Fall back to a synthetic name below.
  }

  const apnSlug = sanitizeFileName(cleanText(apn, 'recording-document'));
  return `${apnSlug}.pdf`;
}

async function* defaultListPropertyBatches(options = {}) {
  for await (const batch of fetchAllProperties(options)) {
    yield batch;
  }
}

const defaultRepository = {
  async getLatestSyncState(kind) {
    const result = await query(
      `
        SELECT raw_data, created_at
        FROM property_import_records
        WHERE source = 'realestatetool_sync'
          AND source_record_key LIKE $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [`${kind}:%`]
    );

    if (!result.rows[0]) {
      return null;
    }

    const rawData = result.rows[0].raw_data && typeof result.rows[0].raw_data === 'object'
      ? result.rows[0].raw_data
      : {};

    return {
      ...rawData,
      recorded_at: result.rows[0].created_at
    };
  },

  async recordSyncState(kind, state) {
    const syncedAt = cleanText(state?.synced_at, new Date().toISOString());

    await query(
      `
        INSERT INTO property_import_records (
          id,
          source,
          source_record_key,
          raw_data
        )
        VALUES ($1, 'realestatetool_sync', $2, $3::jsonb)
      `,
      [uuidv4(), `${kind}:${syncedAt}`, JSON.stringify(state || {})]
    );

    return state;
  },

  async findPropertiesByKeys(keys) {
    const uniqueApns = uniqueValues(keys.map((key) => cleanText(key?.apn)).filter(Boolean));

    if (uniqueApns.length === 0) {
      return [];
    }

    const result = await query(
      `
        SELECT id, apn, region
        FROM properties
        WHERE apn = ANY($1::text[])
      `,
      [uniqueApns]
    );

    const requestedKeys = new Set(keys.map((key) => buildPropertyKey(key)).filter(Boolean));
    return result.rows.filter((row) => requestedKeys.has(buildPropertyKey(row)));
  },

  async getPropertiesByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }

    const result = await query(
      `
        SELECT *
        FROM properties
        WHERE id = ANY($1::uuid[])
      `,
      [ids]
    );

    return result.rows;
  },

  async getPropertyByApn(apn) {
    const cleanApn = cleanText(apn);

    if (!cleanApn) {
      return null;
    }

    const result = await query(
      `
        SELECT *
        FROM properties
        WHERE apn = $1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `,
      [cleanApn]
    );

    return result.rows[0] || null;
  },

  async countOwnerForeclosures(ownerEntityId) {
    if (!ownerEntityId) {
      return 0;
    }

    const result = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM properties
        WHERE owner_entity_id = $1
          AND foreclosure = TRUE
      `,
      [ownerEntityId]
    );

    return result.rows[0]?.count || 0;
  },

  async attachExternalDocument(property, document) {
    const storagePath = cleanText(document?.storage_path);

    if (!property?.id || !storagePath) {
      throw new Error('property and storage_path are required to attach an external document');
    }

    const sha256 = crypto.createHash('sha256').update(storagePath).digest('hex');
    const result = await query(
      `
        INSERT INTO property_documents (
          id,
          property_id,
          property_group_id,
          file_name,
          storage_path,
          mime_type,
          file_size,
          sha256,
          document_type,
          source,
          notes,
          metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
        )
        ON CONFLICT (property_id, sha256)
        DO UPDATE SET
          storage_path = EXCLUDED.storage_path,
          file_name = EXCLUDED.file_name,
          mime_type = EXCLUDED.mime_type,
          document_type = EXCLUDED.document_type,
          source = EXCLUDED.source,
          notes = COALESCE(EXCLUDED.notes, property_documents.notes),
          metadata = property_documents.metadata || EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *
      `,
      [
        uuidv4(),
        property.id,
        property.property_group_id || null,
        cleanText(document.file_name, `${sanitizeFileName(property.apn || property.id)}.pdf`),
        storagePath,
        cleanText(document.mime_type, 'application/pdf'),
        Math.max(Number(document.file_size) || 0, 0),
        sha256,
        cleanText(document.document_type, 'recording_document'),
        cleanText(document.source, 'realestatetool'),
        cleanText(document.notes),
        JSON.stringify(document.metadata || {})
      ]
    );

    return result.rows[0];
  }
};

async function scorePropertySet(properties, deps) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const property of properties) {
    try {
      const ownerForeclosureCount = await deps.repository.countOwnerForeclosures(property.owner_entity_id);
      const assessment = getDistressAssessment(property, {
        owner_foreclosure_count: ownerForeclosureCount
      });
      const stage = classifyForeclosureStage(property);
      const sellerPayload = {
        motivation: property.foreclosure ? 'foreclosure' : 'unknown',
        distress_level: assessment.score,
        timeline: deriveTimeline(stage, assessment.score),
        foreclosure_stage: stage,
        outstanding_debt: toNumber(property.default_amount, toNumber(property.loan_amount)),
        estimated_equity: computeEstimatedEquity(property),
        lender_status:
          property.foreclosure &&
          (property.trustee_entity_id || property.lender_entity_id || property.trustee_name)
            ? 'pursuing_foreclosure'
            : 'unknown',
        source: 'realestatetool_sync'
      };
      const existing = await deps.sellers.getSellerProfileByProperty(property.id);

      if (existing) {
        await deps.sellers.updateSellerProfile(existing.id, sellerPayload);
        updated += 1;
      } else {
        await deps.sellers.createSellerProfile({
          property_id: property.id,
          status: 'monitoring',
          ...sellerPayload
        });
        created += 1;
      }
    } catch (_error) {
      skipped += 1;
    }
  }

  return {
    created,
    updated,
    skipped
  };
}

function createRealEstateToolSync(overrides = {}) {
  const deps = {
    api: {
      listPropertyBatches: defaultListPropertyBatches,
      getLikedProperties,
      getPassedProperties,
      getRecordingDocument,
      ...(overrides.api || {})
    },
    repository: {
      ...defaultRepository,
      ...(overrides.repository || {})
    },
    sellers: {
      createSellerProfile,
      getSellerProfileByProperty,
      updateSellerProfile,
      ...(overrides.sellers || {})
    },
    matching: {
      runMatchingForProperty,
      ...(overrides.matching || {})
    },
    normalizeProperty: overrides.normalizeProperty || normalizeImportedProperty,
    upsertProperties: overrides.upsertProperties || upsertImportedProperties,
    processPropertyEntities: overrides.processPropertyEntities || processPropertyEntities
  };

  deps.scoreProperties = overrides.scoreProperties || ((properties) => scorePropertySet(properties, deps));

  async function syncNewProperties(options = {}) {
    const now = new Date();
    const lastState = options.force ? null : await deps.repository.getLatestSyncState('properties');
    const lastSyncAt = toDate(lastState?.synced_at || lastState?.recorded_at);
    const candidates = [];
    let scanned = 0;
    let skippedStale = 0;
    let skippedMissingImportedAt = 0;
    let skippedInvalid = 0;

    for await (const batch of deps.api.listPropertyBatches(options)) {
      for (const remoteProperty of batch || []) {
        scanned += 1;

        const importedAt = toDate(remoteProperty?.imported_at);

        if (lastSyncAt) {
          if (!importedAt) {
            skippedMissingImportedAt += 1;
            continue;
          }

          if (importedAt <= lastSyncAt) {
            skippedStale += 1;
            continue;
          }
        }

        const normalized = deps.normalizeProperty(remoteProperty);

        if (!cleanText(normalized?.apn)) {
          skippedInvalid += 1;
          continue;
        }

        candidates.push({
          raw: remoteProperty,
          normalized,
          imported_at: importedAt
        });
      }
    }

    const dedupedCandidates = dedupePropertyCandidates(candidates);
    const existingRows = await deps.repository.findPropertiesByKeys(
      dedupedCandidates.map((candidate) => candidate.normalized)
    );
    const existingMap = new Map(existingRows.map((row) => [buildPropertyKey(row), row]));
    const upsertedRows = dedupedCandidates.length > 0
      ? await deps.upsertProperties(dedupedCandidates.map((candidate) => candidate.normalized))
      : [];
    const createdRows = [];
    const updatedRows = [];

    for (const row of upsertedRows) {
      if (existingMap.has(buildPropertyKey(row))) {
        updatedRows.push(row);
      } else {
        createdRows.push(row);
      }
    }

    let entitySummary = {
      created: 0,
      existing: 0,
      linked: 0
    };
    let sellerSummary = {
      created: 0,
      updated: 0,
      skipped: 0
    };

    if (upsertedRows.length > 0) {
      entitySummary = await deps.processPropertyEntities(upsertedRows);
      const fullProperties = await deps.repository.getPropertiesByIds(upsertedRows.map((row) => row.id));
      sellerSummary = await deps.scoreProperties(fullProperties);
    }

    const syncState = {
      synced_at: now.toISOString(),
      last_sync_at: lastSyncAt ? lastSyncAt.toISOString() : null,
      scanned,
      skipped_stale: skippedStale,
      skipped_missing_imported_at: skippedMissingImportedAt,
      skipped_invalid: skippedInvalid,
      synced_property_ids: upsertedRows.map((row) => row.id),
      new_property_ids: createdRows.map((row) => row.id),
      updated_property_ids: updatedRows.map((row) => row.id),
      synced_apns: upsertedRows.map((row) => row.apn)
    };

    await deps.repository.recordSyncState('properties', syncState);

    return {
      last_sync_at: syncState.last_sync_at,
      synced_at: syncState.synced_at,
      scanned,
      synced: upsertedRows.length,
      created: createdRows.length,
      updated: updatedRows.length,
      skipped_stale: skippedStale,
      skipped_missing_imported_at: skippedMissingImportedAt,
      skipped_invalid: skippedInvalid,
      new_properties: createdRows,
      updated_properties: updatedRows,
      entities: entitySummary,
      sellers: sellerSummary
    };
  }

  async function syncReviewDecisions(options = {}) {
    const likedDecisions = await deps.api.getLikedProperties(options);
    const passedDecisions = await deps.api.getPassedProperties(options);
    const likedMap = new Map();
    const passedMap = new Map();

    for (const decision of likedDecisions || []) {
      const apn = extractDecisionApn(decision);

      if (apn) {
        likedMap.set(apn, decision);
      }
    }

    for (const decision of passedDecisions || []) {
      const apn = extractDecisionApn(decision);

      if (apn && !likedMap.has(apn)) {
        passedMap.set(apn, decision);
      }
    }

    let created = 0;
    let activated = 0;
    let deactivated = 0;
    let skippedMissingProperty = 0;
    let skippedMissingProfile = 0;

    for (const apn of likedMap.keys()) {
      const property = await deps.repository.getPropertyByApn(apn);

      if (!property) {
        skippedMissingProperty += 1;
        continue;
      }

      const existing = await deps.sellers.getSellerProfileByProperty(property.id);

      if (existing) {
        await deps.sellers.updateSellerProfile(existing.id, {
          active: true,
          status: existing.status === 'not_interested' ? 'monitoring' : existing.status
        });
        activated += 1;
      } else {
        await deps.sellers.createSellerProfile({
          property_id: property.id,
          status: 'monitoring',
          source: 'realestatetool_review_sync'
        });
        created += 1;
      }
    }

    for (const apn of passedMap.keys()) {
      const property = await deps.repository.getPropertyByApn(apn);

      if (!property) {
        skippedMissingProperty += 1;
        continue;
      }

      const existing = await deps.sellers.getSellerProfileByProperty(property.id);

      if (!existing) {
        skippedMissingProfile += 1;
        continue;
      }

      await deps.sellers.updateSellerProfile(existing.id, {
        active: false
      });
      deactivated += 1;
    }

    const summary = {
      synced_at: new Date().toISOString(),
      liked_total: likedMap.size,
      passed_total: passedMap.size,
      created,
      activated,
      deactivated,
      skipped_missing_property: skippedMissingProperty,
      skipped_missing_profile: skippedMissingProfile
    };

    await deps.repository.recordSyncState('reviews', summary);
    return summary;
  }

  async function fetchTitleDocument(apn) {
    const cleanApn = cleanText(apn);

    if (!cleanApn) {
      throw new Error('apn is required');
    }

    const property = await deps.repository.getPropertyByApn(cleanApn);

    if (!property) {
      return {
        apn: cleanApn,
        attached: false,
        reason: 'property_not_found'
      };
    }

    const payload = await deps.api.getRecordingDocument(cleanApn);
    const link = extractRecordingDocumentLink(payload);

    if (!link) {
      return {
        apn: cleanApn,
        property_id: property.id,
        attached: false,
        reason: 'recording_document_missing'
      };
    }

    const document = await deps.repository.attachExternalDocument(property, {
      file_name: getFileNameFromLink(cleanApn, link),
      storage_path: link,
      mime_type: 'application/pdf',
      file_size: 0,
      document_type: 'recording_document',
      source: 'realestatetool',
      notes: 'Synced from realestatetool title/recording document',
      metadata: {
        external_url: link,
        provider: 'realestatetool',
        payload
      }
    });

    return {
      apn: cleanApn,
      property_id: property.id,
      attached: true,
      document_id: document.id,
      storage_path: document.storage_path
    };
  }

  async function triggerMatchingForNewProperties() {
    const state = await deps.repository.getLatestSyncState('properties');
    const propertyIds = Array.isArray(state?.new_property_ids) ? state.new_property_ids : [];
    const results = [];
    const errors = [];

    for (const propertyId of propertyIds) {
      try {
        const matches = await deps.matching.runMatchingForProperty(propertyId);
        results.push({
          property_id: propertyId,
          matches: Array.isArray(matches) ? matches.length : null
        });
      } catch (error) {
        errors.push({
          property_id: propertyId,
          error: error.message
        });
      }
    }

    return {
      triggered_at: new Date().toISOString(),
      property_ids: propertyIds,
      processed: results.length,
      failed: errors.length,
      results,
      errors
    };
  }

  return {
    syncNewProperties,
    syncReviewDecisions,
    fetchTitleDocument,
    triggerMatchingForNewProperties
  };
}

const defaultSync = createRealEstateToolSync();

module.exports = {
  createRealEstateToolSync,
  syncNewProperties: defaultSync.syncNewProperties,
  syncReviewDecisions: defaultSync.syncReviewDecisions,
  fetchTitleDocument: defaultSync.fetchTitleDocument,
  triggerMatchingForNewProperties: defaultSync.triggerMatchingForNewProperties
};
