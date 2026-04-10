const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');
const { query } = require('../db/connection');
const { getGoogleClient } = require('./google-auth');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar'];
const DEFAULT_APPOINTMENT_MINUTES = 60;
const DEFAULT_REMINDER_MINUTES = 30;

const defaultDependencies = {
  fetch: global.fetch,
  query,
  getCalendarClient: () => getGoogleClient('calendar', 'v3', CALENDAR_SCOPES)
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getCalendarId() {
  return cleanText(process.env.GOOGLE_CALENDAR_ID, 'primary');
}

function getTimeZone() {
  return (
    cleanText(process.env.GOOGLE_CALENDAR_TIME_ZONE, null) ||
    cleanText(process.env.TZ, null) ||
    'America/Los_Angeles'
  );
}

function parseDateValue(value, fieldName) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getTime());
  }

  const text = cleanText(value, null);

  if (!text) {
    throw new Error(`${fieldName} is required`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map((part) => Number(part));
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be a valid date/time`);
  }

  return parsed;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function formatUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function buildIcalLink({ uid, title, description, start, end, location }) {
  const content = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ISG Second Brain//EN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${formatUtcStamp(new Date())}`,
    `DTSTART:${formatUtcStamp(start)}`,
    `DTEND:${formatUtcStamp(end)}`,
    `SUMMARY:${escapeIcsText(title)}`,
    description ? `DESCRIPTION:${escapeIcsText(description)}` : null,
    location ? `LOCATION:${escapeIcsText(location)}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ]
    .filter(Boolean)
    .join('\r\n');

  return `data:text/calendar;charset=utf-8,${encodeURIComponent(content)}`;
}

function normalizeAttendees(attendees = []) {
  if (!Array.isArray(attendees)) {
    return [];
  }

  return attendees
    .map((attendee) => {
      if (typeof attendee === 'string') {
        const email = cleanText(attendee, null);
        return email ? { email } : null;
      }

      if (!attendee || typeof attendee !== 'object') {
        return null;
      }

      const email = cleanText(attendee.email, null);
      return email ? { email, displayName: cleanText(attendee.displayName, undefined) } : null;
    })
    .filter(Boolean);
}

function buildEventRequest({
  title,
  description,
  start,
  end,
  attendees,
  location,
  metadata
}) {
  const startDate = parseDateValue(start, 'start');
  const endDate = end ? parseDateValue(end, 'end') : addMinutes(startDate, DEFAULT_APPOINTMENT_MINUTES);

  if (endDate <= startDate) {
    throw new Error('end must be after start');
  }

  const privateMetadata = Object.fromEntries(
    Object.entries(metadata || {})
      .map(([key, value]) => [key, cleanText(value == null ? null : String(value), null)])
      .filter(([, value]) => value !== null)
  );

  return {
    summary: cleanText(title, 'ISG event'),
    description: cleanText(description, null) || undefined,
    location: cleanText(location, null) || undefined,
    attendees: normalizeAttendees(attendees),
    start: {
      dateTime: startDate.toISOString(),
      timeZone: getTimeZone()
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: getTimeZone()
    },
    extendedProperties:
      Object.keys(privateMetadata).length > 0
        ? {
            private: privateMetadata
          }
        : undefined
  };
}

async function createEvent({ title, description, start, end, attendees = [], location, metadata = {} }) {
  const calendar = await dependencies.getCalendarClient();
  const requestBody = buildEventRequest({
    title,
    description,
    start,
    end,
    attendees,
    location,
    metadata
  });
  const response = await calendar.events.insert({
    calendarId: getCalendarId(),
    requestBody
  });
  const event = response.data || {};
  const startDate = parseDateValue(start, 'start');
  const endDate = end ? parseDateValue(end, 'end') : addMinutes(startDate, DEFAULT_APPOINTMENT_MINUTES);

  return {
    event_id: event.id || null,
    html_link: event.htmlLink || null,
    ical_link: buildIcalLink({
      uid: event.iCalUID || event.id || crypto.randomUUID(),
      title: requestBody.summary,
      description: requestBody.description,
      start: startDate,
      end: endDate,
      location: requestBody.location
    })
  };
}

async function createMondayAppointmentItem({ entityName, date, location, notes }) {
  const token = cleanText(process.env.MONDAY_API_TOKEN, null);

  if (!token) {
    return null;
  }

  const response = await dependencies.fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: token
    },
    body: JSON.stringify({
      query: `
        mutation CreateAppointmentItem($boardId: ID!, $itemName: String!) {
          create_item(board_id: $boardId, item_name: $itemName) {
            id
          }
        }
      `,
      variables: {
        boardId: cleanText(process.env.MONDAY_APPOINTMENTS_BOARD_ID, '8131802001'),
        itemName: `${entityName} appointment`
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Monday appointment sync failed with status ${response.status}`);
  }

  const payload = await response.json();
  const itemId = payload?.data?.create_item?.id || null;

  if (itemId && (location || notes)) {
    await dependencies.fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: token
      },
      body: JSON.stringify({
        query: `
          mutation CreateAppointmentUpdate($itemId: ID!, $body: String!) {
            create_update(item_id: $itemId, body: $body) {
              id
            }
          }
        `,
        variables: {
          itemId,
          body: [
            `Scheduled for: ${parseDateValue(date, 'date').toISOString()}`,
            location ? `Location: ${location}` : null,
            notes ? `Notes: ${notes}` : null
          ]
            .filter(Boolean)
            .join('\n')
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
  }

  return itemId;
}

async function scheduleAppointment(brainEntityId, date, location, notes) {
  const result = await dependencies.query(
    `
      SELECT id, name, email
      FROM entities
      WHERE id = $1
      LIMIT 1
    `,
    [brainEntityId]
  );
  const entity = result.rows[0];

  if (!entity) {
    throw new Error('Entity not found');
  }

  const start = parseDateValue(date, 'date');
  const end = addMinutes(start, Number(process.env.CALENDAR_APPOINTMENT_DURATION_MINUTES || DEFAULT_APPOINTMENT_MINUTES));
  const event = await createEvent({
    title: `Appointment: ${entity.name}`,
    description: cleanText(notes, null) || `ISG appointment with ${entity.name}`,
    start,
    end,
    attendees: entity.email ? [entity.email] : [],
    location,
    metadata: {
      brain_entity_id: entity.id,
      brain_event_type: 'appointment'
    }
  });
  let mondayItemId = null;

  try {
    mondayItemId = await createMondayAppointmentItem({
      entityName: entity.name,
      date: start,
      location,
      notes
    });
  } catch (_error) {
    mondayItemId = null;
  }

  return {
    ...event,
    monday_item_id: mondayItemId
  };
}

async function findEventByPrivateKey(calendar, key, value) {
  const response = await calendar.events.list({
    calendarId: getCalendarId(),
    privateExtendedProperty: [`${key}=${value}`],
    maxResults: 1,
    singleEvents: true
  });

  return response.data?.items?.[0] || null;
}

async function createDeadlineReminder(sellerProfileId, deadlineDate, reason) {
  const result = await dependencies.query(
    `
      SELECT
        sp.id,
        e.name AS seller_name,
        p.address,
        p.apn
      FROM seller_profiles sp
      JOIN entities e ON e.id = sp.entity_id
      JOIN properties p ON p.id = sp.property_id
      WHERE sp.id = $1
      LIMIT 1
    `,
    [sellerProfileId]
  );
  const sellerProfile = result.rows[0];

  if (!sellerProfile) {
    throw new Error('Seller profile not found');
  }

  const deadline = parseDateValue(deadlineDate, 'deadlineDate');
  const reminderStart = new Date(deadline.getTime());
  reminderStart.setDate(reminderStart.getDate() - 3);
  reminderStart.setHours(9, 0, 0, 0);
  const reminderEnd = addMinutes(reminderStart, DEFAULT_REMINDER_MINUTES);
  const propertyLabel = cleanText(sellerProfile.address, sellerProfile.apn || 'property');
  const reminderKey = `${sellerProfileId}:${deadline.toISOString().slice(0, 10)}`;
  const calendar = await dependencies.getCalendarClient();
  const requestBody = buildEventRequest({
    title: `URGENT: ${propertyLabel} foreclosure sale in 3 days`,
    description: [
      `Seller: ${sellerProfile.seller_name}`,
      `Deadline: ${deadline.toISOString().slice(0, 10)}`,
      reason ? `Reason: ${reason}` : null
    ]
      .filter(Boolean)
      .join('\n'),
    start: reminderStart,
    end: reminderEnd,
    metadata: {
      brain_deadline_key: reminderKey,
      brain_seller_profile_id: sellerProfileId,
      brain_event_type: 'deadline_reminder'
    }
  });
  const existing = await findEventByPrivateKey(calendar, 'brain_deadline_key', reminderKey);

  if (existing) {
    const response = await calendar.events.update({
      calendarId: getCalendarId(),
      eventId: existing.id,
      requestBody
    });

    return {
      event_id: response.data?.id || existing.id,
      html_link: response.data?.htmlLink || existing.htmlLink || null,
      ical_link: buildIcalLink({
        uid: response.data?.iCalUID || existing.iCalUID || existing.id,
        title: requestBody.summary,
        description: requestBody.description,
        start: reminderStart,
        end: reminderEnd,
        location: requestBody.location
      })
    };
  }

  return createEvent({
    title: requestBody.summary,
    description: requestBody.description,
    start: reminderStart,
    end: reminderEnd,
    metadata: requestBody.extendedProperties?.private || {}
  });
}

async function getTodaysAgenda() {
  const calendar = await dependencies.getCalendarClient();
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);
  const response = await calendar.events.list({
    calendarId: getCalendarId(),
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    maxResults: 100
  });
  const events = Array.isArray(response.data?.items) ? response.data.items : [];
  const entityIds = [...new Set(events.map((event) => event.extendedProperties?.private?.brain_entity_id).filter(Boolean))];
  let entityNames = new Map();

  if (entityIds.length > 0) {
    const entityResult = await dependencies.query(
      `
        SELECT id, name
        FROM entities
        WHERE id = ANY($1::uuid[])
      `,
      [entityIds]
    );
    entityNames = new Map(entityResult.rows.map((row) => [row.id, row.name]));
  }

  return events.map((event) => {
    const entityId = event.extendedProperties?.private?.brain_entity_id || null;

    return {
      event_id: event.id || null,
      title: event.summary || null,
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      location: event.location || null,
      description: event.description || null,
      entity_id: entityId,
      entity_name: entityId ? entityNames.get(entityId) || null : null
    };
  });
}

