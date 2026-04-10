#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function buildTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');

  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds())
  ].join('');
}

function getBackupDirectory() {
  return path.resolve(process.env.BRAIN_BACKUP_DIR || path.join(os.homedir(), 'brain-backups'));
}

function buildBackupPath(options = {}) {
  const backupDir = options.backupDir || getBackupDirectory();
  const now = options.now || new Date();
  return path.join(backupDir, `isg-brain-${buildTimestamp(now)}.sql`);
}

function buildPgDumpArgs(outputPath) {
  return [
    '--host',
    process.env.POSTGRES_HOST || 'localhost',
    '--port',
    String(process.env.POSTGRES_PORT || 5433),
    '--username',
    process.env.POSTGRES_USER || 'isg',
    '--dbname',
    process.env.POSTGRES_DB || 'isg_brain',
    '--no-owner',
    '--no-privileges',
    '--file',
    outputPath
  ];
}

function buildDockerPgDumpArgs() {
  return [
    'exec',
    '-i',
    '-e',
    `PGPASSWORD=${process.env.POSTGRES_PASSWORD || 'localdev'}`,
    process.env.POSTGRES_DOCKER_CONTAINER || 'isg-second-brain-postgres',
    'pg_dump',
    '--host',
    process.env.POSTGRES_DOCKER_HOST || '127.0.0.1',
    '--port',
    String(process.env.POSTGRES_DOCKER_PORT || 5432),
    '--username',
    process.env.POSTGRES_USER || 'isg',
    '--dbname',
    process.env.POSTGRES_DB || 'isg_brain',
    '--no-owner',
    '--no-privileges'
  ];
}

function runCommand(command, args, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const env = options.env || process.env;

  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on?.('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on?.('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function runBackup(options = {}) {
  const fsModule = options.fsModule || fs;
  const backupPath = options.backupPath || buildBackupPath(options);
  const backupDir = path.dirname(backupPath);

  await fsModule.promises.mkdir(backupDir, { recursive: true });

  const env = {
    ...process.env,
    ...(process.env.POSTGRES_PASSWORD
      ? { PGPASSWORD: process.env.POSTGRES_PASSWORD }
      : {})
  };
  const spawnFn = options.spawnFn || spawn;

  try {
    await runCommand('pg_dump', buildPgDumpArgs(backupPath), { spawnFn, env });
  } catch (error) {
    if (error.code !== 'ENOENT' && !/ENOENT/.test(error.message)) {
      throw error;
    }

    const fallback = await runCommand('docker', buildDockerPgDumpArgs(), { spawnFn, env });
    await fsModule.promises.writeFile(backupPath, fallback.stdout, 'utf8');
  }

  const stats = await fsModule.promises.stat(backupPath);

  return {
    backup_path: backupPath,
    size_bytes: stats.size
  };
}

async function main() {
  const result = await runBackup();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildBackupPath,
  buildDockerPgDumpArgs,
  buildPgDumpArgs,
  buildTimestamp,
  getBackupDirectory,
  runCommand,
  runBackup
};
