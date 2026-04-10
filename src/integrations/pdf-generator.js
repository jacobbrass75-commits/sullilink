const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { query } = require('../db/connection');
const { getPortfolio } = require('../entities/cluster');
const { getSellerProfileByProperty } = require('../sellers/profiles');
const { buildMeetingBriefTemplate } = require('../templates/meeting-brief');
const { buildProposalTemplate } = require('../templates/proposal');
const { buildPropertyFlyerTemplate } = require('../templates/property-flyer');
const { buildDailyBriefTemplate } = require('../templates/daily-brief');
const {
  cleanText,
  slugifySegment,
  uniqueStrings
} = require('../templates/pdf-helpers');

const COLORS = {
  ink: '#17324d',
  accent: '#be6d2c',
  muted: '#687788',
  line: '#d8cec1',
  panel: '#f6f1e8',
  text: '#21303f',
  white: '#ffffff'
};

function createNotFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function safeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureOutputRoot(root = null) {
  return path.resolve(process.cwd(), root || process.env.ISG_PDF_OUTPUT_ROOT || 'data/generated-pdfs');
}

function defaultNow() {
  return new Date();
}

function resolveDriveClient(explicitClient = null) {
  if (explicitClient && typeof explicitClient.uploadFile === 'function') {
    return explicitClient;
  }

  try {
    const drive = require('./drive');

    if (drive && typeof drive.uploadFile === 'function') {
      return drive;
    }
  } catch (_error) {
    // Integration may not be merged yet. Fall through to the no-op seam.
  }

  return {
    async uploadFile(localPath, driveFolder, fileName) {
      return {
        status: 'skipped',
        reason: 'drive_integration_unavailable',
        local_path: localPath,
        drive_folder: driveFolder,
        file_name: fileName
      };
    }
  };
}

async function savePdfToDrive({ driveClient, filePath, driveFolder, fileName }) {
  const response = await driveClient.uploadFile(filePath, driveFolder, fileName);

  if (typeof response === 'string') {
    return {
      url: response,
      local_path: filePath,
      drive_folder: driveFolder,
      file_name: fileName
    };
  }

  if (response && typeof response === 'object') {
    return {
      local_path: filePath,
      drive_folder: driveFolder,
      file_name: fileName,
      ...response
    };
  }

  return {
    local_path: filePath,
    drive_folder: driveFolder,
    file_name: fileName
  };
}

function createPdfDocument() {
  return new PDFDocument({
    size: 'LETTER',
    margins: {
      top: 42,
      right: 42,
      bottom: 42,
      left: 42
    },
    bufferPages: true
  });
}

