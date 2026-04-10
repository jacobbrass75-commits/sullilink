const express = require('express');
const { query } = require('../../db/connection');
const { getPortfolio, detectPortfolioDistress } = require('../../entities/cluster');
const { normalizeName } = require('../../entities/extract');
const { getEntityDetail, lookupEntityOrProperty } = require('../../entities/lookup');
const { buildContainsPattern } = require('../../utils/sql');

const router = express.Router();

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

router.get('/api/entities/lookup', async (req, res, next) => {
  try {
    const name = String(req.query.name || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const result = await lookupEntityOrProperty(name);

    if (!result) {
      return res.status(404).json({ error: 'No entity or property found for lookup' });
    }

    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();

    if (q === '') {
      return res.status(400).json({
        error: 'q is required'
      });
    }

    const limit = Math.min(parsePositiveInteger(req.query.limit, 25) || 25, 100);
    const offset = parsePositiveInteger(req.query.offset, 0);
    const normalizedQuery = normalizeName(q);
    const result = await query(
      `
        SELECT
          id,
          name,
          entity_type,
          similarity(normalized_name, $1) AS score
        FROM entities
        WHERE normalized_name % $1
           OR normalized_name LIKE $2 ESCAPE '\\'
        ORDER BY score DESC, name ASC
        LIMIT $3
        OFFSET $4
      `,
      [normalizedQuery, buildContainsPattern(normalizedQuery), limit, offset]
    );

    return res.json({
      results: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.entity_type,
        score: Number(row.score)
      })),
      total: result.rows.length,
      limit,
      offset
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/distressed', async (_req, res, next) => {
  try {
    const results = await detectPortfolioDistress();
    res.json({
      results,
      total: results.length
    });
  } catch (error) {
    next(error);
  }
});

router.get('/api/entities/:id/portfolio', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const portfolio = await getPortfolio(id);

    if (!portfolio) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(portfolio);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isUuid(id)) {
      return res.status(400).json({
        error: 'id must be a valid UUID'
      });
    }

    const entityDetail = await getEntityDetail(id);

    if (!entityDetail) {
      return res.status(404).json({
        error: 'Entity not found'
      });
    }

    return res.json(entityDetail);
  } catch (error) {
    return next(error);
  }
});

router.get('/api/entities', async (req, res, next) => {
  try {
    const limit = Math.min(parsePositiveInteger(req.query.limit, 25) || 25, 100);
    const offset = parsePositiveInteger(req.query.offset, 0);
    const entityType = typeof req.query.type === 'string' && req.query.type.trim() !== ''
      ? req.query.type.trim().toLowerCase()
      : null;
    const countResult = await query(
      `
        SELECT COUNT(*)::int AS count
        FROM entities
        WHERE ($1::text IS NULL OR entity_type = $1)
      `,
      [entityType]
    );
    const rowsResult = await query(
      `
        SELECT id, name, entity_type, source, created_at, updated_at
        FROM entities
        WHERE ($1::text IS NULL OR entity_type = $1)
        ORDER BY name ASC
        LIMIT $2
        OFFSET $3
      `,
      [entityType, limit, offset]
    );

    return res.json({
      results: rowsResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.entity_type,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at
      })),
      total: countResult.rows[0].count,
      limit,
      offset
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/brain/entity/:id', (_req, res) => {
  res.status(501).json({
    status: 'not_implemented',
    module: 'Module 2',
    message: 'This endpoint will be implemented in Module 2: Entity Extraction'
  });
});

module.exports = router;
