const { query } = require('../db/connection');
const { getPortfolio } = require('./cluster');
const { findEntityExact, findEntitiesFuzzy } = require('../ingestion/merge');
const { buildContainsPattern } = require('../utils/sql');

async function getEntityDetail(id) {
  const entityResult = await query(
    `
      SELECT id, name, entity_type, source, metadata, created_at, updated_at
      FROM entities
      WHERE id = $1
    `,
    [id]
  );
  const entity = entityResult.rows[0];

  if (!entity) {
    return null;
  }

  const relationshipsResult = await query(
    `
      SELECT
        er.id,
        er.relationship_type,
        er.source,
        er.confidence,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.id
          ELSE parent.id
        END AS related_entity_id,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.name
          ELSE parent.name
        END AS related_entity_name,
        CASE
          WHEN er.parent_entity_id = $1 THEN child.entity_type
          ELSE parent.entity_type
        END AS related_entity_type,
        CASE
          WHEN er.parent_entity_id = $1 THEN 'outbound'
          ELSE 'inbound'
        END AS direction
      FROM entity_relationships er
      JOIN entities parent ON parent.id = er.parent_entity_id
      JOIN entities child ON child.id = er.child_entity_id
      WHERE er.parent_entity_id = $1
         OR er.child_entity_id = $1
      ORDER BY er.created_at ASC
    `,
    [id]
  );
  const propertiesResult = await query(
    `
      SELECT DISTINCT
        p.id,
        p.apn,
        p.address,
        p.city,
        p.state,
        p.assessed_value,
        p.property_type,
        CASE
          WHEN p.owner_entity_id = $1 THEN 'owner'
          WHEN p.trustee_entity_id = $1 THEN 'trustee'
          ELSE 'lender'
        END AS role
      FROM properties p
      WHERE p.owner_entity_id = $1
         OR p.trustee_entity_id = $1
         OR p.lender_entity_id = $1
      ORDER BY p.address NULLS LAST, p.apn
    `,
    [id]
  );

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.entity_type,
      source: entity.source,
      metadata: entity.metadata,
      created_at: entity.created_at,
      updated_at: entity.updated_at
    },
    relationships: relationshipsResult.rows.map((row) => ({
      id: row.id,
      relationship: row.relationship_type,
      source: row.source,
      confidence: row.confidence == null ? null : Number(row.confidence),
      direction: row.direction,
      entity: {
        id: row.related_entity_id,
        name: row.related_entity_name,
        type: row.related_entity_type
      }
    })),
    properties: propertiesResult.rows.map((row) => ({
      id: row.id,
      apn: row.apn,
      address: row.address,
      city: row.city,
      state: row.state,
      assessed_value: row.assessed_value == null ? null : Number(row.assessed_value),
      property_type: row.property_type,
      role: row.role
    }))
  };
}

async function getKnowledgeForEntity(entityId) {
  const result = await query(
    `
      SELECT ke.id, ke.title, ke.ai_summary, ke.created_at
      FROM knowledge_entities links
      JOIN knowledge_entries ke ON ke.id = links.knowledge_entry_id
      WHERE links.entity_id = $1
      ORDER BY ke.created_at DESC
      LIMIT 25
    `,
    [entityId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ai_summary: row.ai_summary,
    created_at: row.created_at
  }));
}

async function getKnowledgeForProperty(propertyId) {
  const result = await query(
    `
      SELECT ke.id, ke.title, ke.ai_summary, ke.created_at
      FROM knowledge_properties links
      JOIN knowledge_entries ke ON ke.id = links.knowledge_entry_id
      WHERE links.property_id = $1
      ORDER BY ke.created_at DESC
      LIMIT 25
    `,
    [propertyId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ai_summary: row.ai_summary,
    created_at: row.created_at
  }));
}

async function lookupEntityOrProperty(name) {
  const exact = await findEntityExact(name);
  const fuzzy = exact ? [] : await findEntitiesFuzzy(name, 0.4);
  const matchedEntity = exact || fuzzy[0] || null;

  if (matchedEntity) {
    const entityDetail = await getEntityDetail(matchedEntity.id);
    const portfolio = await getPortfolio(matchedEntity.id);
    const buyerProfileResult = await query(
      `
        SELECT id
        FROM buyer_profiles
        WHERE entity_id = $1
        LIMIT 1
      `,
      [matchedEntity.id]
    );
    const sellerProfilesResult = await query(
      `
        SELECT id, property_id, distress_level, motivation
        FROM seller_profiles
        WHERE entity_id = $1
        ORDER BY distress_level DESC NULLS LAST, created_at DESC
      `,
      [matchedEntity.id]
    );

    return {
      kind: 'entity',
      match_type: exact ? 'exact' : 'fuzzy',
      entity: entityDetail.entity,
      relationships: entityDetail.relationships,
      properties: entityDetail.properties,
      portfolio,
      buyer_profile_id: buyerProfileResult.rows[0]?.id || null,
      seller_profiles: sellerProfilesResult.rows,
      knowledge_entries: await getKnowledgeForEntity(matchedEntity.id)
    };
  }

  const propertyResult = await query(
    `
      SELECT *,
             similarity(COALESCE(address, ''), $1) AS score
      FROM properties
      WHERE apn = $1
         OR COALESCE(address, '') ILIKE $2 ESCAPE '\\'
         OR similarity(COALESCE(address, ''), $1) >= 0.35
      ORDER BY
        CASE WHEN apn = $1 THEN 1 ELSE 2 END,
        score DESC,
        address ASC
      LIMIT 1
    `,
    [name, buildContainsPattern(name)]
  );
  const property = propertyResult.rows[0];

  if (!property) {
    return null;
  }

  const sellerProfileResult = await query(
    `
      SELECT id, distress_level, motivation, foreclosure_stage
      FROM seller_profiles
      WHERE property_id = $1
      LIMIT 1
    `,
    [property.id]
  );
  const relatedEntitiesResult = await query(
    `
      SELECT id, name, entity_type
      FROM entities
      WHERE id IN ($1, $2, $3)
    `,
    [property.owner_entity_id, property.trustee_entity_id, property.lender_entity_id]
  );

  return {
    kind: 'property',
    property: {
      id: property.id,
      apn: property.apn,
      address: property.address,
      city: property.city,
      property_type: property.property_type,
      assessed_value: property.assessed_value == null ? null : Number(property.assessed_value),
      foreclosure: property.foreclosure
    },
    seller_profile: sellerProfileResult.rows[0] || null,
    linked_entities: relatedEntitiesResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.entity_type
    })),
    knowledge_entries: await getKnowledgeForProperty(property.id)
  };
}

module.exports = {
  getEntityDetail,
  getKnowledgeForEntity,
  getKnowledgeForProperty,
  lookupEntityOrProperty
};
