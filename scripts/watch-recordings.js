const fs = require('fs');
const os = require('os');
const path = require('path');
const chokidar = require('chokidar');
const whisper = require('../src/integrations/whisper');

function parseArgs(argv) {
  const args = {
    folderPath: path.join(os.homedir(), 'brain-recordings'),
    processedLogPath: null,
    activityLogPath: null,
    once: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--once') {
      args.once = true;
      continue;
    }

    if (arg === '--folder' && argv[index + 1]) {
      args.folderPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--processed-log' && argv[index + 1]) {
      args.processedLogPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--activity-log' && argv[index + 1]) {
      args.activityLogPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (!arg.startsWith('--') && index === 0) {
      args.folderPath = arg;
    }
  }

  return args;
}

function defaultActivityLogPath(folderPath) {
  return path.join(path.resolve(folderPath), 'watch-recordings.log');
}

function createActivityLogger(logPath, output = console) {
  const absoluteLogPath = path.resolve(logPath);

  fs.mkdirSync(path.dirname(absoluteLogPath), { recursive: true });

  function write(level, event, metadata = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...metadata
    };
    const line = JSON.stringify(entry);

    fs.appendFileSync(absoluteLogPath, `${line}\n`);

    if (level === 'error') {
      if (typeof output.error === 'function') {
        output.error(line);
      }
      return;
    }

    if (typeof output.log === 'function') {
      output.log(line);
      return;
    }

    if (typeof output.info === 'function') {
      output.info(line);
    }
  }

  return {
    path: absoluteLogPath,
    info(event, metadata) {
      write('info', event, metadata);
    },
    error(event, metadata) {
      write('error', event, metadata);
    }
  };
}

async function createRecordingWatcher(options = {}) {
  const folderPath = path.resolve(
    options.folderPath || whisper.__private.getDefaultRecordingsFolder()
  );
  const processedLogPath = path.resolve(
    options.processedLogPath || whisper.__private.getDefaultProcessedLogPath(folderPath)
  );
  const activityLogPath = path.resolve(
    options.activityLogPath || defaultActivityLogPath(folderPath)
  );
  const logger = options.logger || createActivityLogger(activityLogPath, options.output || console);
  const processedPaths =
    options.processedPaths || (await whisper.__private.readProcessedLog(processedLogPath));
  const inFlightPaths = options.inFlightPaths || new Set();

  await fs.promises.mkdir(folderPath, { recursive: true });

  async function processFile(filePath) {
    return whisper.__private.processPendingAudioFile(filePath, {
      ...options,
      folderPath,
      processedLogPath,
      processedPaths,
      inFlightPaths,
      logger
    });
  }

  const watchFactory = options.watchFactory || chokidar.watch;
  const watcher = watchFactory(folderPath, {
    ignoreInitial: true,
    persistent: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    void processFile(filePath);
  });
  watcher.on('error', (error) => {
    logger.error('watcher_error', {
      folder_path: folderPath,
      error: error.message
    });
  });

  await new Promise((resolve) => {
    watcher.on('ready', resolve);
  });

  logger.info('watcher_ready', {
    folder_path: folderPath,
    processed_log_path: processedLogPath,
    activity_log_path: activityLogPath
  });

  const initialScan = await whisper.batchProcessFolder(folderPath, {
    ...options,
    processedLogPath,
    processedPaths,
    inFlightPaths,
    logger
  });

  logger.info('startup_scan_completed', {
    folder_path: folderPath,
    total_processed: initialScan.total_processed,
    total_skipped: initialScan.total_skipped,
    total_failed: initialScan.total_failed
  });

  let closed = false;

  return {
    watcher,
    folderPath,
    processedLogPath,
    activityLogPath,
    processedPaths,
    inFlightPaths,
    initialScan,
    processFile,
    logger,
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await watcher.close();
      logger.info('watcher_stopped', {
        folder_path: folderPath
      });
    }
  };
}

async function runOnce(options = {}) {
  const folderPath = path.resolve(
    options.folderPath || whisper.__private.getDefaultRecordingsFolder()
  );
  const processedLogPath = path.resolve(
    options.processedLogPath || whisper.__private.getDefaultProcessedLogPath(folderPath)
  );
  const activityLogPath = path.resolve(
    options.activityLogPath || defaultActivityLogPath(folderPath)
  );
  const logger = options.logger || createActivityLogger(activityLogPath, options.output || console);

  await fs.promises.mkdir(folderPath, { recursive: true });
  logger.info('startup_scan_begin', {
    folder_path: folderPath,
    processed_log_path: processedLogPath
  });

  return whisper.batchProcessFolder(folderPath, {
    ...options,
    processedLogPath,
    logger
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.once) {
    const summary = await runOnce(args);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const watcherController = await createRecordingWatcher(args);
  const shutdown = async (signal) => {
    watcherController.logger.info('shutdown_signal', {
      signal
    });
    await watcherController.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  createActivityLogger,
  createRecordingWatcher,
  defaultActivityLogPath,
  main,
  parseArgs,
  runOnce
};
