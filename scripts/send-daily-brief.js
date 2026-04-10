#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { close } = require('../src/db/connection');
const { createPdfGenerator } = require('../src/integrations/pdf-generator');
const { sendEmail } = require('../src/integrations/gmail');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function getRecipient() {
  return cleanText(process.env.BROKER_ALERT_EMAIL, null) || cleanText(process.env.BROKER_EMAIL, null);
}

function getGoogleCredentialsPath() {
  return path.resolve(process.cwd(), process.env.GOOGLE_CREDENTIALS_PATH || 'google-credentials.json');
}

function createOptionalDriveClient(options = {}) {
  const fsModule = options.fsModule || fs;
  const loadDriveModule =
    options.loadDriveModule || (() => require('../src/integrations/drive'));
  const logger = options.logger || console;

  return {
    async uploadFile(localPath, driveFolder, fileName) {
      const hasInlineCredentials = cleanText(process.env.GOOGLE_CREDENTIALS_JSON, null);

      if (!hasInlineCredentials && !fsModule.existsSync(getGoogleCredentialsPath())) {
        return {
          status: 'skipped',
          reason: 'google_credentials_missing',
          local_path: localPath,
          drive_folder: driveFolder,
          file_name: fileName
        };
      }

      try {
        const drive = loadDriveModule();
        return await drive.uploadFile(localPath, driveFolder, fileName);
      } catch (error) {
        logger.warn(`Daily brief Drive upload skipped: ${error.message}`);
        return {
          status: 'skipped',
          reason: 'drive_upload_failed',
          error: error.message,
          local_path: localPath,
          drive_folder: driveFolder,
          file_name: fileName
        };
      }
    }
  };
}

function buildEmailBody(result) {
  const driveLink =
    result.upload?.web_view_link ||
    result.upload?.webViewLink ||
    result.upload?.url ||
    null;
  const generatedAt = result.preview?.generated_at || new Date().toISOString();

  return [
    '<p>Your ISG daily brief is ready.</p>',
    '<ul>',
    `<li><strong>Generated:</strong> ${generatedAt}</li>`,
    `<li><strong>File:</strong> ${result.file_name}</li>`,
    driveLink ? `<li><strong>Drive link:</strong> <a href="${driveLink}">${driveLink}</a></li>` : null,
    `<li><strong>Local path:</strong> ${result.file_path}</li>`,
    '</ul>',
    '<p>If live sending is disabled, this will remain a Gmail draft until approved.</p>'
  ]
    .filter(Boolean)
    .join('');
}

async function sendDailyBrief(options = {}) {
  const recipient = options.recipient || getRecipient();

  if (!recipient) {
    throw new Error('BROKER_ALERT_EMAIL or BROKER_EMAIL is required to send the daily brief');
  }

  const generate =
    options.generateDailyBrief ||
    createPdfGenerator({
      driveClient: createOptionalDriveClient({
        fsModule: options.fsModule,
        loadDriveModule: options.loadDriveModule,
        logger: options.logger
      })
    }).generateDailyBrief;
  const send = options.sendEmail || sendEmail;
  const fromAlias = options.fromAlias || process.env.GMAIL_FROM_ALIAS || 'ISG Second Brain';
  const result = await generate();
  const emailResult = await send(
    recipient,
    `ISG Daily Brief - ${String(result.preview?.generated_at || '').slice(0, 10) || 'today'}`,
    buildEmailBody(result),
    fromAlias
  );

  return {
    recipient,
    email: emailResult,
    brief: result
  };
}

async function main() {
  const result = await sendDailyBrief();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await close();
    });
}

module.exports = {
  buildEmailBody,
  createOptionalDriveClient,
  getGoogleCredentialsPath,
  getRecipient,
  sendDailyBrief
};
