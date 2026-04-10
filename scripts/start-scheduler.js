#!/usr/bin/env node

const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
process.chdir(repoRoot)

const { startScheduler } = require('../src/scheduler/cron')

function main() {
  const scheduler = startScheduler({ cwd: repoRoot })

  console.log(
    `Scheduler started with ${scheduler.registrations.length} active jobs in ${scheduler.timezone}. Logging to ${scheduler.logFilePath}.`
  )

  const shutdown = (signal) => {
    console.log(`${signal} received, stopping scheduler...`)
    scheduler.stopAll()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
