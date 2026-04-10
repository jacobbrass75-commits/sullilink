const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  splitTelegramMessage,
  parseTelegramCommand,
  processUpdate,
  processTelegramUpdates,
  __setDependencies,
  __resetDependencies
} = require('../../src/ops/telegram-bot');

test.afterEach(() => {
  __resetDependencies();
});

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('parseTelegramCommand strips bot mentions from slash commands', () => {
  assert.deepEqual(parseTelegramCommand('/status@Soleil_bot'), {
    name: 'status',
    argument: ''
  });
});

test('splitTelegramMessage creates safe chunks', () => {
  const input = `Line 1\n${'A'.repeat(3900)}\nLine 3`;
  const chunks = splitTelegramMessage(input, 500);

  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) => chunk.length <= 500), true);
});

test('processUpdate routes plain text to the assistant and replies with its answer', async () => {
  const sent = [];
  const snapshot = {
    TELEGRAM_ASSISTANT_TRANSPORT: process.env.TELEGRAM_ASSISTANT_TRANSPORT
  };
  process.env.TELEGRAM_ASSISTANT_TRANSPORT = 'local';

  __setDependencies({
    handleAssistantMessage: async (payload) => ({
      tool_name: 'lookup_brain',
      reply: `Handled: ${payload.message}`
    }),
    sendTelegramMessage: async (payload) => {
      sent.push(payload);
      return { message_id: sent.length };
    },
    sendTelegramChatAction: async () => ({ ok: true })
  });

  const result = await processUpdate({
    update_id: 1,
    message: {
      message_id: 77,
      text: 'What do we know about Mike Chen?',
      chat: { id: 123 },
      from: { id: 456 }
    }
  });

  assert.equal(result.processed, true);
  assert.equal(result.mode, 'assistant');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Handled: What do we know about Mike Chen/);
  restoreEnv(snapshot);
});

test('processUpdate downloads voice notes, ingests them, and replies with the summary', async () => {
  const sent = [];
  const snapshot = {
    TELEGRAM_ASSISTANT_TRANSPORT: process.env.TELEGRAM_ASSISTANT_TRANSPORT
  };
  process.env.TELEGRAM_ASSISTANT_TRANSPORT = 'local';
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'telegram-bot-test-'));
  const tempFile = path.join(tempDir, 'voice.ogg');

  __setDependencies({
    getTelegramFile: async () => ({
      file_path: 'voice/file_1.ogg'
    }),
    downloadTelegramFile: async (_filePath, destinationPath) => {
      await fs.promises.writeFile(destinationPath, 'audio');
      return destinationPath;
    },
    processAudioFile: async () => ({
      summary: 'Saved your voice note',
      transcription: {
        text: 'Need to follow up with Mike.'
      },
      action_items: ['Call Mike tomorrow']
    }),
    sendTelegramMessage: async (payload) => {
      sent.push(payload);
      return { message_id: sent.length };
    },
    sendTelegramChatAction: async () => ({ ok: true })
  });

  const result = await processUpdate({
    update_id: 2,
    message: {
      message_id: 88,
      voice: {
        file_id: 'voice-1',
        mime_type: 'audio/ogg'
      },
      chat: { id: 123 },
      from: { id: 456 }
    }
  });

  assert.equal(result.processed, true);
  assert.equal(result.mode, 'audio');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Saved your voice note/);
  assert.match(sent[0].text, /Need to follow up with Mike/);

  await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.unlink(tempFile).catch(() => {});
  restoreEnv(snapshot);
});

test('processTelegramUpdates persists the next update id after each processed update', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'telegram-offset-'));
  const snapshot = {
    TELEGRAM_BOT_OFFSET_FILE: process.env.TELEGRAM_BOT_OFFSET_FILE
  };
  process.env.TELEGRAM_BOT_OFFSET_FILE = path.join(tempDir, 'offset.json');

  __setDependencies({
    listTelegramUpdates: async () => [
      {
        update_id: 9,
        message: {
          message_id: 1,
          text: 'hello',
          chat: { id: 123 },
          from: { id: 456 }
        }
      }
    ],
    handleAssistantMessage: async () => ({
      tool_name: 'store_note',
      reply: 'Stored.'
    }),
    sendTelegramMessage: async () => ({ message_id: 1 }),
    sendTelegramChatAction: async () => ({ ok: true })
  });

  const result = await processTelegramUpdates({
    timeoutSeconds: 1
  });
  const saved = JSON.parse(await fs.promises.readFile(process.env.TELEGRAM_BOT_OFFSET_FILE, 'utf8'));

  assert.equal(result.next_update_id, 10);
  assert.equal(saved.next_update_id, 10);

  restoreEnv(snapshot);
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});