function collectPdfBuffer(doc, renderFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    Promise.resolve()
      .then(() => renderFn(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

function createRenderer(doc, definition) {
  const margin = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;

  function startNewPage() {
    doc.addPage();
    drawContinuationHeader();
  }

  function ensureSpace(height) {
    if (doc.y + height <= bottomLimit()) {
      return;
    }

    startNewPage();
  }

  function drawContinuationHeader() {
    doc
      .save()
      .fillColor(COLORS.accent)
      .rect(margin, doc.page.margins.top - 14, contentWidth, 2)
      .fill()
      .restore();

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLORS.ink)
      .text(definition.title, margin, doc.page.margins.top - 2, {
        width: contentWidth * 0.7
      });

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(definition.eyebrow || 'ISG Second Brain', margin + contentWidth * 0.72, doc.page.margins.top - 2, {
        width: contentWidth * 0.28,
        align: 'right'
      });

    doc.moveDown(1.5);
  }

  function drawDocumentHeader() {
    doc
      .save()
      .fillColor(COLORS.ink)
      .rect(margin, doc.page.margins.top - 4, contentWidth, 10)
      .fill()
      .restore();

    doc.moveDown(0.7);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(COLORS.accent)
      .text(definition.eyebrow || 'ISG Second Brain', margin);

    doc
      .font('Helvetica-Bold')
      .fontSize(22)
      .fillColor(COLORS.ink)
      .text(definition.title, margin, doc.y + 4, {
        width: contentWidth * 0.68
      });

    const subtitleY = doc.y - 24;
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(COLORS.muted)
      .text(definition.subtitle || '', margin + contentWidth * 0.68, subtitleY, {
        width: contentWidth * 0.32,
        align: 'right'
      });

    doc.moveDown(0.8);
  }

  function drawMetrics(metrics = []) {
    if (!Array.isArray(metrics) || metrics.length === 0) {
      return;
    }

    ensureSpace(74);
    const gap = 12;
    const boxWidth = (contentWidth - gap * (metrics.length - 1)) / metrics.length;
    const top = doc.y;

    metrics.forEach((metric, index) => {
      const left = margin + index * (boxWidth + gap);
      doc
        .save()
        .roundedRect(left, top, boxWidth, 56, 8)
        .fillAndStroke(COLORS.panel, COLORS.line)
        .restore();

      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.muted)
        .text(metric.label || '', left + 12, top + 10, {
          width: boxWidth - 24
        });

      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .fillColor(COLORS.ink)
        .text(metric.value || '', left + 12, top + 26, {
          width: boxWidth - 24
        });
    });

    doc.y = top + 68;
  }

  function drawSectionTitle(section) {
    ensureSpace(26);
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(COLORS.ink)
      .text(section.title, margin, doc.y);

    doc
      .save()
      .fillColor(COLORS.accent)
      .rect(margin, doc.y + 3, contentWidth * 0.18, 2)
      .fill()
      .restore();

    doc.moveDown(0.7);
  }

  function drawFacts(items = []) {
    const gap = 12;
    const columnWidth = (contentWidth - gap) / 2;
    let index = 0;

    while (index < items.length) {
      const rowItems = items.slice(index, index + 2);
      const heights = rowItems.map((item) => {
        const valueHeight = doc.heightOfString(String(item.value || ''), {
          width: columnWidth - 24
        });
        return Math.max(52, 28 + valueHeight);
      });
      const rowHeight = Math.max(...heights);
      ensureSpace(rowHeight + 10);
      const top = doc.y;

      rowItems.forEach((item, column) => {
        const left = margin + column * (columnWidth + gap);
        doc
          .save()
          .roundedRect(left, top, columnWidth, rowHeight, 8)
          .fillAndStroke(COLORS.panel, COLORS.line)
          .restore();

        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.muted)
          .text(item.label || '', left + 12, top + 10, {
            width: columnWidth - 24
          });

        doc
          .font('Helvetica-Bold')
          .fontSize(11)
          .fillColor(COLORS.text)
          .text(String(item.value || ''), left + 12, top + 24, {
            width: columnWidth - 24
          });
      });

      doc.y = top + rowHeight + 10;
      index += 2;
    }
  }

  function drawCards(items = []) {
    for (const item of items) {
      const bodyText = Array.isArray(item.body) ? item.body.filter(Boolean).join('\n') : String(item.body || '');
      const estimatedHeight =
        38 +
        doc.heightOfString(cleanText(item.title, ''), { width: contentWidth - 32 }) +
        doc.heightOfString(cleanText(item.meta, ''), { width: contentWidth - 32 }) +
        doc.heightOfString(bodyText, { width: contentWidth - 32 }) +
        doc.heightOfString(cleanText(item.footer, ''), { width: contentWidth - 32 });

      ensureSpace(estimatedHeight + 12);
      const top = doc.y;

      doc
        .save()
        .roundedRect(margin, top, contentWidth, estimatedHeight, 8)
        .fillAndStroke(COLORS.panel, COLORS.line)
        .restore();

      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(COLORS.ink)
        .text(item.title || '', margin + 14, top + 12, {
          width: contentWidth - 28
        });

      const metaY = doc.y + 2;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(item.meta || '', margin + 14, metaY, {
          width: contentWidth - 28
        });

      const bodyY = doc.y + 6;
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLORS.text)
        .text(bodyText, margin + 14, bodyY, {
          width: contentWidth - 28
        });

      const footerY = doc.y + 6;
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(COLORS.accent)
        .text(item.footer || '', margin + 14, footerY, {
          width: contentWidth - 28
        });

      doc.y = top + estimatedHeight + 12;
    }
  }

  function drawBullets(items = []) {
    for (const item of items) {
      ensureSpace(24);
      const top = doc.y;
      doc
        .save()
        .fillColor(COLORS.accent)
        .circle(margin + 5, top + 7, 2.5)
        .fill()
        .restore();

      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(COLORS.text)
        .text(String(item || ''), margin + 16, top, {
          width: contentWidth - 16
        });

      doc.moveDown(0.4);
    }
  }

  function drawTable(columns = [], rows = []) {
    const tableTop = doc.y;
    const widths = columns.map((column) => column.width || 1 / columns.length);
    const columnWidths = widths.map((width) => width * contentWidth);
    const cellPadding = 8;

    function drawRow(row, rowIndex, isHeader = false) {
      const normalized = typeof row === 'object' && !Array.isArray(row) ? row : {};
      const cellHeights = columns.map((column, index) =>
        doc.heightOfString(
          isHeader ? column.label : String(normalized[column.key] ?? ''),
          { width: columnWidths[index] - cellPadding * 2 }
        )
      );
      const rowHeight = Math.max(22, Math.max(...cellHeights) + cellPadding * 2);
      ensureSpace(rowHeight + (rowIndex === 0 ? 8 : 0));
      const top = doc.y;
      let left = margin;

      columns.forEach((column, index) => {
        doc
          .save()
          .rect(left, top, columnWidths[index], rowHeight)
          .fillAndStroke(isHeader ? COLORS.ink : rowIndex % 2 === 0 ? COLORS.panel : COLORS.white, COLORS.line)
          .restore();

        doc
          .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(isHeader ? 9 : 10)
          .fillColor(isHeader ? COLORS.white : COLORS.text)
          .text(isHeader ? column.label : String(normalized[column.key] ?? ''), left + cellPadding, top + cellPadding - 1, {
            width: columnWidths[index] - cellPadding * 2
          });

        left += columnWidths[index];
      });

      doc.y = top + rowHeight;
    }

    drawRow({}, 0, true);

    rows.forEach((row, index) => drawRow(row, index + 1, false));
    doc.moveDown(0.6);
    doc.y = Math.max(doc.y, tableTop + 12);
  }

  function drawImageGallery(items = []) {
    const galleryItems = items.length > 0 ? items : [{ title: 'No image assets', caption: 'No property images found.', image: null }];
    const gap = 12;
    const imageWidth = (contentWidth - gap) / 2;
    const imageHeight = 140;
    let index = 0;

    while (index < galleryItems.length) {
      const rowItems = galleryItems.slice(index, index + 2);
      ensureSpace(imageHeight + 48);
      const top = doc.y;

      rowItems.forEach((item, column) => {
        const left = margin + column * (imageWidth + gap);
        doc
          .save()
          .roundedRect(left, top, imageWidth, imageHeight, 8)
          .fillAndStroke(COLORS.panel, COLORS.line)
          .restore();

        if (item.image) {
          try {
            doc.image(item.image, left + 8, top + 8, {
              fit: [imageWidth - 16, imageHeight - 16],
              align: 'center',
              valign: 'center'
            });
          } catch (_error) {
            doc
              .font('Helvetica')
              .fontSize(10)
              .fillColor(COLORS.muted)
              .text('Image preview unavailable', left + 16, top + 58, {
                width: imageWidth - 32,
                align: 'center'
              });
          }
        } else {
          doc
            .font('Helvetica')
            .fontSize(10)
            .fillColor(COLORS.muted)
            .text('Image pending', left + 16, top + 58, {
              width: imageWidth - 32,
              align: 'center'
            });
        }

        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(COLORS.ink)
          .text(item.title || '', left, top + imageHeight + 8, {
            width: imageWidth
          });

        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(COLORS.muted)
          .text(item.caption || '', left, top + imageHeight + 22, {
            width: imageWidth
          });
      });

      doc.y = top + imageHeight + 42;
      index += 2;
    }
  }

  function drawHeroImage(heroImage) {
    ensureSpace(196);
    const top = doc.y;
    const boxHeight = 176;

    doc
      .save()
      .roundedRect(margin, top, contentWidth, boxHeight, 10)
      .fillAndStroke(COLORS.panel, COLORS.line)
      .restore();

    if (heroImage?.image) {
      try {
        doc.image(heroImage.image, margin + 12, top + 12, {
          fit: [contentWidth - 24, boxHeight - 24],
          align: 'center',
          valign: 'center'
        });
      } catch (_error) {
        doc
          .font('Helvetica')
          .fontSize(12)
          .fillColor(COLORS.muted)
          .text('Property photo unavailable', margin, top + 78, {
            width: contentWidth,
            align: 'center'
          });
      }
    } else {
      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(COLORS.muted)
        .text('Property photo pending', margin, top + 78, {
          width: contentWidth,
          align: 'center'
        });
    }

    doc.y = top + boxHeight + 12;
  }

  function drawSection(section) {
    if (section.pageBreakBefore) {
      startNewPage();
    }

    drawSectionTitle(section);

    if (section.type === 'facts') {
      drawFacts(section.items || []);
      return;
    }

    if (section.type === 'cards') {
      drawCards(section.items || []);
      return;
    }

    if (section.type === 'bullets') {
      drawBullets(section.items || []);
      return;
    }

    if (section.type === 'table') {
      drawTable(section.columns || [], section.rows || []);
      return;
    }

    if (section.type === 'imageGallery') {
      drawImageGallery(section.items || []);
      return;
    }

    drawBullets(Array.isArray(section.items) ? section.items : []);
  }

  return {
    drawDocumentHeader,
    drawHeroImage,
    drawMetrics,
    drawSection,
    margin,
    contentWidth,
    startNewPage
  };
}

