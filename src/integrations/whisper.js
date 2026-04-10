const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.webm']);
const DEFAULT_RECORDINGS_FOLDER = path.join(os.homedir(), 'brain-recordings');
const DEFAULT_PROCESSED_DIR_NAME = 'processed';
const DEFAULT_PROCESSED_LOG_NAME = '.processed-recordings.log';

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function toAbsolutePath(targetPath) {
  return path.resolve(String(targetPath || ''));
}

function getTranscriptionProvider() {
  return String(process.env.TRANSCRIPTION_PROVIDER || 'whisper').trim().toLowerCase();
}

function getTranscriptionModel() {
  return cleanText(process.env.OPENAI_TRANSCRIPTION_MODEL, 'whisper-1');
}

function getApiBaseUrl() {
  return String(process.env.BRAIN_API_URL || `http://localhost:${process.env.API_PORT || 3100}`).replace(
    /\/$/,
    ''
  );
}

function getDefaultRecordingsFolder() {
  return DEFAULT_RECORDINGS_FOLDER;
}

function getDefaultProcessedLogPath(folderPath = DEFAULT_RECORDINGS_FOLDER) {
  return path.join(toAbsolutePath(folderPath), DEFAULT_PROCESSED_LOG_NAME);
}

function getProcessedDirectory(folderPath = DEFAULT_RECORDINGS_FOLDER) {
  return path.join(toAbsolutePath(folderPath), DEFAULT_PROCESSED_DIR_NAME);
}

function getExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(getExtension(filePath));
}

function isInsideProcessedDirectory(filePath, processedDir) {
  const absoluteFilePath = toAbsolutePath(filePath);
  const absoluteProcessedDir = toAbsolutePath(processedDir);
  const relative = path.relative(absoluteProcessedDir, absoluteFilePath);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getMimeType(filePath) {
  switch (getExtension(filePath)) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

function estimateCost(durationSeconds, model = getTranscriptionModel()) {
  const roundedDuration = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : 0;
  const explicitRate = Number(process.env.OPENAI_TRANSCRIPTION_COST_PER_MINUTE);
  const defaultRates = {
    'whisper-1': 0.006
  };
  const ratePerMinute = Number.isFinite(explicitRate)
    ? explicitRate
    : defaultRates[model] || 0;
  const estimate = (roundedDuration / 60) * ratePerMinute;

  return Number(estimate.toFixed(6));
}

async function ensureReadableAudioFile(filePath) {
  const absolutePath = toAbsolutePath(filePath);

  if (!isAudioFile(absolutePath)) {
    throw new Error(`Unsupported audio file extension for ${absolutePath}`);
  }

  let stats = null;

  try {
    stats = await fs.promises.stat(absolutePath);
  } catch (_error) {
    throw new Error(`Audio file not found: ${absolutePath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Audio path is not a file: ${absolutePath}`);
  }

  await fs.promises.access(absolutePath, fs.constants.R_OK);
  return absolutePath;
}

function getOpenAIHeaders() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when TRANSCRIPTION_PROVIDER=whisper');
  }

  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
  };
}

async function transcribeWithWhisper(filePath, options = {}) {
  const absolutePath = await ensureReadableAudioFile(filePath);
  const provider = getTranscriptionProvider();

  if (!['whisper', 'openai'].includes(provider)) {
    throw new Error(
      `Unsupported TRANSCRIPTION_PROVIDER for whisper integration: ${provider}`
    );
  }

  const model = options.model || getTranscriptionModel();
  const fileBuffer = await fs.promises.readFile(absolutePath);
  const file = new File([fileBuffer], path.basename(absolutePath), {
    type: getMimeType(absolutePath)
  });
  const form = new FormData();

  form.append('file', file);
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: options.headers || getOpenAIHeaders(),
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  const transcription = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      cleanText(transcription?.error?.message, `OpenAI transcription failed with status ${response.status}`)
    );
  }

  const durationSeconds = Number.isFinite(Number(transcription?.duration))
    ? Number(transcription.duration)
    : 0;

  return {
    text: cleanText(transcription?.text, ''),
    duration_seconds: durationSeconds,
    language: cleanText(transcription?.language, 'unknown'),
    mime_type: getMimeType(absolutePath),
    model,
    cost_estimate: estimateCost(durationSeconds, model)
  };
}

function normalizeDriveUploadResult(result, audioPath) {
  if (typeof result === 'string') {
    return {
      status: 'uploaded',
      file_id: null,
      web_link: result,
      folder_id: null,
      file_name: path.basename(audioPath)
    };
  }

  if (!result || typeof result !== 'object') {
    return {
      status: 'skipped',
      reason: 'drive_uploader_returned_empty_result',
      file_name: path.basename(audioPath)
    };
  }

  return {
    status: cleanText(result.status, 'uploaded'),
    file_id: cleanText(result.file_id || result.fileId || result.id, null),
    web_link: cleanText(result.web_link || result.webViewLink || result.link || result.url, null),
    folder_id: cleanText(result.folder_id || result.folderId, null),
    file_name: cleanText(result.file_name || result.fileName || result.name, path.basename(audioPath))
  };
}