function normalizeActionItem(rawItem) {
  if (typeof rawItem === 'string') {
    return {
      title: cleanText(rawItem, null),
      due_at: null,
      location: null,
      notes: null
    };
  }

  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }

  return {
    title:
      cleanText(rawItem.title, null) ||
      cleanText(rawItem.action, null) ||
      cleanText(rawItem.task, null) ||
      cleanText(rawItem.description, null) ||
      cleanText(rawItem.text, null),
    due_at:
      cleanText(rawItem.due_at, null) ||
      cleanText(rawItem.due_date, null) ||
      cleanText(rawItem.dueDate, null) ||
      cleanText(rawItem.deadline, null) ||
      cleanText(rawItem.date, null),
    location: cleanText(rawItem.location, null),
    notes: cleanText(rawItem.notes, null)
  };
}

function buildActionKey(knowledgeEntryId, actionItem) {
  const hash = crypto
    .createHash('sha1')
    .update(`${knowledgeEntryId}:${actionItem.title}:${actionItem.due_at}`)
    .digest('hex');

  return `${knowledgeEntryId}:${hash.slice(0, 12)}`;
}

async function syncBrainTasksToCalendar() {
  const tasksResult = await dependencies.query(
    `
      SELECT id, title, ai_summary, ai_action_items, entity_id, created_at
      FROM knowledge_entries
      WHERE jsonb_array_length(ai_action_items) > 0
      ORDER BY created_at DESC
    `
  );
  const calendar = await dependencies.getCalendarClient();
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    synced: []
  };

  for (const row of tasksResult.rows) {
    const rawItems = Array.isArray(row.ai_action_items) ? row.ai_action_items : [];

    for (const rawItem of rawItems) {
      const actionItem = normalizeActionItem(rawItem);

      if (!actionItem?.title || !actionItem.due_at) {
        summary.skipped += 1;
        continue;
      }

      let start;

      try {
        start = parseDateValue(actionItem.due_at, 'due_at');
      } catch (_error) {
        summary.skipped += 1;
        continue;
      }

      const end = addMinutes(start, DEFAULT_REMINDER_MINUTES);
      const actionKey = buildActionKey(row.id, actionItem);
      const requestBody = buildEventRequest({
        title: actionItem.title,
        description: [row.ai_summary || row.title, actionItem.notes].filter(Boolean).join('\n\n'),
        start,
        end,
        location: actionItem.location,
        metadata: {
          brain_action_key: actionKey,
          brain_knowledge_entry_id: row.id,
          brain_entity_id: row.entity_id
        }
      });
      const existing = await findEventByPrivateKey(calendar, 'brain_action_key', actionKey);

      if (existing) {
        const existingStart = existing.start?.dateTime || existing.start?.date || null;
        const existingEnd = existing.end?.dateTime || existing.end?.date || null;

        if (
          existing.summary === requestBody.summary &&
          existing.description === requestBody.description &&
          existingStart === requestBody.start.dateTime &&
          existingEnd === requestBody.end.dateTime
        ) {
          summary.skipped += 1;
        } else {
          await calendar.events.update({
            calendarId: getCalendarId(),
            eventId: existing.id,
            requestBody
          });
          summary.updated += 1;
          summary.synced.push({
            knowledge_entry_id: row.id,
            event_id: existing.id,
            action_key: actionKey,
            status: 'updated'
          });
        }

        continue;
      }

      const response = await calendar.events.insert({
        calendarId: getCalendarId(),
        requestBody
      });
      summary.created += 1;
      summary.synced.push({
        knowledge_entry_id: row.id,
        event_id: response.data?.id || null,
        action_key: actionKey,
        status: 'created'
      });
    }
  }

  return summary;
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
  createEvent,
  scheduleAppointment,
  createDeadlineReminder,
  getTodaysAgenda,
  syncBrainTasksToCalendar,
  buildEventRequest,
  __setDependencies,
  __resetDependencies
};