function addPageNumbers(doc, definition) {
  const range = doc.bufferedPageRange();

  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        `${definition.title} | Page ${index + 1} of ${range.count}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom + 8,
        {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center'
        }
      );
  }
}

async function renderDefinitionToBuffer(definition) {
  const doc = createPdfDocument();

  return collectPdfBuffer(doc, async () => {
    const renderer = createRenderer(doc, definition);
    renderer.drawDocumentHeader();

    if (definition.heroImage) {
      renderer.drawHeroImage(definition.heroImage);
    }

    renderer.drawMetrics(definition.metrics || []);

    for (const section of definition.sections || []) {
      renderer.drawSection(section);
    }

    if (definition.footerNote) {
      doc.moveDown(0.5);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(definition.footerNote, renderer.margin, doc.y, {
          width: renderer.contentWidth
        });
    }

    addPageNumbers(doc, definition);
  });
}

async function buildImageBuffer(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return fs.promises.readFile(filePath);
  } catch (_error) {
    return null;
  }
}

function normalizePropertyRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    sq_feet: safeNumber(row.sq_feet),
    lot_size: safeNumber(row.lot_size),
    assessed_value: safeNumber(row.assessed_value),
    units: safeNumber(row.units),
    default_amount: safeNumber(row.default_amount),
    loan_amount: safeNumber(row.loan_amount),
    ltv: safeNumber(row.ltv),
    equity_amount: safeNumber(row.equity_amount),
    equity_percent: safeNumber(row.equity_percent),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  };
}

async function loadEntityCore(queryFn, entityId) {
  const entityResult = await queryFn(
    `
      SELECT id, name, entity_type AS type, source, phone, email, notes, metadata, created_at, updated_at
      FROM entities
      WHERE id = $1
      LIMIT 1
    `,
    [entityId]
  );

  return entityResult.rows[0] || null;
}

async function loadEntityRelationships(queryFn, entityId) {
  const result = await queryFn(
    `
      SELECT
        er.relationship_type,
        related.id AS related_entity_id,
        related.name,
        related.entity_type AS type
      FROM entity_relationships er
      JOIN entities related
        ON related.id = CASE
          WHEN er.parent_entity_id = $1 THEN er.child_entity_id
          ELSE er.parent_entity_id
        END
      WHERE er.parent_entity_id = $1
         OR er.child_entity_id = $1
      ORDER BY related.entity_type ASC, related.name ASC
    `,
    [entityId]
  );

  return result.rows;
}

async function loadRecentKnowledgeForEntity(queryFn, entityId) {
  const result = await queryFn(
    `
      SELECT DISTINCT ON (ke.id)
        ke.id,
        ke.title,
        ke.content,
        COALESCE(ke.ai_summary, ke.summary) AS summary,
        ke.ai_action_items,
        ke.occurred_at,
        ke.created_at
      FROM knowledge_entries ke
      LEFT JOIN knowledge_entities links ON links.knowledge_entry_id = ke.id
      WHERE ke.entity_id = $1
         OR links.entity_id = $1
      ORDER BY ke.id, ke.created_at DESC
      LIMIT 6
    `,
    [entityId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    action_items: row.ai_action_items || [],
    occurred_at: row.occurred_at,
    created_at: row.created_at
  }));
}

async function loadActiveOpportunitiesForEntity(queryFn, entityId) {
  const dealsResult = await queryFn(
    `
      SELECT
        'deal' AS kind,
        d.id,
        d.status,
        d.notes AS summary,
        p.address AS property_address,
        p.apn AS property_apn,
        CASE
          WHEN d.buyer_entity_id = $1 THEN seller.name
          ELSE buyer.name
        END AS counterparty_name,
        d.close_date
      FROM deals d
      JOIN properties p ON p.id = d.property_id
      LEFT JOIN entities buyer ON buyer.id = d.buyer_entity_id
      LEFT JOIN entities seller ON seller.id = d.seller_entity_id
      WHERE (d.buyer_entity_id = $1 OR d.seller_entity_id = $1)
        AND d.status <> 'closed'
      ORDER BY d.updated_at DESC
      LIMIT 3
    `,
    [entityId]
  );
  const matchesResult = await queryFn(
    `
      SELECT
        'match' AS kind,
        m.id,
        m.status,
        m.score,
        m.reasoning,
        p.address AS property_address,
        p.apn AS property_apn,
        CASE
          WHEN buyer_entity.id = $1 THEN seller_entity.name
          ELSE buyer_entity.name
        END AS counterparty_name
      FROM matches m
      JOIN buyer_profiles bp ON bp.id = m.buyer_profile_id
      JOIN entities buyer_entity ON buyer_entity.id = bp.entity_id
      JOIN seller_profiles sp ON sp.id = m.seller_profile_id
      LEFT JOIN entities seller_entity ON seller_entity.id = sp.entity_id
      JOIN properties p ON p.id = m.property_id
      WHERE (buyer_entity.id = $1 OR seller_entity.id = $1)
        AND m.status NOT IN ('closed', 'archived', 'passed', 'rejected')
      ORDER BY m.score DESC, m.updated_at DESC
      LIMIT 3
    `,
    [entityId]
  );

  return [...dealsResult.rows, ...matchesResult.rows];
}

async function loadBuyerProfileByEntity(queryFn, entityId) {
  const result = await queryFn(
    `
      SELECT
        bp.*,
        e.name AS entity_name
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.entity_id = $1
      LIMIT 1
    `,
    [entityId]
  );

  return result.rows[0] || null;
}

async function loadSellerProfilesByEntity(queryFn, entityId) {
  const result = await queryFn(
    `
      SELECT
        sp.*,
        p.address AS property_address,
        p.apn AS property_apn
      FROM seller_profiles sp
      JOIN properties p ON p.id = sp.property_id
      WHERE sp.entity_id = $1
      ORDER BY sp.updated_at DESC
      LIMIT 3
    `,
    [entityId]
  );

  return result.rows;
}

async function loadMeetingBriefData({ queryFn, entityId }) {
  const entity = await loadEntityCore(queryFn, entityId);

  if (!entity) {
    throw createNotFoundError('Entity not found');
  }

  const [relationships, portfolio, recentConversations, activeOpportunities, buyerProfile, sellerProfiles] = await Promise.all([
    loadEntityRelationships(queryFn, entityId),
    getPortfolio(entityId),
    loadRecentKnowledgeForEntity(queryFn, entityId),
    loadActiveOpportunitiesForEntity(queryFn, entityId),
    loadBuyerProfileByEntity(queryFn, entityId),
    loadSellerProfilesByEntity(queryFn, entityId)
  ]);

  const companies = relationships.filter((row) => row.type !== 'person');
  const talkingPoints = uniqueStrings([
    ...recentConversations.flatMap((entry) => Array.isArray(entry.action_items) ? entry.action_items : []),
    buyerProfile?.sensibilities,
    ...sellerProfiles.flatMap((profile) => profile.approach_suggestions || []),
    ...activeOpportunities.map((item) => item.reasoning || item.summary)
  ]);

  return {
    entity,
    companies,
    portfolio,
    recentConversations,
    activeOpportunities,
    buyerProfile,
    sellerProfiles,
    talkingPoints
  };
}

async function loadPropertyCore(queryFn, propertyId) {
  const result = await queryFn(
    `
      SELECT
        p.*,
        owner.name AS owner_entity_name,
        trustee.name AS trustee_entity_name,
        lender.name AS lender_entity_name
      FROM properties p
      LEFT JOIN entities owner ON owner.id = p.owner_entity_id
      LEFT JOIN entities trustee ON trustee.id = p.trustee_entity_id
      LEFT JOIN entities lender ON lender.id = p.lender_entity_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [propertyId]
  );

  return normalizePropertyRow(result.rows[0] || null);
}

