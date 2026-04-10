const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const nodeCron = require('node-cron')
const {
  DEFAULT_JOB_DEFINITIONS,
  createFailureAlertNotifier,
  createScheduler
} = require('../../src/scheduler/cron')

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'isg-scheduler-'))
}

function writeFile(root, relativePath, contents = '// test fixture\n') {
  const targetPath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, contents, 'utf8')
}

function readLogEntries(root) {
  const logPath = path.join(root, 'logs/cron.log')

  if (!fs.existsSync(logPath)) {
    return []
  }

  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function createFakeCron() {
  const calls = []

  return {
    calls,
    validate: () => true,
    schedule(expression, handler, options) {
      const task = {
        expression,
        handler,
        options,
        stopped: false,
        destroyed: false,
        stop() {
          this.stopped = true
        },
        destroy() {
          this.destroyed = true
        }
      }

      calls.push(task)
      return task
    }
  }
}

function createClock({ timestamps, msValues }) {
  const dateQueue = [...timestamps]
  const msQueue = [...msValues]

  return {
    now() {
      return new Date(dateQueue.shift() || timestamps[timestamps.length - 1])
    },
    nowMs() {
      return msQueue.shift() ?? msValues[msValues.length - 1]
    }
  }
}

test('default scheduler jobs use valid node-cron expressions', () => {
  for (const job of DEFAULT_JOB_DEFINITIONS) {
    assert.equal(nodeCron.validate(job.schedule), true, `${job.name} should have a valid schedule`)
  }
})

test('registerJobs schedules every configured job when scripts are present', () => {
  const root = createTempWorkspace()
  const fakeCron = createFakeCron()
  const fsModule = {
    ...fs,
    existsSync(targetPath) {
      return targetPath.endsWith('.js') ? true : fs.existsSync(targetPath)
    }
  }

  const scheduler = createScheduler({
    cwd: root,
    cronModule: fakeCron,
    fsModule,
    runner: async () => {},
    alertNotifier: async () => {}
  })

  const registrations = scheduler.registerJobs()

  assert.equal(registrations.length, DEFAULT_JOB_DEFINITIONS.length)
  assert.deepEqual(
    fakeCron.calls.map((call) => call.expression),
    DEFAULT_JOB_DEFINITIONS.map((job) => job.schedule)
  )
  assert.equal(fakeCron.calls[0].options.timezone, scheduler.timezone)
})

test('registerJobs skips the optional health-check when its script is missing', () => {
  const root = createTempWorkspace()
  const fakeCron = createFakeCron()
  const logger = {
    warn() {},
    error() {}
  }
  const fsModule = {
    ...fs,
    existsSync(targetPath) {
      if (targetPath === path.join(root, 'scripts/health-check.js')) {
        return false
      }

      return targetPath.endsWith('.js') ? true : fs.existsSync(targetPath)
    }
  }

  const scheduler = createScheduler({
    cwd: root,
    cronModule: fakeCron,
    fsModule,
    runner: async () => {},
    alertNotifier: async () => {},
    logger
  })

  scheduler.registerJobs()

  assert.equal(fakeCron.calls.length, DEFAULT_JOB_DEFINITIONS.length - 1)

  const logEntries = readLogEntries(root)
  assert.equal(logEntries.length, 1)
  assert.equal(logEntries[0].job, 'health-check')
  assert.equal(logEntries[0].status, 'skipped')
  assert.equal(logEntries[0].reason, 'missing-script')
})

test('executeJob writes success entries with durations to logs/cron.log', async () => {
  const root = createTempWorkspace()
  writeFile(root, 'scripts/run-matching.js')

  const scheduler = createScheduler({
    cwd: root,
    jobs: [
      {
        name: 'run-matching',
        schedule: '0 6 * * *',
        script: 'scripts/run-matching.js'
      }
    ],
    runner: async () => ({ ok: true }),
    alertNotifier: async () => {},
    clock: createClock({
      timestamps: ['2026-04-10T13:00:00.000Z', '2026-04-10T13:00:05.000Z'],
      msValues: [1000, 6000]
    })
  })

  await scheduler.executeJob(scheduler.jobs[0])

  const logEntries = readLogEntries(root)
  assert.equal(logEntries.length, 1)
  assert.deepEqual(logEntries[0], {
    timestamp: '2026-04-10T13:00:05.000Z',
    job: 'run-matching',
    script: 'scripts/run-matching.js',
    status: 'success',
    success: true,
    duration_ms: 5000
  })
})

test('executeJob logs failures and calls the injected alert notifier seam', async () => {
  const root = createTempWorkspace()
  writeFile(root, 'scripts/backup-database.js')
  const alerts = []

  const scheduler = createScheduler({
    cwd: root,
    jobs: [
      {
        name: 'backup-database',
        schedule: '0 23 * * *',
        script: 'scripts/backup-database.js'
      }
    ],
    runner: async () => {
      throw new Error('pg_dump crashed')
    },
    alertNotifier: async (payload) => {
      alerts.push(payload)
      return true
    },
    clock: createClock({
      timestamps: ['2026-04-10T23:00:00.000Z', '2026-04-10T23:00:04.000Z'],
      msValues: [500, 4500]
    })
  })

  await assert.rejects(() => scheduler.executeJob(scheduler.jobs[0]), /pg_dump crashed/)

  const logEntries = readLogEntries(root)
  assert.equal(logEntries.length, 1)
  assert.equal(logEntries[0].status, 'fail')
  assert.equal(logEntries[0].success, false)
  assert.equal(logEntries[0].duration_ms, 4000)
  assert.match(logEntries[0].error, /pg_dump crashed/)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].job.name, 'backup-database')
  assert.equal(alerts[0].durationMs, 4000)
})

test('createFailureAlertNotifier sends Gmail alerts through an injected sendEmail seam', async () => {
  const sentMessages = []

  const notifier = createFailureAlertNotifier({
    recipient: 'broker@example.com',
    fromAlias: 'ISG Ops',
    sendEmail: async (...args) => {
      sentMessages.push(args)
      return { id: 'draft-1' }
    }
  })

  await notifier({
    job: {
      name: 'sync-properties',
      script: 'scripts/sync-properties.js'
    },
    error: new Error('upstream API timeout'),
    startedAt: new Date('2026-04-10T10:00:00.000Z'),
    finishedAt: new Date('2026-04-10T10:00:03.000Z'),
    durationMs: 3000
  })

  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0][0], 'broker@example.com')
  assert.match(sentMessages[0][1], /\[ISG Scheduler\] sync-properties failed/)
  assert.match(sentMessages[0][2], /upstream API timeout/)
  assert.equal(sentMessages[0][3], 'ISG Ops')
})
