const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const whisper = require('../../src/integrations/whisper');

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('transcribeFile posts audio to OpenAI and normalizes the transcript payload', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whisper-transcribe-'));
  const audioPath = path.join(tempDir, 'note.mp3');
  const originalFetch = global.fetch;
  const envSnapshot = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TRANSCRIPTION_PROVIDER: process.env.TRANSCRIPTION_PROVIDER,
    OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_TRANSCRIPTION_COST_PER_MINUTE: process.env.OPENAI_TRANSCRIPTION_COST_PER_MINUTE
  };

  t.after(async () => {
    global.fetch = originalFetch;
    restoreEnv(envSnapshot);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.TRANSCRIPTION_PROVIDER = 'whisper';
  process.env.OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';
  process.env.OPENAI_TRANSCRIPTION_COST_PER_MINUTE = '0.006';

  await fs.promises.writeFile(audioPath, 'fake audio');

  global.fetch = async (input, init = {}) => {
    assert.equal(String(input), 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-openai-key');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('model'), 'whisper-1');
    assert.equal(init.body.get('response_format'), 'verbose_json');

    const uploadedFile = init.body.get('file');
    assert.equal(uploadedFile.name, 'note.mp3');
    assert.equal(uploadedFile.type, 'audio/mpeg');

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          text: 'Broker note about a new industrial lead.',
          duration: 90,
          language: 'en'
        };
      }
    };
  };

  const result = await whisper.transcribeFile(audioPath);

  assert.deepEqual(result, {
    text: 'Broker note about a new industrial lead.',
    duration_seconds: 90,
    language: 'en',
    mime_type: 'audio/mpeg',
    model: 'whisper-1',
    cost_estimate: 0.009
  });
});

test('processRecording uses injected Drive and ingest seams and returns a summary', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whisper-process-'));
  const audioPath = path.join(tempDir, 'call.wav');
  const originalFetch = global.fetch;
  const envSnapshot = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TRANSCRIPTION_PROVIDER: process.env.TRANSCRIPTION_PROVIDER,
    OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL
  };

  t.after(async () => {
    global.fetch = originalFetch;
    restoreEnv(envSnapshot);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.TRANSCRIPTION_PROVIDER = 'whisper';
  process.env.OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';

  await fs.promises.writeFile(audioPath, 'fake audio');

  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        text: 'Seller wants to talk next Tuesday about pricing.',
        duration: 45,
        language: 'en'
      };
    }
  });

  const result = await whisper.processRecording(audioPath, {
    driveUploader: async (targetPath, options) => {
      assert.equal(targetPath, audioPath);
      assert.equal(options.transcription.text, 'Seller wants to talk next Tuesday about pricing.');

      return {
        status: 'uploaded',
        fileId: 'drive-file-1',
        webViewLink: 'https://drive.example/file/1'
      };
    },
    ingestTranscript: async (transcription, options) => {
      assert.equal(transcription.text, 'Seller wants to talk next Tuesday about pricing.');
      assert.equal(options.driveUpload.status, 'uploaded');

      return {
        ok: true,
        knowledge_entry_id: 'ke-123',
        summary: 'New seller follow-up',
        action_items: ['Schedule pricing review'],
        created: ['entity-1'],
        updated: [],
        linked: ['property-9'],
        matches: []
      };
    }
  });

  assert.equal(result.audio_path, audioPath);
  assert.equal(result.transcription.duration_seconds, 45);
  assert.deepEqual(result.drive_upload, {
    status: 'uploaded',
    file_id: 'drive-file-1',
    web_link: 'https://drive.example/file/1',
    folder_id: null,
    file_name: 'call.wav'
  });
  assert.deepEqual(result.ingest, {
    ok: true,
    knowledge_entry_id: 'ke-123',
    summary: 'New seller follow-up',
    action_items: ['Schedule pricing review'],
    created: ['entity-1'],
    updated: [],
    linked: ['property-9'],
    matches: []
  });
});

test('batchProcessFolder moves processed audio, appends to the processed log, and skips logged paths', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whisper-batch-'));
  const processedLogPath = path.join(tempDir, '.processed-recordings.log');
  const processMePath = path.join(tempDir, 'process-me.mp3');
  const skipMePath = path.join(tempDir, 'skip-me.mp3');
  const originalFetch = global.fetch;
  const envSnapshot = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    TRANSCRIPTION_PROVIDER: process.env.TRANSCRIPTION_PROVIDER,
    OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL
  };

  t.after(async () => {
    global.fetch = originalFetch;
    restoreEnv(envSnapshot);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.TRANSCRIPTION_PROVIDER = 'whisper';
  process.env.OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';

  await fs.promises.writeFile(processMePath, 'fake audio');
  await fs.promises.writeFile(skipMePath, 'already handled audio');
  await fs.promises.writeFile(
    processedLogPath,
    `${JSON.stringify({ audio_path: skipMePath, processed_at: '2026-04-10T00:00:00.000Z' })}\n`
  );

  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        text: 'Quick voice memo about a buyer tour.',
        duration: 30,
        language: 'en'
      };
    }
  });

  const firstRun = await whisper.batchProcessFolder(tempDir, {
    processedLogPath,
    driveUploader: async () => ({
      status: 'uploaded',
      fileId: 'drive-1',
      webViewLink: 'https://drive.example/file/1'
    }),
    ingestTranscript: async () => ({
      ok: true,
      knowledge_entry_id: 'ke-789',
      summary: 'Buyer tour note',
      action_items: [],
      created: [],
      updated: [],
      linked: [],
      matches: []
    })
  });

  assert.equal(firstRun.total_processed, 1);
  assert.equal(firstRun.total_skipped, 1);
  assert.equal(firstRun.total_failed, 0);
  assert.equal(fs.existsSync(path.join(tempDir, 'processed', 'process-me.mp3')), true);

  const processedLogEntries = await fs.promises.readFile(processedLogPath, 'utf8');
  assert.match(processedLogEntries, /process-me\.mp3/);
  assert.match(processedLogEntries, /skip-me\.mp3/);

  await fs.promises.writeFile(processMePath, 'new audio at the same path');

  const secondRun = await whisper.batchProcessFolder(tempDir, {
    processedLogPath,
    driveUploader: async () => {
      throw new Error('should not reprocess');
    },
    ingestTranscript: async () => {
      throw new Error('should not ingest');
    }
  });

  assert.equal(secondRun.total_processed, 0);
  assert.equal(secondRun.total_skipped, 2);
  assert.equal(secondRun.total_failed, 0);
});