async function loadPropertyDocuments(queryFn, propertyId) {
  const result = await queryFn(
    `
      SELECT *
      FROM property_documents
      WHERE property_id = $1
      ORDER BY created_at DESC
      LIMIT 12
    `,
    [propertyId]
  );

  return result.rows;
}

async function loadPropertyKnowledge(queryFn, propertyId) {
  const result = await queryFn(
    `
      SELECT
        ke.id,
        ke.title,
        ke.content,
        COALESCE(ke.ai_summary, ke.summary) AS summary,
        ke.created_at
      FROM knowledge_properties kp
      JOIN knowledge_entries ke ON ke.id = kp.knowledge_entry_id
      WHERE kp.property_id = $1
      ORDER BY ke.created_at DESC
      LIMIT 5
    `,
    [propertyId]
  );

  return result.rows;
}

async function loadComparableProperties(queryFn, property) {
  if (!property) {
    return [];
  }

  const result = await queryFn(
    `
      SELECT
        id,
        apn,
        address,
        city,
        property_type,
        assessed_value,
        sq_feet,
        lot_size,
        units,
        foreclosure
      FROM properties
      WHERE id <> $1
        AND property_type = $2
        AND ($3::text IS NULL OR city = $3)
      ORDER BY ABS(COALESCE(assessed_value, 0) - COALESCE($4, 0)) ASC, updated_at DESC
      LIMIT 5
    `,
    [property.id, property.property_type, property.city || null, property.assessed_value || 0]
  );

  return result.rows.map(normalizePropertyRow);
}

