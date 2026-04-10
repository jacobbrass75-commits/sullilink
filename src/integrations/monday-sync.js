const path = require('path');
const dotenv = require('dotenv');
const { query } = require('../db/connection');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const DEFAULT_BOARD_IDS = Object.freeze({
  lead_gen: '8052401523',
  pre_marketing: '8052410617',
  calling: '8125516620',
  appointments: '8131802001',
  proposals: '8131892317',
  listings: '8147757682',
  marketing: '8147871308',
  negotiations: '8147982262',
  client_followup: '8148032924'
});

const defaultDependencies = {
  fetch: global.fetch,
  query
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getApiToken() {
  const token = cleanText(process.env.MONDAY_API_TOKEN, null);

  if (!token) {
    throw new Error('MONDAY_API_TOKEN is required for Monday sync');
  }

  return token;
}

function getBoardId(name) {
  const envKey = `MONDAY_${String(name || '').trim().toUpperCase()}_BOARD_ID`;
  return cleanText(process.env[envKey], DEFAULT_BOARD_IDS[name] || null);
}

function getDoneStatuses() {
  const configured = cleanText(process.env.MONDAY_DONE_STATUSES, null);

  if (!configured) {
    return new Set(['done', 'closed', 'complete', 'completed']);
  }

  return new Set(
    configured
      .split(',')
      .map((value) => cleanText(value, null))
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  );
}

async function callMonday(queryText, variables = {}) {
  const response = await dependencies.fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: getApiToken()
    },
    body: JSON.stringify({
      query: queryText,
      variables
    }),
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error_message || `Monday API request failed with status ${response.status}`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message || 'Monday API returned an error');
  }

  return payload?.data || {};
}

