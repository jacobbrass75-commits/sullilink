const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')
const nodeCron = require('node-cron')
const { spawn } = require('child_process')

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const DEFAULT_TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const DEFAULT_JOB_DEFINITIONS = Object.freeze([
  {
    name: 'health-check',
    schedule: '*/15 * * * *',
    script: 'scripts/health-check.js',
    optional: true
  },
  {
    name: 'process-inbound-email',
    schedule: '*/30 * * * *',
    script: 'scripts/process-inbound-email.js'
  },
  {
    name: 'sync-properties',
    schedule: '0 * * * *',
    script: 'scripts/sync-properties.js'
  },
  {
    name: 'sync-monday',
    schedule: '0 */4 * * *',
    script: 'scripts/sync-monday.js'
  },
  {
    name: 'run-matching',
    schedule: '0 6 * * *',
    script: 'scripts/run-matching.js'
  },
  {
    name: 'sync-calendar',
    schedule: '0 6 * * *',
    script: 'scripts/sync-calendar.js'
  },
  {
    name: 'send-daily-brief',
    schedule: '0 7 * * *',
    script: 'scripts/send-daily-brief.js'
  },
  {
    name: 'backup-database',
    schedule: '0 23 * * *',
    script: 'scripts/backup-database.js'
  }
])

function createClock() {
  return {
    now: () => new Date(),
    nowMs: () => Date.now()
  }
}

function resolveJobDefinitions({ cwd = process.cwd(), jobs = DEFAULT_JOB_DEFINITIONS } = {}) {
  return jobs.map((job) => ({
    ...job,
    cwd,
    scriptPath: path.resolve(cwd, job.script)
  }))
}

function createLogWriter({
  cwd = process.cwd(),
  fsModule = fs,
  logFilePath = path.resolve(cwd, 'logs/cron.log')
} = {}) {
  return {
    logFilePath,
    write(entry) {
      fsModule.mkdirSync(path.dirname(logFilePath), { recursive: true })
      fsModule.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8')
    }
  }
}

function buildLogEntry({
  timestamp,
  job,
  status,
  durationMs,
  error,
  reason
}) {
  return {
    timestamp,
    job: job.name,
    script: job.script,
    status,
    success: status === 'success' ? true : status === 'fail' ? false : null,
    duration_ms: durationMs,
    ...(error ? { error } : {}),
    ...(reason ? { reason } : {})
  }
}

function buildScriptFailure(job, code, signal, stdout, stderr) {
  const suffix = signal ? `signal ${signal}` : `code ${code}`
  const messageParts = [`Scheduled job ${job.name} failed with ${suffix}`]

  if (stderr.trim()) {
    messageParts.push(stderr.trim().split('\n').slice(-5).join(' | '))
  }

  const error = new Error(messageParts.join(': '))
  error.exitCode = code
  error.signal = signal
  error.stdout = stdout
  error.stderr = stderr
  return error
}

function createScriptRunner({
  cwd = process.cwd(),
  fsModule = fs,
  spawnFn = spawn,
  env = process.env,
  nodePath = process.execPath
} = {}) {
  return async function runScript(job) {
    if (!fsModule.existsSync(job.scriptPath)) {
      throw new Error(`Scheduled job ${job.name} is missing script ${job.script}`)
    }

    return new Promise((resolve, reject) => {
      const child = spawnFn(nodePath, [job.scriptPath], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })

      child.on('error', reject)
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve({ code, signal, stdout, stderr })
          return
        }

        reject(buildScriptFailure(job, code, signal, stdout, stderr))
      })
    })
  }
}

function loadGmailSendEmail({ cwd = process.cwd(), fsModule = fs } = {}) {
  const gmailModulePath = path.resolve(cwd, 'src/integrations/gmail.js')

  if (!fsModule.existsSync(gmailModulePath)) {
    return null
  }

  const gmailModule = require(gmailModulePath)
  return typeof gmailModule.sendEmail === 'function' ? gmailModule.sendEmail : null
}