async function loadSalesComps(queryFn, property) {
  const result = await queryFn(
    `
      SELECT
        bp.purchase_price,
        bp.purchase_date,
        bp.created_at,
        p.id AS property_id,
        p.address,
        p.apn,
        p.city,
        p.state,
        p.zip,
        p.property_type
      FROM buyer_purchases bp
      LEFT JOIN properties p ON p.id = bp.property_id
      WHERE ($1::text IS NULL OR p.property_type = $1)
        AND ($2::text IS NULL OR p.city = $2)
      ORDER BY bp.purchase_date DESC, bp.created_at DESC
      LIMIT 5
    `,
    [property?.property_type || null, property?.city || null]
  );

  return result.rows.map((row) => ({
    ...row,
    property: {
      id: row.property_id,
      address: row.address,
      apn: row.apn,
      city: row.city,
      state: row.state,
      zip: row.zip,
      property_type: row.property_type
    }
  }));
}

async function loadRentSignals(queryFn, property) {
  const result = await queryFn(
    `
      SELECT
        e.name AS entity_name,
        bp.max_price,
        bp.investment_strategy,
        bp.sensibilities,
        bp.notes
      FROM buyer_profiles bp
      JOIN entities e ON e.id = bp.entity_id
      WHERE bp.active = TRUE
        AND ($1::text IS NULL OR $1 = ANY(bp.target_cities))
        AND ($2::text IS NULL OR $2 = ANY(bp.preferred_property_types))
      ORDER BY bp.max_price DESC NULLS LAST, e.name ASC
      LIMIT 5
    `,
    [property?.city || null, property?.property_type || null]
  );

  return result.rows;
}