function parseDateValue(value) {
  const cleaned = cleanText(value, null);

  if (!cleaned) {
    return null;
  }

  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function buildGroupName(matchRow) {
  return cleanText(matchRow.address, null) || cleanText(matchRow.apn, null) || `Match ${matchRow.id}`;
}

function getTemplateGroupId() {
  return cleanText(process.env.MONDAY_LISTINGS_TEMPLATE_GROUP_ID, null);
}

function normalizeColumnValues(columnValues = []) {
  if (!Array.isArray(columnValues)) {
    return [];
  }

  return columnValues.map((column) => ({
    id: cleanText(column?.id, null),
    title: cleanText(column?.title, null),
    text: cleanText(column?.text, null),
    value: column?.value
  }));
}

function extractStatus(item) {
  for (const column of normalizeColumnValues(item?.column_values)) {
    const key = `${column.id || ''} ${column.title || ''}`.toLowerCase();

    if (key.includes('status')) {
      return cleanText(column.text, null);
    }
  }

  return null;
}

function extractCloseDate(item) {
  for (const column of normalizeColumnValues(item?.column_values)) {
    const key = `${column.id || ''} ${column.title || ''}`.toLowerCase();

    if (!key.includes('date') && !key.includes('close')) {
      continue;
    }

    const parsed = parseDateValue(column.text);

    if (parsed) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const fallback = parseDateValue(item?.updated_at);
  return fallback ? fallback.toISOString().slice(0, 10) : getTodayDate();
}

function normalizeActionItem(row, rawItem) {
  if (typeof rawItem === 'string') {
    return null;
  }

  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }

  const dueAt =
    cleanText(rawItem.due_at, null) ||
    cleanText(rawItem.due_date, null) ||
    cleanText(rawItem.deadline, null);
  const parsedDueAt = parseDateValue(dueAt);

  if (!parsedDueAt || parsedDueAt.getTime() > Date.now()) {
    return null;
  }

  return {
    entity_id:
      cleanText(rawItem.entity_id, null) ||
      cleanText(rawItem.entityId, null) ||
      cleanText(row.entity_id, null),
    title:
      cleanText(rawItem.title, null) ||
      cleanText(rawItem.action, null) ||
      cleanText(rawItem.task, null),
    due_at: parsedDueAt.toISOString(),
    notes: cleanText(rawItem.notes, null),
    summary: cleanText(row.ai_summary, null) || cleanText(row.title, null)
  };
}

async function createGroup(boardId, groupName) {
  const data = await callMonday(
    `
      mutation CreateGroup($boardId: ID!, $groupName: String!) {
        create_group(board_id: $boardId, group_name: $groupName) {
          id
          title
        }
      }
    `,
    {
      boardId,
      groupName
    }
  );

  return data.create_group || null;
}

async function listTemplateItems(boardId) {
  const groupId = getTemplateGroupId();

  if (!groupId) {
    return [];
  }

  const data = await callMonday(
    `
      query TemplateItems($boardId: [ID!], $groupId: [String!]) {
        boards(ids: $boardId) {
          groups(ids: $groupId) {
            items_page(limit: 100) {
              items {
                id
                name
              }
            }
          }
        }
      }
    `,
    {
      boardId: [boardId],
      groupId: [groupId]
    }
  );

  return (
    data.boards?.[0]?.groups?.[0]?.items_page?.items?.filter(
      (item) => cleanText(item?.name, null) !== null
    ) || []
  );
}

async function createItem(boardId, groupId, itemName) {
  const data = await callMonday(
    `
      mutation CreateItem($boardId: ID!, $groupId: String!, $itemName: String!) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName) {
          id
          name
        }
      }
    `,
    {
      boardId,
      groupId,
      itemName
    }
  );

  return data.create_item || null;
}

async function createUpdate(itemId, body) {
  const data = await callMonday(
    `
      mutation CreateUpdate($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
    `,
    {
      itemId,
      body
    }
  );

  return data.create_update || null;
}

async function fetchBoardItems(boardId) {
  const data = await callMonday(
    `
      query BoardItems($boardId: [ID!]) {
        boards(ids: $boardId) {
          items_page(limit: 200) {
            items {
              id
              name
              updated_at
              column_values {
                id
                title
                text
                value
              }
            }
          }
        }
      }
    `,
    {
      boardId: [boardId]
    }
  );

  return data.boards?.[0]?.items_page?.items || [];
}

async function linkBrainToMonday(brainEntityId, mondayItemId, mondayBoardId = null) {
  const entityId = cleanText(brainEntityId, null);
  const itemId = cleanText(String(mondayItemId || ''), null);
  const boardId = cleanText(String(mondayBoardId || process.env.MONDAY_DEFAULT_BOARD_ID || ''), null);

  if (!entityId) {
    throw new Error('brainEntityId is required');
  }

  if (!itemId) {
    throw new Error('mondayItemId is required');
  }

  if (!boardId) {
    throw new Error('mondayBoardId is required');
  }

  await dependencies.query(
    `
      INSERT INTO monday_links (
        entity_id,
        monday_board_id,
        monday_item_id
      )
      VALUES ($1::uuid, $2, $3)
      ON CONFLICT DO NOTHING
    `,
    [entityId, boardId, itemId]
  );

  const result = await dependencies.query(
    `
      SELECT entity_id, monday_board_id, monday_item_id, created_at
      FROM monday_links
      WHERE entity_id = $1::uuid
        AND monday_board_id = $2
        AND monday_item_id = $3
      LIMIT 1
    `,
    [entityId, boardId, itemId]
  );

  return result.rows[0] || null;
}

async function getMatchForMonday(matchId) {
  const result = await dependencies.query(
    `
      SELECT
        m.id,
        m.status,
        m.property_id,
        p.address,
        p.apn,
        d.id AS deal_id
      FROM matches m
      JOIN properties p ON p.id = m.property_id
      LEFT JOIN deals d ON d.match_id = m.id
      WHERE m.id = $1::uuid
      LIMIT 1
    `,
    [matchId]
  );

  return result.rows[0] || null;
}

async function pushMatchToMonday(matchId) {
  const boardId = getBoardId('listings');
  const matchRow = await getMatchForMonday(matchId);

  if (!matchRow) {
    throw new Error('Match not found');
  }

  if (matchRow.status !== 'in_negotiation') {
    return {
      match_id: matchRow.id,
      status: 'skipped',
      reason: 'match_not_in_negotiation'
    };
  }

  const group = await createGroup(boardId, buildGroupName(matchRow));
  const templateItems = await listTemplateItems(boardId);
  const seedItems = templateItems.length > 0 ? templateItems : [{ name: buildGroupName(matchRow) }];
  const createdItems = [];

  for (const templateItem of seedItems) {
    const created = await createItem(boardId, group.id, templateItem.name);

    if (!created?.id) {
      continue;
    }

    await linkBrainToMonday(matchRow.id, created.id, boardId);

    if (matchRow.deal_id) {
      await linkBrainToMonday(matchRow.deal_id, created.id, boardId);
    }

    createdItems.push({
      id: created.id,
      name: created.name || templateItem.name
    });
  }

  return {
    match_id: matchRow.id,
    deal_id: matchRow.deal_id || null,
    group_id: cleanText(group?.id, null),
    group_name: cleanText(group?.title, buildGroupName(matchRow)),
    created_items: createdItems
  };
}

async function getLinkedEntityIdsForItems(boardId, itemIds) {
  if (itemIds.length === 0) {
    return new Map();
  }

  const result = await dependencies.query(
    `
      SELECT entity_id, monday_item_id
      FROM monday_links
      WHERE monday_board_id = $1
        AND monday_item_id = ANY($2::text[])
    `,
    [boardId, itemIds]
  );
  const grouped = new Map();

  for (const row of result.rows) {
    const current = grouped.get(row.monday_item_id) || [];
    current.push(row.entity_id);
    grouped.set(row.monday_item_id, current);
  }

  return grouped;
}

async function pullDealUpdates() {
  const boardIds = [getBoardId('listings'), getBoardId('negotiations'), getBoardId('client_followup')];
  const doneStatuses = getDoneStatuses();
  const updates = [];

  for (const boardId of boardIds) {
    const items = await fetchBoardItems(boardId);
    const itemIds = items.map((item) => cleanText(String(item.id || ''), null)).filter(Boolean);
    const linksByItemId = await getLinkedEntityIdsForItems(boardId, itemIds);

    for (const item of items) {
      const status = cleanText(extractStatus(item), '').toLowerCase();

      if (!doneStatuses.has(status)) {
        continue;
      }

      const linkedEntityIds = linksByItemId.get(String(item.id)) || [];

      if (linkedEntityIds.length === 0) {
        continue;
      }

      const closeDate = extractCloseDate(item);
      const result = await dependencies.query(
        `
          UPDATE deals
          SET
            status = 'closed',
            close_date = COALESCE(close_date, $2::date),
            updated_at = NOW()
          WHERE id = ANY($1::uuid[])
             OR match_id = ANY($1::uuid[])
          RETURNING id
        `,
        [linkedEntityIds, closeDate]
      );

      for (const row of result.rows) {
        updates.push({
          deal_id: row.id,
          board_id: boardId,
          monday_item_id: String(item.id),
          close_date: closeDate
        });
      }
    }
  }

  return {
    updated: updates.length,
    updates
  };
}

async function loadOverdueActions() {
  const result = await dependencies.query(
    `
      SELECT id, title, ai_summary, ai_action_items, entity_id
      FROM knowledge_entries
      WHERE jsonb_array_length(ai_action_items) > 0
      ORDER BY created_at DESC
    `
  );

  return result.rows.flatMap((row) => {
    const rawItems = Array.isArray(row.ai_action_items) ? row.ai_action_items : [];

    return rawItems
      .map((rawItem) => normalizeActionItem(row, rawItem))
      .filter(Boolean);
  });
}

async function pushDailyActions(actions = null) {
  const resolvedActions = Array.isArray(actions) ? actions : await loadOverdueActions();
  const updates = [];

  for (const action of resolvedActions) {
    const entityId = cleanText(action.entity_id || action.entityId, null);

    if (!entityId) {
      continue;
    }

    const links = await dependencies.query(
      `
        SELECT monday_board_id, monday_item_id
        FROM monday_links
        WHERE entity_id = $1::uuid
      `,
      [entityId]
    );

    for (const link of links.rows) {
      const body = [
        `Overdue action: ${cleanText(action.title, 'Action item')}`,
        action.summary ? `Context: ${action.summary}` : null,
        action.due_at ? `Due: ${action.due_at}` : null,
        action.notes ? `Notes: ${action.notes}` : null
      ]
        .filter(Boolean)
        .join('\n');

      await createUpdate(link.monday_item_id, body);
      updates.push({
        entity_id: entityId,
        board_id: link.monday_board_id,
        monday_item_id: link.monday_item_id
      });
    }
  }

  return {
    posted: updates.length,
    updates
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
  pushMatchToMonday,
  pullDealUpdates,
  pushDailyActions,
  linkBrainToMonday,
  __setDependencies,
  __resetDependencies
};
