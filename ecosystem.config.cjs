module.exports = {
  apps: [
    {
      name: 'isg-api',
      cwd: __dirname,
      script: 'src/api/server.js',
      interpreter: 'node',
      time: true,
      merge_logs: true,
      out_file: 'logs/pm2-api.log',
      error_file: 'logs/pm2-api-error.log',
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'isg-scheduler',
      cwd: __dirname,
      script: 'scripts/start-scheduler.js',
      interpreter: 'node',
      time: true,
      merge_logs: true,
      out_file: 'logs/pm2-scheduler.log',
      error_file: 'logs/pm2-scheduler-error.log',
      autorestart: true,
      exp_backoff_restart_delay: 500,
      max_memory_restart: '256M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'isg-telegram-bot',
      cwd: __dirname,
      script: 'scripts/run-telegram-bot.js',
      interpreter: 'node',
      time: true,
      merge_logs: true,
      out_file: 'logs/pm2-telegram.log',
      error_file: 'logs/pm2-telegram-error.log',
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '256M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        TELEGRAM_BOT_MODE: 'polling'
      }
    }
  ]
};