async function loadMarketSnapshot(queryFn, property) {
  const result = await queryFn(
    `
      SELECT
        COUNT(*)::int AS same_type_inventory,
        COUNT(*) FILTER (WHERE foreclosure = TRUE)::int AS nearby_foreclosures,
        AVG(assessed_value) AS average_assessed_value
      FROM properties
      WHERE ($1::text IS NULL OR city = $1)
        AND ($2::text IS NULL OR property_type = $2)
    `,
    [property?.city || null, property?.property_type || null]
  );

  const row = result.rows[0] || {};

  return {
    sameTypeInventory: Number(row.same_type_inventory || 0),
    nearbyForeclosures: Number(row.nearby_foreclosures || 0),
    averageAssessedValue: safeNumber(row.average_assessed_value, null)
  };
}

async function loadPropertyImages(documents = []) {
  const images = [];

  for (const document of documents) {
    if (!String(document.mime_type || '').startsWith('image/')) {
      continue;
    }

    const buffer = await buildImageBuffer(document.storage_path);

    if (!buffer) {
      continue;
    }

    images.push({
      buffer,
      label: document.file_name,
      caption: document.notes || document.document_type || 'Property image'
    });
  }

  return images;
}

function buildMarketingPlan({ property, sellerProfile, comparableProperties, salesComps, knowledgeHighlights }) {
  return uniqueStrings([
    property?.foreclosure ? 'Lead the story with urgency and a clear execution path for distressed inventory.' : null,
    sellerProfile?.approach_suggestions?.[0] || null,
    comparableProperties.length > 0 ? `Anchor buyer conversations with ${comparableProperties.length} nearby comparable properties already in the brain.` : null,
    salesComps.length > 0 ? `Use the ${salesComps.length} recorded purchase comps to support price framing.` : null,
    knowledgeHighlights[0]?.summary ? `Open with recent context: ${knowledgeHighlights[0].summary}` : null
  ]);
}

