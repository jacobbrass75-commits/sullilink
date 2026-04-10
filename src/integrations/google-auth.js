const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function resolvePath(filePath) {
  if (!filePath) {
    return null;
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function getGoogleCredentialsPath() {
  return resolvePath(process.env.GOOGLE_CREDENTIALS_PATH || 'google-credentials.json');
}

function getGoogleTokenPath() {
  return resolvePath(process.env.GOOGLE_TOKEN_PATH || 'google-token.json');
}

async function readJsonFile(filePath) {
  const absolutePath = resolvePath(filePath);

  if (!absolutePath) {
    return null;
  }

  const contents = await fs.promises.readFile(absolutePath, 'utf8');
  return JSON.parse(contents);
}

async function maybeReadJsonFile(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function pickCredentialPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Google credentials are missing or invalid');
  }

  const candidate = payload.installed || payload.web || payload;
  const clientId = cleanText(candidate.client_id, null);
  const clientSecret = cleanText(candidate.client_secret, null);
  const redirectUri =
    cleanText(candidate.redirect_uri, null) ||
    cleanText(Array.isArray(candidate.redirect_uris) ? candidate.redirect_uris[0] : null, null) ||
    'http://localhost';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials must include client_id and client_secret');
  }

  return {
    clientId,
    clientSecret,
    redirectUri
  };
}

async function loadGoogleCredentials() {
  const inline = cleanText(process.env.GOOGLE_CREDENTIALS_JSON, null);

  if (inline) {
    return pickCredentialPayload(JSON.parse(inline));
  }

  const payload = await readJsonFile(getGoogleCredentialsPath());
  return pickCredentialPayload(payload);
}

async function loadGoogleToken() {
  const inline = cleanText(process.env.GOOGLE_TOKEN_JSON, null);

  if (inline) {
    return JSON.parse(inline);
  }

  const token = await maybeReadJsonFile(getGoogleTokenPath());

  if (token) {
    return token;
  }

  const refreshToken = cleanText(process.env.GOOGLE_REFRESH_TOKEN, null);

  if (!refreshToken) {
    throw new Error(
      'Google token not found. Provide google-token.json, GOOGLE_TOKEN_JSON, or GOOGLE_REFRESH_TOKEN'
    );
  }

  return {
    refresh_token: refreshToken,
    access_token: cleanText(process.env.GOOGLE_ACCESS_TOKEN, null),
    scope: cleanText(process.env.GOOGLE_TOKEN_SCOPE, null),
    token_type: cleanText(process.env.GOOGLE_TOKEN_TYPE, 'Bearer'),
    expiry_date: process.env.GOOGLE_TOKEN_EXPIRY
      ? Number(process.env.GOOGLE_TOKEN_EXPIRY)
      : undefined
  };
}

function normalizeScopes(scopes = []) {
  if (!Array.isArray(scopes)) {
    return [];
  }

  return [...new Set(scopes.map((value) => cleanText(value, null)).filter(Boolean))];
}

async function createOAuth2Client(scopes = []) {
  const credentials = await loadGoogleCredentials();
  const token = await loadGoogleToken();
  const client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri
  );

  client.setCredentials(token);

  const requestedScopes = normalizeScopes(scopes);

  if (requestedScopes.length > 0) {
    client.requestedScopes = requestedScopes;
  }

  return client;
}

function resolveGoogleClientArgs(serviceNameOrScopes, version, scopes) {
  if (typeof serviceNameOrScopes === 'string') {
    return {
      serviceName: serviceNameOrScopes,
      version: cleanText(version, null),
      scopes: normalizeScopes(scopes)
    };
  }

  return {
    serviceName: null,
    version: null,
    scopes: normalizeScopes(serviceNameOrScopes)
  };
}

async function getGoogleClient(serviceNameOrScopes = [], version, scopes) {
  const resolved = resolveGoogleClientArgs(serviceNameOrScopes, version, scopes);
  const auth = await createOAuth2Client(resolved.scopes);

  if (!resolved.serviceName) {
    return {
      google,
      auth
    };
  }

  const factory = google[resolved.serviceName];

  if (typeof factory !== 'function') {
    throw new Error(`Unsupported Google API service: ${resolved.serviceName}`);
  }

  return factory({
    version: resolved.version,
    auth
  });
}

module.exports = {
  createOAuth2Client,
  getGoogleClient,
  getGoogleCredentialsPath,
  getGoogleTokenPath,
  loadGoogleCredentials,
  loadGoogleToken,
  normalizeScopes
};
