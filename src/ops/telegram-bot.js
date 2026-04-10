const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sendTelegramMessage,
  sendTelegramChatAction,
  listTelegramUpdates,
  getTelegramFile,
  downloadTelegramFile,
  getDefaultTelegramChatId
} = require('../integrations/telegram');
const { handleAssistantMessage } = require('../assistant/chat');
const { processAudioFile } = require('../knowledge/transcribe');

const TELEGRAM_TEXT_LIMIT = 3800;

const defaultDependencies = {
  fetch: global.fetch,
  sendTelegramMessage,
  sendTelegramChatAction,
  listTelegramUpdates,
  getTelegramFile,
  downloadTelegramFile,
  handleAssistantMessage,
  processAudioFile
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function cleanLines(values = []) {
  return values
    .map((value) => cleanText(value, null))
    .filter(Boolean);
}

function getApiBaseUrl() {
  return String(process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`).replace(
    /\/$/,
    ''
  );
}

function getAdminHeaders(headers = {}) {
  if (!process.env.ADMIN_API_KEY) {
    return headers;
  }

  return {
    ...headers,
    'x-api-key': process.env.ADMIN_API_KEY
  };
}

function getAssistantTransport() {
  return cleanText(process.env.TELEGRAM_ASSISTANT_TRANSPORT, 'api');
}

function allowLocalAssistantFallback() {
  return cleanText(process.env.TELEGRAM_ASSISTANT_ALLOW_LOCAL_FALLBACK, 'true') === 'true';
}

function getAssistantAutoExecute() {
  return cleanText(process.env.TELEGRAM_ASSISTANT_AUTO_EXECUTE, 'false') === 'true';
}

function getTelegramBotMode() {
  return cleanText(process.env.TELEGRAM_BOT_MODE, 'polling');
}

function getOffsetFilePath() {
  return path.resolve(process.cwd(), process.env.TELEGRAM_BOT_OFFSET_FILE || 'data/telegram-bot-offset.json');
}

function getAllowedChatIds() {
  const configured = cleanText(process.env.TELEGRAM_ALLOWED_CHAT_IDS, null);

  if (configured) {
    return new Set(
      configured
        .split(',')
        .map((value) => cleanText(value, null))
        .filter(Boolean)
    );
  }

  const defaultChatId = getDefaultTelegramChatId();
  return new Set(defaultChatId ? [defaultChatId] : []);
}

async function loadOffsetState() {
  const filePath = getOffsetFilePath();

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      next_update_id: Number.isInteger(parsed?.next_update_id) ? parsed.next_update_id : null
    };
  } catch (_error) {
    return {
      next_update_id: null
    };
  }
}

async function saveOffsetState(state) {
  const filePath = getOffsetFilePath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(`${filePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.promises.rename(`${filePath}.tmp`, filePath);
}

function splitTelegramMessage(text, maxLength = TELEGRAM_TEXT_LIMIT) {
  const normalized = String(text || '').trim();

  if (normalized.length <= maxLength) {
    return normalized ? [normalized] : [];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const breakIndex = Math.max(candidate.lastIndexOf('\n\n'), candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    const index = breakIndex > Math.floor(maxLength * 0.5) ? breakIndex : maxLength;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

async function sendChunkedTelegramMessage({
  chatId,
  text,
  replyToMessageId = null,
  messageThreadId = null
}) {
  const chunks = splitTelegramMessage(text);

  if (chunks.length === 0) {
    return [];
  }

  const results = [];

  for (let index = 0; index < chunks.length; index += 1) {
    results.push(
      await dependencies.sendTelegramMessage({
        chatId,
        text: chunks[index],
        replyToMessageId: index === 0 ? replyToMessageId : null,
        messageThreadId
      })
    );
  }

  return results;
}

function stripBotMention(commandToken) {
  return String(commandToken || '').replace(/@\w+$/, '');
}

function parseTelegramCommand(text) {
  const normalized = cleanText(text, '');

  if (!normalized.startsWith('/')) {
    return {
      name: null,
      argument: normalized
    };
  }

  const [rawCommand, ...rest] = normalized.split(/\s+/);

  return {
    name: stripBotMention(rawCommand).slice(1).toLowerCase(),
    argument: rest.join(' ').trim()
  };
}

function formatStatusPayload(payload) {
  const lines = cleanLines([
    `Brain health: ${payload.status || 'unknown'}`,
    `Database: ${payload.database || 'unknown'}`,
    `ChromaDB: ${payload.chromadb || 'unknown'}`,
    `Inference: ${payload.inference_provider || 'unknown'}`,
    `Telegram mode: ${getAssistantTransport()}`,
    `Bot mode: ${getTelegramBotMode()}`,
    `Auto execute: ${getAssistantAutoExecute() ? 'on' : 'off'}`
  ]);

  return lines.join('\n');
}

function buildHelpText() {
  return [
    'Soleil is in chat mode.',
    'Talk normally and I will route the message into the brain.',
    '',
    'Useful commands:',
    '/help',
    '/status',
    '',
    'Examples:',
    'What do we know about Mike Chen?',
    'Run matches for 8122 Maie Ave',
    'Draft an email to Mike about Carson options',
    'Schedule a call tomorrow at 2pm with Acme LLC',
    'Sync properties now'
  ].join('\n');
}

async function getBrainHealthPayload() {
  const response = await dependencies.fetch(`${getApiBaseUrl()}/health`, {
    headers: getAdminHeaders(),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));

  if (
    payload &&
    typeof payload === 'object' &&
    ('status' in payload || 'database' in payload || 'chromadb' in payload)
  ) {
    return payload;
  }

  if (!response.ok) {
    throw new Error(`Brain API request failed with status ${response.status}`);
  }

  return payload;
}

async function callAssistantApi(payload) {
  const response = await dependencies.fetch(`${getApiBaseUrl()}/api/assistant/chat`, {
    method: 'POST',
    headers: getAdminHeaders({
      'content-type': 'application/json'
    }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });
  const result = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(result?.error || `Assistant API request failed with status ${response.status}`);
  }

  return result;
}

async function callAssistantLocally(payload) {
  return dependencies.handleAssistantMessage(payload);
}

async function runAssistant(payload) {
  const transport = getAssistantTransport();

  if (transport === 'local') {
    return callAssistantLocally(payload);
  }

  try {
    return await callAssistantApi(payload);
  } catch (error) {
    if (transport === 'api' || !allowLocalAssistantFallback()) {
      throw error;
    }

    return callAssistantLocally(payload);
  }
}

async function ingestAudioViaApi(filePath, source) {
  const absolutePath = path.resolve(filePath);
  const fileBuffer = await fs.promises.readFile(absolutePath);
  const file = new File([fileBuffer], path.basename(absolutePath));
  const form = new FormData();

  form.append('audio', file);
  form.append('source', source || 'telegram_voice');

  const response = await dependencies.fetch(`${getApiBaseUrl()}/api/ingest/audio`, {
    method: 'POST',
    headers: getAdminHeaders(),
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const result = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(result?.error || `Audio ingest failed with status ${response.status}`);
  }

  return result;
}

async function ingestAudio(filePath, source) {
  const transport = getAssistantTransport();

  if (transport === 'local') {
    return dependencies.processAudioFile(filePath, { source });
  }

  try {
    return await ingestAudioViaApi(filePath, source);
  } catch (error) {
    if (transport === 'api' || !allowLocalAssistantFallback()) {
      throw error;
    }

    return dependencies.processAudioFile(filePath, { source });
  }
}

function getAttachmentExtension(message) {
  if (cleanText(message?.voice?.mime_type, '').includes('ogg')) {
    return '.ogg';
  }

  if (cleanText(message?.audio?.file_name, null)) {
    return path.extname(message.audio.file_name) || '.mp3';
  }

  if (cleanText(message?.document?.file_name, null)) {
    return path.extname(message.document.file_name) || '.bin';
  }

  return '.bin';
}

function getAudioAttachment(message) {
  if (message?.voice?.file_id) {
    return {
      file_id: message.voice.file_id,
      kind: 'voice'
    };
  }

  if (message?.audio?.file_id) {
    return {
      file_id: message.audio.file_id,
      kind: 'audio'
    };
  }

  if (
    message?.document?.file_id &&
    (cleanText(message.document.mime_type, '').startsWith('audio/') ||
      /\.(mp3|m4a|wav|ogg|webm)$/i.test(cleanText(message.document.file_name, '')))
  ) {
    return {
      file_id: message.document.file_id,
      kind: 'document_audio'
    };
  }

  return null;
}

async function downloadAudioAttachment(message) {
  const attachment = getAudioAttachment(message);

  if (!attachment) {
    return null;
  }

  const telegramFile = await dependencies.getTelegramFile(attachment.file_id);
  const extension = getAttachmentExtension(message);
  const tempPath = path.join(
    os.tmpdir(),
    `isg-telegram-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`
  );

  await dependencies.downloadTelegramFile(telegramFile.file_path, tempPath);

  return {
    ...attachment,
    file_path: tempPath
  };
}

function formatAudioIngestResult(result) {
  const lines = cleanLines([
    result.summary || 'Saved your voice note to the brain.',
    result.transcription?.text ? `Transcript: ${result.transcription.text}` : null,
    Array.isArray(result.action_items) && result.action_items.length > 0
      ? `Action items: ${result.action_items.slice(0, 3).join('; ')}`
      : null
  ]);

  return lines.join('\n');
}

async function handleTelegramCommand(messageText) {
  const { name } = parseTelegramCommand(messageText);

  switch (name) {
    case 'start':
    case 'help':
      return buildHelpText();
    case 'status':
      return formatStatusPayload(await getBrainHealthPayload());
    default:
      return null;
  }
}

async function processTextMessage(message, context) {
  const text = cleanText(message?.text, null) || cleanText(message?.caption, null);

  if (!text) {
    return {
      processed: false,
      reason: 'ignored_non_text'
    };
  }

  const commandReply = await handleTelegramCommand(text);

  if (commandReply) {
    await sendChunkedTelegramMessage({
      chatId: context.chatId,
      text: commandReply,
      replyToMessageId: context.messageId,
      messageThreadId: context.messageThreadId
    });

    return {
      processed: true,
      mode: 'command'
    };
  }

  await dependencies.sendTelegramChatAction({
    chatId: context.chatId,
    action: 'typing',
    messageThreadId: context.messageThreadId
  }).catch(() => {});

  const result = await runAssistant({
    message: text,
    channel: 'telegram',
    channel_chat_id: context.chatId,
    channel_thread_id: context.messageThreadId ? String(context.messageThreadId) : undefined,
    user_id: context.userId,
    source: 'telegram',
    auto_execute: getAssistantAutoExecute()
  });

  await sendChunkedTelegramMessage({
    chatId: context.chatId,
    text: cleanText(result.reply, 'Done.'),
    replyToMessageId: context.messageId,
    messageThreadId: context.messageThreadId
  });

  return {
    processed: true,
    mode: 'assistant',
    tool_name: result.tool_name,
    requires_confirmation: Boolean(result.requires_confirmation)
  };
}

async function processAudioMessage(message, context) {
  const downloaded = await downloadAudioAttachment(message);

  if (!downloaded) {
    return {
      processed: false,
      reason: 'ignored_non_audio'
    };
  }

  try {
    await dependencies.sendTelegramChatAction({
      chatId: context.chatId,
      action: 'typing',
      messageThreadId: context.messageThreadId
    }).catch(() => {});

    const result = await ingestAudio(downloaded.file_path, 'telegram_voice');

    await sendChunkedTelegramMessage({
      chatId: context.chatId,
      text: formatAudioIngestResult(result),
      replyToMessageId: context.messageId,
      messageThreadId: context.messageThreadId
    });

    return {
      processed: true,
      mode: 'audio',
      knowledge_entry_id: result.knowledge_entry_id || null
    };
  } finally {
    await fs.promises.unlink(downloaded.file_path).catch(() => {});
  }
}

async function processUpdate(update) {
  const message = update?.message || update?.edited_message;
  const chatId = cleanText(message?.chat?.id != null ? String(message.chat.id) : null, null);
  const userId = cleanText(message?.from?.id != null ? String(message.from.id) : null, null);
  const messageId = Number.isInteger(message?.message_id) ? message.message_id : null;
  const messageThreadId = Number.isInteger(message?.message_thread_id) ? message.message_thread_id : null;

  if (!chatId) {
    return {
      processed: false,
      reason: 'ignored_non_message'
    };
  }

  const allowedChatIds = getAllowedChatIds();

  if (allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) {
    await sendChunkedTelegramMessage({
      chatId,
      text: 'This chat is not authorized for Soleil yet.',
      replyToMessageId: messageId,
      messageThreadId
    });
    return {
      processed: false,
      reason: 'unauthorized'
    };
  }

  const context = {
    chatId,
    userId,
    messageId,
    messageThreadId
  };

  if (getAudioAttachment(message)) {
    return processAudioMessage(message, context);
  }

  if (cleanText(message?.text, null) || cleanText(message?.caption, null)) {
    return processTextMessage(message, context);
  }

  await sendChunkedTelegramMessage({
    chatId,
    text: 'I can handle normal chat messages and voice notes here right now.',
    replyToMessageId: messageId,
    messageThreadId
  });

  return {
    processed: false,
    reason: 'unsupported_message_type'
  };
}

async function processTelegramUpdates(options = {}) {
  const state = await loadOffsetState();
  const updates = await dependencies.listTelegramUpdates({
    offset: state.next_update_id,
    limit: options.limit || 10,
    timeoutSeconds: options.timeoutSeconds || Number(process.env.TELEGRAM_BOT_LONG_POLL_SECONDS || 20)
  });
  const outcomes = [];
  let nextUpdateId = state.next_update_id;

  for (const update of updates) {
    try {
      outcomes.push({
        update_id: update.update_id,
        ...(await processUpdate(update))
      });
    } catch (error) {
      const chatId = cleanText(update?.message?.chat?.id != null ? String(update.message.chat.id) : null, null);
      const messageId = Number.isInteger(update?.message?.message_id) ? update.message.message_id : null;

      if (chatId) {
        await sendChunkedTelegramMessage({
          chatId,
          text: `Soleil hit an error: ${error.message}`,
          replyToMessageId: messageId
        }).catch(() => {});
      }

      outcomes.push({
        update_id: update.update_id,
        processed: false,
        reason: 'error',
        error: error.message
      });
    }

    if (Number.isInteger(update.update_id)) {
      nextUpdateId = update.update_id + 1;
      await saveOffsetState({
        next_update_id: nextUpdateId
      });
    }
  }

  return {
    updates_received: updates.length,
    next_update_id: nextUpdateId,
    outcomes
  };
}

async function runTelegramBot(options = {}) {
  const once = Boolean(options.once);
  const pollIntervalMs = Math.max(
    Number(options.pollIntervalMs || process.env.TELEGRAM_BOT_POLL_INTERVAL_MS) || 1500,
    250
  );
  const maxBackoffMs = Math.max(
    Number(options.maxBackoffMs || process.env.TELEGRAM_BOT_MAX_BACKOFF_MS) || 30000,
    pollIntervalMs
  );
  let currentBackoffMs = pollIntervalMs;

  do {
    try {
      const result = await processTelegramUpdates(options);

      if (typeof options.onCycle === 'function') {
        await options.onCycle(result);
      }

      if (once) {
        return result;
      }

      currentBackoffMs = pollIntervalMs;
    } catch (error) {
      if (typeof options.onError === 'function') {
        await options.onError(error);
      }

      if (once) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, currentBackoffMs));
      currentBackoffMs = Math.min(currentBackoffMs * 2, maxBackoffMs);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (true);
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
  splitTelegramMessage,
  parseTelegramCommand,
  formatStatusPayload,
  buildHelpText,
  loadOffsetState,
  saveOffsetState,
  processUpdate,
  processTelegramUpdates,
  runTelegramBot,
  __setDependencies,
  __resetDependencies
};
