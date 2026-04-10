const fs = require('fs');
const path = require('path');

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function buildSessionStore(options = {}) {
  const sessions = new Map();
  const maxHistory = Math.max(Number(options.maxHistory) || 12, 2);
  function resolveKey(input = {}) {
    const explicit = cleanText(input.session_id, null);

    if (explicit) {
      return explicit;
    }

    const channel = cleanText(input.channel, 'api');
    const threadId =
      cleanText(input.channel_chat_id, null) ||
      cleanText(input.channel_thread_id, null) ||
      cleanText(input.user_id, null) ||
      'default';

    return `${channel}:${threadId}`;
  }

  function normalizeSession(input = {}) {
    return {
      session_id: resolveKey(input),
      channel: cleanText(input.channel, 'api'),
      channel_chat_id: cleanText(input.channel_chat_id, null),
      channel_thread_id: cleanText(input.channel_thread_id, null),
      user_id: cleanText(input.user_id, null),
      pending_action: input.pending_action || null,
      history: Array.isArray(input.history) ? input.history.slice(-maxHistory) : []
    };
  }

  function getSession(input = {}) {
    const key = resolveKey(input);
    const existing = sessions.get(key);

    if (existing) {
      return existing;
    }

    const created = normalizeSession({
      ...input,
      session_id: key
    });
    sessions.set(key, created);
    return created;
  }

  function saveSession(session) {
    const normalized = normalizeSession(session);
    sessions.set(normalized.session_id, normalized);
  }

  function appendMessage(session, role, text, metadata = {}) {
    const next = {
      ...session,
      history: [
        ...(Array.isArray(session.history) ? session.history : []),
        {
          role,
          text: cleanText(text, ''),
          metadata,
          created_at: new Date().toISOString()
        }
      ].slice(-maxHistory)
    };
    saveSession(next);
    return next;
  }

  function exportSessions() {
    return Object.fromEntries([...sessions.entries()]);
  }

  function importSessions(serialized = {}) {
    sessions.clear();

    for (const value of Object.values(serialized || {})) {
      const normalized = normalizeSession(value);
      sessions.set(normalized.session_id, normalized);
    }
  }

  return {
    getSession,
    saveSession,
    appendMessage,
    exportSessions,
    importSessions
  };
}

function createInMemorySessionStore(options = {}) {
  return buildSessionStore(options);
}

function createFileSessionStore(options = {}) {
  const filePath = path.resolve(
    options.filePath || process.env.ASSISTANT_SESSION_STORE_PATH || 'data/assistant-sessions.json'
  );
  const store = buildSessionStore(options);
  let loaded = false;

  function ensureLoaded() {
    if (loaded) {
      return;
    }

    loaded = true;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      store.importSessions(JSON.parse(raw));
    } catch (_error) {
      store.importSessions({});
    }
  }

  function persist() {
    const serialized = `${JSON.stringify(store.exportSessions(), null, 2)}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(`${filePath}.tmp`, serialized, 'utf8');
    fs.renameSync(`${filePath}.tmp`, filePath);
  }

  return {
    getSession(input) {
      ensureLoaded();
      return store.getSession(input);
    },
    saveSession(session) {
      ensureLoaded();
      store.saveSession(session);
      persist();
    },
    appendMessage(session, role, text, metadata) {
      ensureLoaded();
      const next = store.appendMessage(session, role, text, metadata);
      persist();
      return next;
    }
  };
}

function createDefaultSessionStore(options = {}) {
  if (cleanText(process.env.ASSISTANT_SESSION_STORE_MODE, 'file') === 'memory') {
    return createInMemorySessionStore(options);
  }

  return createFileSessionStore(options);
}

module.exports = {
  createInMemorySessionStore,
  createFileSessionStore,
  createDefaultSessionStore
};