function createFailureAlertNotifier({
  cwd = process.cwd(),
  fsModule = fs,
  env = process.env,
  sendEmail = loadGmailSendEmail({ cwd, fsModule }),
  recipient = env.BROKER_ALERT_EMAIL || env.BROKER_EMAIL,
  fromAlias = env.GMAIL_FROM_ALIAS || 'ISG Scheduler',
  logger = console
} = {}) {
  return async function notifyFailure({ job, error, startedAt, finishedAt, durationMs }) {
    if (!recipient || typeof sendEmail !== 'function') {
      logger.warn?.(
        `Skipping failure alert for ${job.name}: Gmail notifier or BROKER_ALERT_EMAIL is unavailable`
      )
      return false
    }

    const subject = `[ISG Scheduler] ${job.name} failed`
    const body = [
      '<p>A scheduled ISG Second Brain job failed.</p>',
      '<ul>',
      `<li><strong>Job:</strong> ${job.name}</li>`,
      `<li><strong>Script:</strong> ${job.script}</li>`,
      `<li><strong>Started:</strong> ${startedAt.toISOString()}</li>`,
      `<li><strong>Finished:</strong> ${finishedAt.toISOString()}</li>`,
      `<li><strong>Duration:</strong> ${durationMs}ms</li>`,
      `<li><strong>Error:</strong> ${error.message}</li>`,
      '</ul>'
    ].join('')

    await sendEmail(recipient, subject, body, fromAlias)
    return true
  }
}

function createScheduler(options = {}) {
  const {
    cwd = process.cwd(),
    jobs = DEFAULT_JOB_DEFINITIONS,
    cronModule = nodeCron,
    fsModule = fs,
    clock = createClock(),
    logger = console,
    timezone = DEFAULT_TIMEZONE
  } = options
  const logWriter = options.logWriter || createLogWriter({ cwd, fsModule })
  const runner = options.runner || createScriptRunner({ cwd, fsModule })
  const alertNotifier =
    options.alertNotifier || createFailureAlertNotifier({ cwd, fsModule, logger })
  const resolvedJobs = resolveJobDefinitions({ cwd, jobs })
  const registrations = []

  async function executeJob(job) {
    const startedAt = clock.now()
    const startedMs = clock.nowMs()

    try {
      const result = await runner(job)
      const finishedAt = clock.now()
      const durationMs = clock.nowMs() - startedMs

      logWriter.write(
        buildLogEntry({
          timestamp: finishedAt.toISOString(),
          job,
          status: 'success',
          durationMs
        })
      )

      return result
    } catch (error) {
      const finishedAt = clock.now()
      const durationMs = clock.nowMs() - startedMs

      logWriter.write(
        buildLogEntry({
          timestamp: finishedAt.toISOString(),
          job,
          status: 'fail',
          durationMs,
          error: error.message
        })
      )

      try {
        await alertNotifier({ job, error, startedAt, finishedAt, durationMs })
      } catch (alertError) {
        logger.error?.(
          `Failed to send failure alert for ${job.name}: ${alertError.message}`
        )
      }

      throw error
    }
  }

  function registerJobs() {
    if (registrations.length > 0) {
      return registrations
    }

    for (const job of resolvedJobs) {
      if (typeof cronModule.validate === 'function' && !cronModule.validate(job.schedule)) {
        throw new Error(`Invalid cron schedule for ${job.name}: ${job.schedule}`)
      }

      if (job.optional && !fsModule.existsSync(job.scriptPath)) {
        logWriter.write(
          buildLogEntry({
            timestamp: clock.now().toISOString(),
            job,
            status: 'skipped',
            durationMs: 0,
            reason: 'missing-script'
          })
        )
        continue
      }

      if (!job.optional && !fsModule.existsSync(job.scriptPath)) {
        logger.warn?.(
          `Scheduled job ${job.name} points to missing script ${job.script}. It will fail until the script is added.`
        )
      }

      const task = cronModule.schedule(
        job.schedule,
        async () => {
          try {
            await executeJob(job)
          } catch (error) {
            logger.error?.(`Scheduled job ${job.name} failed: ${error.message}`)
          }
        },
        { timezone }
      )

      registrations.push({ job, task })
    }

    return registrations
  }

  function stopAll() {
    for (const registration of registrations) {
      registration.task.stop?.()
      registration.task.destroy?.()
    }
  }

  return {
    cwd,
    jobs: resolvedJobs,
    logFilePath: logWriter.logFilePath,
    timezone,
    registrations,
    executeJob,
    registerJobs,
    stopAll
  }
}

function startScheduler(options = {}) {
  const scheduler = createScheduler(options)
  scheduler.registerJobs()
  return scheduler
}

module.exports = {
  DEFAULT_JOB_DEFINITIONS,
  buildLogEntry,
  createClock,
  createFailureAlertNotifier,
  createLogWriter,
  createScheduler,
  createScriptRunner,
  loadGmailSendEmail,
  resolveJobDefinitions,
  startScheduler
}