async function loadProposalData({ queryFn, propertyId }) {
  const property = await loadPropertyCore(queryFn, propertyId);

  if (!property) {
    throw createNotFoundError('Property not found');
  }

  const [sellerProfile, documents, knowledgeHighlights, comparableProperties, salesComps, rentSignals, marketSnapshot] = await Promise.all([
    getSellerProfileByProperty(propertyId),
    loadPropertyDocuments(queryFn, propertyId),
    loadPropertyKnowledge(queryFn, propertyId),
    loadComparableProperties(queryFn, property),
    loadSalesComps(queryFn, property),
    loadRentSignals(queryFn, property),
    loadMarketSnapshot(queryFn, property)
  ]);
  const images = await loadPropertyImages(documents);

  return {
    property,
    sellerProfile,
    documents,
    images,
    comparableProperties,
    salesComps,
    rentSignals,
    marketSnapshot,
    knowledgeHighlights,
    marketingPlan: buildMarketingPlan({
      property,
      sellerProfile,
      comparableProperties,
      salesComps,
      knowledgeHighlights
    })
  };
}

async function loadFlyerData({ queryFn, propertyId }) {
  const property = await loadPropertyCore(queryFn, propertyId);

  if (!property) {
    throw createNotFoundError('Property not found');
  }

  const [sellerProfile, documents, topMatch] = await Promise.all([
    getSellerProfileByProperty(propertyId),
    loadPropertyDocuments(queryFn, propertyId),
    queryFn(
      `
        SELECT
          m.score,
          m.reasoning,
          buyer_entity.name AS buyer_name
        FROM matches m
        JOIN buyer_profiles bp ON bp.id = m.buyer_profile_id
        JOIN entities buyer_entity ON buyer_entity.id = bp.entity_id
        WHERE m.property_id = $1
        ORDER BY m.score DESC, m.updated_at DESC
        LIMIT 1
      `,
      [propertyId]
    )
  ]);
  const images = await loadPropertyImages(documents);

  return {
    property,
    sellerProfile,
    heroImage: images[0]
      ? {
          image: images[0].buffer,
          caption: images[0].caption
        }
      : null,
    matchHeadline: topMatch.rows[0]?.buyer_name
      ? `Top current fit: ${topMatch.rows[0].buyer_name} scored ${Math.round(Number(topMatch.rows[0].score || 0))}.`
      : cleanText(topMatch.rows[0]?.reasoning, null),
    contact: {
      name: process.env.ISG_BROKER_NAME || 'ISG Brokerage',
      email: process.env.ISG_BROKER_EMAIL || 'broker@lee-associates.com',
      phone: process.env.ISG_BROKER_PHONE || 'Available on request'
    }
  };
}

async function loadDailyBriefData({ queryFn }) {
  const [actionItemsResult, distressedSellerResult, matchesResult] = await Promise.all([
    queryFn(
      `
        SELECT id, ai_summary, ai_action_items, created_at
        FROM knowledge_entries
        WHERE jsonb_array_length(ai_action_items) > 0
        ORDER BY created_at DESC
        LIMIT 6
      `
    ),
    queryFn(
      `
        SELECT sp.id, e.name AS entity_name, p.address, sp.distress_level
        FROM seller_profiles sp
        JOIN entities e ON e.id = sp.entity_id
        JOIN properties p ON p.id = sp.property_id
        WHERE sp.active = TRUE
        ORDER BY sp.distress_level DESC NULLS LAST, p.assessed_value DESC NULLS LAST
        LIMIT 4
      `
    ),
    queryFn(
      `
        SELECT
          m.id,
          m.status,
          m.score,
          m.reasoning,
          p.address AS property_address,
          buyer_entity.name AS buyer_name,
          seller_entity.name AS seller_name
        FROM matches m
        JOIN buyer_profiles bp ON bp.id = m.buyer_profile_id
        JOIN entities buyer_entity ON buyer_entity.id = bp.entity_id
        JOIN seller_profiles sp ON sp.id = m.seller_profile_id
        LEFT JOIN entities seller_entity ON seller_entity.id = sp.entity_id
        JOIN properties p ON p.id = m.property_id
        WHERE m.status NOT IN ('closed', 'archived', 'passed', 'rejected')
        ORDER BY m.score DESC, m.updated_at DESC
        LIMIT 4
      `
    )
  ]);

  return {
    actionItems: actionItemsResult.rows.flatMap((row) =>
      (row.ai_action_items || []).map((action) => ({
        knowledge_entry_id: row.id,
        summary: row.ai_summary,
        action,
        created_at: row.created_at
      }))
    ),
    distressedSellers: distressedSellerResult.rows,
    topMatches: matchesResult.rows
  };
}

