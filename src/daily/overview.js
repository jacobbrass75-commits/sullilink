const { query } = require('../db/connection');

async function getDailyOverview() {
  const actionItemsResult = await query(
    `
      SELECT id, ai_summary, ai_action_items, created_at
      FROM knowledge_entries
      WHERE jsonb_array_length(ai_action_items) > 0
      ORDER BY created_at DESC
      LIMIT 10
    `
  );
  const sellerResult = await query(
    `
      SELECT sp.id, e.name AS entity_name, p.address, sp.distress_level
      FROM seller_profiles sp
      JOIN entities e ON e.id = sp.entity_id
      JOIN properties p ON p.id = sp.property_id
      WHERE sp.active = TRUE
      ORDER BY sp.distress_level DESC NULLS LAST, p.assessed_value DESC NULLS LAST
      LIMIT 5
    `
  );

  return {
    action_items: actionItemsResult.rows.flatMap((row) =>
      (row.ai_action_items || []).map((item) => ({
        knowledge_entry_id: row.id,
        summary: row.ai_summary,
        action: item,
        created_at: row.created_at
      }))
    ),
    distressed_sellers: sellerResult.rows.map((row) => ({
      seller_profile_id: row.id,
      entity_name: row.entity_name,
      address: row.address,
      distress_level: row.distress_level
    }))
  };
}

module.exports = {
  getDailyOverview
};
