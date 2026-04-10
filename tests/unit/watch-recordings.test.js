const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const whisper = require('../../src/integrations/whisper');
const watchRecordings = require('../../scripts/watch-recordings');

function createFakeWatcher() {
  const handlers = new Map();

  return {
    on(event, handler) {
      handlers.set(event, handler);

      if (event === 'ready') {
        setImmediate(handler);
      }

      return this;
    },
    emit(event, ...args) {
      const handler = handlers.get(event);

      if (typeof handler === 'function') {
        handler(...args);
      }
    },
    async close() {
      return undefined;
    }
  };
}

test('createRecordingWatcher routes new audio files through the processing queue', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'watch-recordings-'));
  const audioPath = path.join(tempDir, 'fresh-note.mp3');
  const activityLogPath = path.join(tempDir, 'watch.log');
  const originalBatchProcessFolder = whisper.batchProcessFolder;
  const originalProcessPendingAudioFile = whisper.__private.processPendingAudioFile;
  const fakeWatcher = createFakeWatcher();
  const processedCalls = [];

  t.after(async () => {
    whisper.batchProcessFolder = originalBatchProcessFolder;
    whisper.__private.processPendingAudioFile = originalProcessPendingAudioFile;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  whisper.batchProcessFolder = async () => ({
    folder_path: tempDir,
    processed_log_path: path.join(tempDir, '.processed-recordings.log'),
    processed_dir: path.join(tempDir, 'processed'),
    processed: [],
    skipped: [],
    failed: [],
    total_discovered: 0,
    total_processed: 0,
    total_skipped: 0,
    total_failed: 0
  });
  whisper.__private.processPendingAudioFile = async (filePath) => {
    processedCalls.push(filePath);

    return {
      status: 'processed',
      audio_path: filePath,
      moved_to: path.join(tempDir, 'processed', path.basename(filePath)),
      summary: {
        ingest: {
          knowledge_entry_id: 'ke-555'
        }
      }
    };
  };

  const controller = await watchRecordings.createRecordingWatcher({
    folderPath: tempDir,
    activityLogPath,
    watchFactory() {
      return fakeWatcher;
    }
  });

  await fs.promises.writeFile(audioPath, 'new memo');
  fakeWatcher.emit('add', audioPath);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(processedCalls, [audioPath]);

  const activityLog = await fs.promises.readFile(activityLogPath, 'utf8');
  assert.match(activityLog, /watcher_ready/);
  assert.match(activityLog, /startup_scan_completed/);

  await controller.close();
});