function resolveDriveUploader(options = {}) {
  if (typeof options.driveUploader === 'function') {
    return options.driveUploader;
  }

  return async (audioPath) => ({
    status: 'skipped',
    reason: 'drive_uploader_not_configured',
    file_name: path.basename(audioPath)
  });
}

async function ingestTranscript(transcription, options = {}) {
  if (!transcription || !cleanText(transcription.text, null)) {
    throw new Error('Cannot ingest an empty transcript');
  }

  if (typeof options.ingestTranscript === 'function') {
    return options.ingestTranscript(transcription, options);
  }

  const response = await fetch(`${getApiBaseUrl()}/api/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      message: transcription.text,
      source: cleanText(options.source, 'voice_memo')
    }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error || `Transcript ingest failed with status ${response.status}`);
  }

  return payload;
}

function createNoopLogger() {
  return {
    info() {},
    error() {}
  };
}

function emitLog(logger, level, event, metadata = {}) {
  if (!logger) {
    return;
  }

  if (typeof logger === 'function') {
    logger(level, event, metadata);
    return;
  }

  const fn = level === 'error' ? logger.error : logger.info;

  if (typeof fn === 'function') {
    fn.call(logger, event, metadata);
  }
}

async function readProcessedLog(logPath) {
  const absoluteLogPath = toAbsolutePath(logPath);

  try {
    const content = await fs.promises.readFile(absoluteLogPath, 'utf8');

    return new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            const parsed = JSON.parse(line);
            return toAbsolutePath(parsed.audio_path || parsed.path || line);
          } catch (_error) {
            return toAbsolutePath(line);
          }
        })
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Set();
    }

    throw error;
  }
}

async function appendProcessedLog(logPath, audioPath, metadata = {}) {
  const absoluteLogPath = toAbsolutePath(logPath);

  await fs.promises.mkdir(path.dirname(absoluteLogPath), { recursive: true });
  await fs.promises.appendFile(
    absoluteLogPath,
    `${JSON.stringify({
      audio_path: toAbsolutePath(audioPath),
      processed_at: new Date().toISOString(),
      ...metadata
    })}\n`
  );
}

async function moveToProcessedDirectory(audioPath, processedDir) {
  const absoluteAudioPath = toAbsolutePath(audioPath);
  const absoluteProcessedDir = toAbsolutePath(processedDir);
  const extension = path.extname(absoluteAudioPath);
  const baseName = path.basename(absoluteAudioPath, extension);

  await fs.promises.mkdir(absoluteProcessedDir, { recursive: true });

  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const targetPath = path.join(absoluteProcessedDir, `${baseName}${suffix}${extension}`);

    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      attempt += 1;
      continue;
    } catch (_error) {
      await fs.promises.rename(absoluteAudioPath, targetPath);
      return targetPath;
    }
  }
}

async function processRecording(audioPath, options = {}) {
  const absolutePath = await ensureReadableAudioFile(audioPath);
  const transcription = await transcribeWithWhisper(absolutePath, options);
  let driveUpload = null;

  try {
    const uploader = resolveDriveUploader(options);
    driveUpload = normalizeDriveUploadResult(
      await uploader(absolutePath, {
        ...options,
        transcription
      }),
      absolutePath
    );
  } catch (error) {
    driveUpload = {
      status: 'failed',
      error: error.message,
      file_name: path.basename(absolutePath)
    };
  }

  const ingestResult = await ingestTranscript(transcription, {
    ...options,
    audioPath: absolutePath,
    driveUpload
  });

  return {
    audio_path: absolutePath,
    file_name: path.basename(absolutePath),
    transcription,
    drive_upload: driveUpload,
    ingest: {
      ok: ingestResult?.ok === true,
      knowledge_entry_id: ingestResult?.knowledge_entry_id || null,
      summary: cleanText(ingestResult?.summary, null),
      action_items: Array.isArray(ingestResult?.action_items) ? ingestResult.action_items : [],
      created: Array.isArray(ingestResult?.created) ? ingestResult.created : [],
      updated: Array.isArray(ingestResult?.updated) ? ingestResult.updated : [],
      linked: Array.isArray(ingestResult?.linked) ? ingestResult.linked : [],
      matches: Array.isArray(ingestResult?.matches) ? ingestResult.matches : []
    },
    processed_at: new Date().toISOString()
  };
}

async function processPendingAudioFile(audioPath, options = {}) {
  const absolutePath = toAbsolutePath(audioPath);
  const folderPath = toAbsolutePath(options.folderPath || path.dirname(absolutePath));
  const processedDir = toAbsolutePath(options.processedDir || getProcessedDirectory(folderPath));
  const processedLogPath = toAbsolutePath(
    options.processedLogPath || getDefaultProcessedLogPath(folderPath)
  );
  const processedPaths = options.processedPaths || (await readProcessedLog(processedLogPath));
  const inFlightPaths = options.inFlightPaths || new Set();
  const logger = options.logger || createNoopLogger();

  if (!isAudioFile(absolutePath)) {
    return {
      status: 'ignored',
      reason: 'unsupported_extension',
      audio_path: absolutePath
    };
  }

  if (isInsideProcessedDirectory(absolutePath, processedDir)) {
    return {
      status: 'ignored',
      reason: 'inside_processed_directory',
      audio_path: absolutePath
    };
  }

  if (processedPaths.has(absolutePath)) {
    emitLog(logger, 'info', 'skipped_already_processed', {
      audio_path: absolutePath
    });

    return {
      status: 'skipped',
      reason: 'already_processed',
      audio_path: absolutePath
    };
  }

  if (inFlightPaths.has(absolutePath)) {
    emitLog(logger, 'info', 'skipped_in_flight', {
      audio_path: absolutePath
    });

    return {
      status: 'skipped',
      reason: 'already_in_flight',
      audio_path: absolutePath
    };
  }

  inFlightPaths.add(absolutePath);
  emitLog(logger, 'info', 'processing_started', {
    audio_path: absolutePath
  });

  try {
    const summary = await processRecording(absolutePath, options);
    const movedTo =
      options.moveProcessed === false
        ? absolutePath
        : await moveToProcessedDirectory(absolutePath, processedDir);

    await appendProcessedLog(processedLogPath, absolutePath, {
      moved_to: movedTo,
      knowledge_entry_id: summary.ingest.knowledge_entry_id
    });
    processedPaths.add(absolutePath);
    emitLog(logger, 'info', 'processing_completed', {
      audio_path: absolutePath,
      moved_to: movedTo,
      knowledge_entry_id: summary.ingest.knowledge_entry_id
    });

    return {
      status: 'processed',
      audio_path: absolutePath,
      moved_to: movedTo,
      summary
    };
  } catch (error) {
    emitLog(logger, 'error', 'processing_failed', {
      audio_path: absolutePath,
      error: error.message
    });

    return {
      status: 'failed',
      audio_path: absolutePath,
      error: error.message
    };
  } finally {
    inFlightPaths.delete(absolutePath);
  }
}

async function batchProcessFolder(folderPath, options = {}) {
  const absoluteFolderPath = toAbsolutePath(folderPath);
  const processedLogPath = toAbsolutePath(
    options.processedLogPath || getDefaultProcessedLogPath(absoluteFolderPath)
  );
  const processedPaths = options.processedPaths || (await readProcessedLog(processedLogPath));
  const inFlightPaths = options.inFlightPaths || new Set();
  const entries = await fs.promises.readdir(absoluteFolderPath, {
    withFileTypes: true
  });
  const audioEntries = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(absoluteFolderPath, entry.name))
    .filter((entryPath) => isAudioFile(entryPath))
    .sort((a, b) => a.localeCompare(b));

  const processed = [];
  const skipped = [];
  const failed = [];

  for (const audioPath of audioEntries) {
    const result = await processPendingAudioFile(audioPath, {
      ...options,
      folderPath: absoluteFolderPath,
      processedLogPath,
      processedPaths,
      inFlightPaths
    });

    if (result.status === 'processed') {
      processed.push(result);
      continue;
    }

    if (result.status === 'failed') {
      failed.push(result);
      continue;
    }

    skipped.push(result);
  }

  return {
    folder_path: absoluteFolderPath,
    processed_log_path: processedLogPath,
    processed_dir: getProcessedDirectory(absoluteFolderPath),
    processed,
    skipped,
    failed,
    total_discovered: audioEntries.length,
    total_processed: processed.length,
    total_skipped: skipped.length,
    total_failed: failed.length
  };
}

module.exports = {
  transcribeFile: transcribeWithWhisper,
  processRecording,
  batchProcessFolder,
  __private: {
    appendProcessedLog,
    createNoopLogger,
    emitLog,
    estimateCost,
    getApiBaseUrl,
    getDefaultProcessedLogPath,
    getDefaultRecordingsFolder,
    getMimeType,
    getOpenAIHeaders,
    getProcessedDirectory,
    ingestTranscript,
    isAudioFile,
    isInsideProcessedDirectory,
    moveToProcessedDirectory,
    processPendingAudioFile,
    readProcessedLog,
    resolveDriveUploader,
    transcribeWithWhisper
  }
};
