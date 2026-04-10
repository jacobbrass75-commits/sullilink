const path = require('path');
const dotenv = require('dotenv');
const { query } = require('../db/connection');
const { createKnowledgeEntry, getKnowledgeEntry } = require('../knowledge/extract');
const { getGoogleClient } = require('./google-auth');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose'
];
const INBOUND_LEAD_QUERY =
  'is:unread in:inbox ("looking for" OR "interested in" OR "want to buy")';

const defaultDependencies = {
  fetch: global.fetch,
  query,
  createKnowledgeEntry,
  getKnowledgeEntry,
  getGmailClient: () => getGoogleClient('gmail', 'v1', GMAIL_SCOPES)
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function shouldAutoSend() {
  return cleanText(process.env.GMAIL_AUTO_SEND, 'false') === 'true';
}

function toBase64Url(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));

  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHeader(headers = [], name) {
  const matched = headers.find((header) => String(header.name || '').toLowerCase() === name.toLowerCase());
  return cleanText(matched?.value, null);
}

function collectPayloadBodies(payload, bodies = { text: [], html: [] }) {
  if (!payload || typeof payload !== 'object') {
    return bodies;
  }

  const mimeType = String(payload.mimeType || '').toLowerCase();
  const data = cleanText(payload.body?.data, null);

  if (data) {
    if (mimeType === 'text/plain') {
      bodies.text.push(decodeBase64Url(data));
    } else if (mimeType === 'text/html') {
      bodies.html.push(decodeBase64Url(data));
    } else if (!payload.parts || payload.parts.length === 0) {
      bodies.text.push(decodeBase64Url(data));
    }
  }

  for (const part of payload.parts || []) {
    collectPayloadBodies(part, bodies);
  }

  return bodies;
}

function parseGmailMessage(message = {}) {
  const payload = message.payload || {};
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const bodies = collectPayloadBodies(payload);
  const plainBody = bodies.text.map((value) => cleanText(value, null)).filter(Boolean).join('\n\n');
  const htmlBody = bodies.html.map((value) => cleanText(value, null)).filter(Boolean).join('\n\n');
  const body = plainBody || stripHtml(htmlBody) || cleanText(message.snippet, '');
  const internalDate = Number(message.internalDate || 0);

  return {
    id: message.id || null,
    thread_id: message.threadId || null,
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date') || (internalDate > 0 ? new Date(internalDate).toISOString() : null),
    body,
    snippet: cleanText(message.snippet, null),
    label_ids: Array.isArray(message.labelIds) ? message.labelIds : []
  };
}

function buildRawMessage({ to, subject, body, fromAlias }) {
  const recipient = cleanText(to, null);
  const messageSubject = cleanText(subject, '(no subject)');

  if (!recipient) {
    throw new Error('to is required');
  }

  const lines = [
    `To: ${recipient}`,
    fromAlias ? `From: ${fromAlias}` : null,
    `Subject: ${messageSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    String(body || '')
  ].filter(Boolean);

  return toBase64Url(lines.join('\r\n'));
}

function buildSearchQuery(queryString, daysBack) {
  const terms = [cleanText(queryString, null)].filter(Boolean);
  const parsedDays = Number(daysBack);

  if (
    Number.isFinite(parsedDays) &&
    parsedDays > 0 &&
    !terms.some((term) => /\b(?:newer_than|older_than|after|before):/i.test(term))
  ) {
    terms.push(`newer_than:${parsedDays}d`);
  }

  if (!terms.some((term) => /\bin:(?:inbox|anywhere|sent|drafts)\b/i.test(term))) {
    terms.push('in:inbox');
  }

  return terms.join(' ');
}

async function createDraftMessage(rawMessage) {
  const gmail = await dependencies.getGmailClient();
  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: rawMessage
      }
    }
  });

  return {
    draft_id: response.data?.id || null,
    message_id: response.data?.message?.id || null
  };
}

async function draftEmail(to, subject, body) {
  const raw = buildRawMessage({ to, subject, body });
  const draft = await createDraftMessage(raw);
  return draft.draft_id;
}

async function sendEmail(to, subject, body, fromAlias) {
  const raw = buildRawMessage({ to, subject, body, fromAlias });

  if (!shouldAutoSend()) {
    const draft = await createDraftMessage(raw);
    return {
      delivery: 'draft',
      message_id: draft.message_id,
      draft_id: draft.draft_id
    };
  }

  const gmail = await dependencies.getGmailClient();
  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw
    }
  });

  return {
    delivery: 'sent',
    message_id: response.data?.id || null,
    draft_id: null
  };
}

async function fetchMessageDetails(gmail, messageId) {
  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  return parseGmailMessage(response.data);
}

async function searchInbox(queryString, daysBack = 7) {
  const gmail = await dependencies.getGmailClient();
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: buildSearchQuery(queryString, daysBack),
    maxResults: 25
  });
  const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];

  return Promise.all(messages.map((message) => fetchMessageDetails(gmail, message.id)));
}

function getIngestBaseUrl() {
  return cleanText(process.env.INTERNAL_API_BASE_URL, `http://127.0.0.1:${process.env.API_PORT || 3100}`);
}

async function processInboundLeads() {
  const gmail = await dependencies.getGmailClient();
  const messages = await searchInbox(INBOUND_LEAD_QUERY, 14);
  const results = [];

  for (const message of messages) {
    const payload = {
      message: [
        message.from ? `From: ${message.from}` : null,
        message.subject ? `Subject: ${message.subject}` : null,
        message.date ? `Date: ${message.date}` : null,
        '',
        message.body || message.snippet || ''
      ]
        .filter((value) => value !== null)
        .join('\n'),
      source: 'email'
    };
    const response = await dependencies.fetch(`${getIngestBaseUrl()}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`Inbound email ingest failed for ${message.id}: HTTP ${response.status}`);
    }

    const body = await response.json();

    await gmail.users.messages.modify({
      userId: 'me',
      id: message.id,
      requestBody: {
        removeLabelIds: ['UNREAD']
      }
    });

    results.push({
      message_id: message.id,
      thread_id: message.thread_id,
      summary: body.summary || null,
      knowledge_entry_id: body.knowledge_entry_id || null
    });
  }

  return results;
}

async function logEmailToKnowledge(messageId, entityId) {
  const id = cleanText(messageId, null);

  if (!id) {
    throw new Error('messageId is required');
  }

  const existing = await dependencies.query(
    `
      SELECT id
      FROM knowledge_entries
      WHERE source = 'email'
        AND metadata ->> 'gmail_message_id' = $1
      LIMIT 1
    `,
    [id]
  );

  if (existing.rows[0]) {
    return dependencies.getKnowledgeEntry(existing.rows[0].id);
  }

  const gmail = await dependencies.getGmailClient();
  const message = await fetchMessageDetails(gmail, id);
  const entry = await dependencies.createKnowledgeEntry({
    entry_type: 'email',
    title: message.subject || `Email from ${message.from || 'unknown sender'}`,
    content: message.body || message.snippet || '',
    summary: message.subject || message.snippet || 'Logged email message',
    source: 'email',
    entity_id: entityId || null,
    occurred_at: message.date ? new Date(message.date).toISOString() : null,
    metadata: {
      gmail_message_id: message.id,
      gmail_thread_id: message.thread_id,
      from: message.from,
      to: message.to
    }
  });

  return entry;
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
  sendEmail,
  draftEmail,
  searchInbox,
  processInboundLeads,
  logEmailToKnowledge,
  parseGmailMessage,
  buildRawMessage,
  shouldAutoSend,
  __setDependencies,
  __resetDependencies
};
