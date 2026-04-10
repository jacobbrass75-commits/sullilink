const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const {
  buildDockerPgDumpArgs,
  buildPgDumpArgs,
  buildTimestamp,
  runBackup
} = require('../../scripts/backup-database');

test('buildTimestamp creates a stable backup timestamp', () => {
  assert.equal(
    buildTimestamp(new Date('2026-04-10T15:30:45.000Z')),
    '20260410-153045'
  );
});

test('buildPgDumpArgs includes the configured connection parameters', () => {
  const snapshot = {
    POSTGRES_HOST: process.env.POSTGRES_HOST,
    POSTGRES_PORT: process.env.POSTGRES_PORT,
    POSTGRES_USER: process.env.POSTGRES_USER,
    POSTGRES_DB: process.env.POSTGRES_DB
  };

  process.env.POSTGRES_HOST = 'db.local';
  process.env.POSTGRES_PORT = '5544';
  process.env.POSTGRES_USER = 'isg_user';
  process.env.POSTGRES_DB = 'brain_db';

  const args = buildPgDumpArgs('/tmp/backup.sql');

  assert.deepEqual(args, [
    '--host',
    'db.local',
    '--port',
    '5544',
    '--username',
    'isg_user',
    '--dbname',
    'brain_db',
    '--no-owner',
    '--no-privileges',
    '--file',
    '/tmp/backup.sql'
  ]);

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('runBackup creates the backup directory and returns file metadata', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-backup-'));
  const backupPath = path.join(tempDir, 'backup.sql');

  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const result = await runBackup({
    backupPath,
    spawnFn(command, args) {
      assert.equal(command, 'pg_dump');
      assert.ok(args.includes('--file'));
      fs.writeFileSync(backupPath, '-- fake dump --\n', 'utf8');

      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit('close', 0));
      return child;
    }
  });

  assert.equal(result.backup_path, backupPath);
  assert.equal(result.size_bytes > 0, true);
});

test('buildDockerPgDumpArgs targets the configured postgres container', () => {
  const snapshot = {
    POSTGRES_DOCKER_CONTAINER: process.env.POSTGRES_DOCKER_CONTAINER
  };

  process.env.POSTGRES_DOCKER_CONTAINER = 'brain-postgres';
  const args = buildDockerPgDumpArgs();

  assert.equal(args[0], 'exec');
  assert.equal(args[4], 'brain-postgres');
  assert.equal(args[5], 'pg_dump');

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('runBackup falls back to docker pg_dump when the host binary is unavailable', async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'isg-backup-docker-'));
  const backupPath = path.join(tempDir, 'backup.sql');
  const calls = [];

  t.after(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const result = await runBackup({
    backupPath,
    spawnFn(command, args) {
      calls.push({ command, args });

      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      process.nextTick(() => {
        if (command === 'pg_dump') {
          const error = new Error('spawn pg_dump ENOENT');
          error.code = 'ENOENT';
          child.emit('error', error);
          return;
        }

        child.stdout.emit('data', '-- docker dump --\n');
        child.emit('close', 0);
      });

      return child;
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'pg_dump');
  assert.equal(calls[1].command, 'docker');
  assert.equal(result.size_bytes > 0, true);
});