function buildDriveFolder(kind, data) {
  if (kind === 'meetingBrief') {
    return 'ISG-Brain/Briefs';
  }

  if (kind === 'dailyBrief') {
    return 'ISG-Brain/Briefs/Daily';
  }

  const property = data.property || {};
  const propertyFolder = `${slugifySegment(property.apn || 'property')}_${slugifySegment(property.address || property.id || 'record')}`;

  if (kind === 'proposal') {
    return `ISG-Brain/Properties/${propertyFolder}/Proposals`;
  }

  if (kind === 'propertyFlyer') {
    return `ISG-Brain/Properties/${propertyFolder}/Marketing`;
  }

  return 'ISG-Brain/Generated';
}

function buildOutputFilePath(root, driveFolder, fileName) {
  return path.join(root, driveFolder.replace(/^ISG-Brain\//, '').replace(/\//g, path.sep), fileName);
}

function buildTemplate(kind, data, context) {
  if (kind === 'meetingBrief') {
    return buildMeetingBriefTemplate(data, context);
  }

  if (kind === 'proposal') {
    return buildProposalTemplate(data, context);
  }

  if (kind === 'propertyFlyer') {
    return buildPropertyFlyerTemplate(data, context);
  }

  return buildDailyBriefTemplate(data, context);
}

function createPdfGenerator(options = {}) {
  const queryFn = options.queryFn || query;
  const now = options.now || defaultNow;
  const driveClient = resolveDriveClient(options.driveClient);
  const outputRoot = ensureOutputRoot(options.outputRoot);

  async function generateDocument(kind, identifier = null) {
    const generatedAt = now();
    let data;

    if (kind === 'meetingBrief') {
      data = await (options.loadMeetingBriefData || loadMeetingBriefData)({
        queryFn,
        entityId: identifier
      });
    } else if (kind === 'proposal') {
      data = await (options.loadProposalData || loadProposalData)({
        queryFn,
        propertyId: identifier
      });
    } else if (kind === 'propertyFlyer') {
      data = await (options.loadFlyerData || loadFlyerData)({
        queryFn,
        propertyId: identifier
      });
    } else {
      data = await (options.loadDailyBriefData || loadDailyBriefData)({
        queryFn
      });
    }

    const definition = buildTemplate(kind, data, { generatedAt });
    const driveFolder = buildDriveFolder(kind, data);
    const fileName = definition.fileName;
    const filePath = buildOutputFilePath(outputRoot, driveFolder, fileName);

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const pdfBuffer = await renderDefinitionToBuffer(definition);
    await fs.promises.writeFile(filePath, pdfBuffer);
    const upload = await savePdfToDrive({
      driveClient,
      filePath,
      driveFolder,
      fileName
    });

    return {
      kind,
      title: definition.title,
      file_name: fileName,
      file_path: filePath,
      size_bytes: pdfBuffer.length,
      drive_folder: driveFolder,
      upload,
      preview: {
        generated_at: generatedAt,
        subtitle: definition.subtitle
      }
    };
  }

  return {
    generateMeetingBrief(entityId) {
      return generateDocument('meetingBrief', entityId);
    },
    generateProposal(propertyId) {
      return generateDocument('proposal', propertyId);
    },
    generatePropertyFlyer(propertyId) {
      return generateDocument('propertyFlyer', propertyId);
    },
    generateDailyBrief() {
      return generateDocument('dailyBrief');
    }
  };
}

const defaultGenerator = createPdfGenerator();

module.exports = {
  createPdfGenerator,
  renderDefinitionToBuffer,
  savePdfToDrive,
  generateMeetingBrief: defaultGenerator.generateMeetingBrief,
  generateProposal: defaultGenerator.generateProposal,
  generatePropertyFlyer: defaultGenerator.generatePropertyFlyer,
  generateDailyBrief: defaultGenerator.generateDailyBrief
};
