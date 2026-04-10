#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const {
  getGoogleCredentialsPath,
  getGoogleTokenPath,
  loadGoogleCredentials
} = require('../src/integrations/google-auth');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive'
];

dotenv.config({ path: path.resolve(REPO_ROOT, '.env') });

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function getPort() {
  const explicit = process.argv
    .slice(2)
    .find((value) => value.startsWith('--port='));

  if (!explicit) {
    return 53682;
  }

  const port = Number(explicit.split('=')[1]);
  return Number.isInteger(port) && port > 0 ? port : 53682;
}

function getRedirectUri(port) {
  const override = cleanText(process.env.GOOGLE_OAUTH_REDIRECT_URI, null);

  if (override) {
    return override;
  }

  return `http://127.0.0.1:${port}/oauth2callback`;
}

function openBrowser(url) {
  const platform = process.platform;
  const args =
    platform === 'darwin'
      ? ['-a', 'Google Chrome', url]
      : platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];

  const command = platform === 'darwin' ? 'open' : args[0];
  const commandArgs = platform === 'darwin' ? args : args.slice(1);

  const child = spawn(command, commandArgs, {
    stdio: 'ignore',
    detached: true
  });

  child.unref();
}

function createCallbackServer(port) {
  let resolveCode;
  let rejectCode;

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    const code = cleanText(requestUrl.searchParams.get('code'), null);
    const error = cleanText(requestUrl.searchParams.get('error'), null);

    if (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Google OAuth failed: ${error}\n`);
      rejectCode(new Error(`Google OAuth failed: ${error}`));
      return;
    }

    if (!code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Missing Google OAuth code.\n');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Google auth succeeded. You can close this tab and return to Codex.\n');
    resolveCode(code);
  });

  return {
    codePromise,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function main() {
  const port = getPort();
  const credentialsPath = getGoogleCredentialsPath();
  const tokenPath = getGoogleTokenPath();

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Google credentials file not found at ${credentialsPath}`);
  }

  if (fs.existsSync(tokenPath) && !hasFlag('--force')) {
    console.log(`Token already exists at ${tokenPath}. Re-run with --force to replace it.`);
    return;
  }

  const credentials = await loadGoogleCredentials();
  const redirectUri = getRedirectUri(port);
  const oauth2Client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    redirectUri
  );
  const callbackServer = createCallbackServer(port);

  await callbackServer.listen();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DEFAULT_SCOPES
  });

  console.log(`Starting Google OAuth flow using ${credentialsPath}`);
  console.log(`Waiting for callback on ${redirectUri}`);
  console.log(`If the browser does not open, paste this URL into a browser:\n${authUrl}\n`);

  if (!hasFlag('--no-open')) {
    try {
      openBrowser(authUrl);
    } catch (error) {
      console.warn(`Could not open a browser automatically: ${error.message}`);
    }
  }

  let code;

  try {
    code = await callbackServer.codePromise;
  } finally {
    await callbackServer.close();
  }

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens || !tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Re-run with --force and complete the consent flow again.'
    );
  }

  fs.writeFileSync(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
  console.log(`Saved Google token to ${tokenPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
