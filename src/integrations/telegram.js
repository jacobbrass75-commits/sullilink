const fs = require('fs');
const path = require('path');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

const defaultDependencies = {
  fetch: global.fetch
};

let dependencies = { ...defaultDependencies };

function getTelegramBotToken() {
  const token = cleanText(process.env.TELEGRAM_BOT_TOKEN, null);

  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required for Telegram access');
  }

  return token;
}

function getTelegramBaseUrl() {
  return `https://api.telegram.org/bot${getTelegramBotToken()}`;
}

function getTelegramFileBaseUrl() {
  return `https://api.telegram.org/file/bot${getTelegramBotToken()}`;
}

function getDefaultTelegramChatId() {
  return cleanText(process.env.TELEGRAM_DEFAULT_CHAT_ID, null);
}

async function telegramRequest(methodName, payload = {}) {
  const response = await dependencies.fetch(`${getTelegramBaseUrl()}/${methodName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram request failed for ${methodName}`);
  }

  return result.result;
}

async function sendTelegramMessage({
  chatId,
  text,
  parseMode = null,
  disableWebPreview = true,
  replyToMessageId = null
}) {
  const targetChatId = cleanText(chatId, null) || getDefaultTelegramChatId();
  const messageText = cleanText(text, null);

  if (!targetChatId) {
    throw new Error('chatId is required');
  }

  if (!messageText) {
    throw new Error('text is required');
  }

  return telegramRequest('sendMessage', {
    chat_id: targetChatId,
    text: messageText,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    disable_web_page_preview: disableWebPreview,
    ...(replyToMessageId == null ? {} : { reply_to_message_id: replyToMessageId })
  });
}

async function sendTelegramChatAction({ chatId, action = 'typing' }) {
  const targetChatId = cleanText(chatId, null) || getDefaultTelegramChatId();

  if (!targetChatId) {
    throw new Error('chatId is required');
  }

  return telegramRequest('sendChatAction', {
    chat_id: targetChatId,
    action: cleanText(action, 'typing')
  });
}

async function listTelegramUpdates({ offset = null, limit = 10, timeoutSeconds = null } = {}) {
  return telegramRequest('getUpdates', {
    ...(offset == null ? {} : { offset }),
    limit: Math.min(Math.max(Number(limit) || 10, 1), 100),
    ...(Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
      ? { timeout: Math.min(Math.max(Number(timeoutSeconds), 1), 60) }
      : {})
  });
}

async function getTelegramFile(fileId) {
  const id = cleanText(fileId, null);

  if (!id) {
    throw new Error('fileId is required');
  }

  return telegramRequest('getFile', {
    file_id: id
  });
}

async function downloadTelegramFile(filePath, destinationPath) {
  const remotePath = cleanText(filePath, null);
  const absoluteDestination = path.resolve(destinationPath);

  if (!remotePath) {
    throw new Error('filePath is required');
  }

  const response = await dependencies.fetch(`${getTelegramFileBaseUrl()}/${remotePath}`, {
    method: 'GET',
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(`Telegram file download failed with status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.mkdir(path.dirname(absoluteDestination), { recursive: true });
  await fs.promises.writeFile(absoluteDestination, buffer);
  return absoluteDestination;
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
  getDefaultTelegramChatId,
  sendTelegramMessage,
  sendTelegramChatAction,
  listTelegramUpdates,
  getTelegramFile,
  downloadTelegramFile,
  __setDependencies,
  __resetDependencies
};
