const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const schemaPath = path.join(__dirname, '..', 'schema.sql');
function cleanUrl(value) {
  let v = String(value || '').trim();
  v = v.replace(/^[A-Z_]+=/, '');
  v = v.replace(/^["']+|["']+$/g, '').trim();
  return v;
}
const candidateUrls = [
  process.env.CHATBRIDGE_DATABASE_URL,
  process.env.DATABASE_URL,
  process.env.POSTGRES_URL,
  process.env.POSTGRES_PRISMA_URL,
  process.env.POSTGRES_URL_NON_POOLING
].map(cleanUrl).filter(Boolean);
const databaseUrl = candidateUrls.find((u) => /^postgres(?:ql)?:/i.test(u)) || candidateUrls[0] || '';
const databaseUrlIsPostgres = /^postgres(?:ql)?:/i.test(databaseUrl);
const knownManagedMysqlUrl = /^mysql:/i.test(databaseUrl) && process.env.NODE_ENV !== 'production';
const hasCloudSqlSettings = Boolean(
  process.env.DB_USER &&
  process.env.DB_NAME &&
  (process.env.DB_HOST || process.env.INSTANCE_CONNECTION_NAME)
);
const hasAnyDatabaseSettings = Boolean(
  databaseUrl ||
  process.env.DB_USER ||
  process.env.DB_PASSWORD ||
  process.env.DB_NAME ||
  process.env.DB_HOST ||
  process.env.DB_SOCKET_DIR ||
  process.env.INSTANCE_CONNECTION_NAME
);
const usePostgres = Boolean(databaseUrlIsPostgres || hasCloudSqlSettings);

function resolveSsl() {
  if (process.env.DB_SSL === 'false') return undefined;
  if (process.env.DB_SSL === 'true') return { rejectUnauthorized: false };
  if (databaseUrlIsPostgres && !/localhost|127\.0\.0\.1/.test(databaseUrl)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

const pool = usePostgres
  ? new Pool({
      connectionString: databaseUrlIsPostgres ? databaseUrl : undefined,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      host: process.env.DB_HOST || (
        process.env.INSTANCE_CONNECTION_NAME
          ? `${process.env.DB_SOCKET_DIR || '/cloudsql'}/${process.env.INSTANCE_CONNECTION_NAME}`
          : undefined
      ),
      max: 5,
      connectionTimeoutMillis: 5000,
      ssl: resolveSsl()
    })
  : null;

const EMBEDDED_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  recipient_id UUID NOT NULL REFERENCES users(id),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_status VARCHAR(10) NOT NULL DEFAULT 'sent'
    CHECK (delivery_status IN ('sent', 'delivered', 'read')),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_pending
  ON messages (recipient_id) WHERE delivery_status = 'sent';
CREATE INDEX IF NOT EXISTS idx_participants_user
  ON conversation_participants (user_id);
`;

const memory = {
  users: new Map(),
  emailToId: new Map(),
  conversations: new Map(),
  messages: new Map()
};

let pgDisabled = false;
let lastDbError = null;
let schemaEnsured = false;

function isConnectionError(error) {
  if (!error) return false;
  if (error.code === '23505') return false;
  const code = error.code || '';
  const msg = error.message || '';
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === '28P01' ||
    code === '3D000' ||
    code === '28000' ||
    code === '42P01' ||
    code === '57P01' ||
    /connection|timeout|connect|network|reach|refused|authentication|pg_hba|SSL/i.test(msg)
  );
}

function handleDbError(err, context = '') {
  lastDbError = err.message || String(err);
  console.error(JSON.stringify({ severity: 'ERROR', event: 'db_error', context, message: err.message, code: err.code }));
  if (isConnectionError(err)) {
    if (!pgDisabled) {
      console.warn(JSON.stringify({ severity: 'WARNING', event: 'db_fallback_to_memory', reason: err.message }));
      pgDisabled = true;
    }
  }
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at) || null
  };
}

function normalizeMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    recipient_id: row.recipient_id,
    content: row.content,
    created_at: iso(row.created_at),
    delivery_status: row.delivery_status,
    delivered_at: iso(row.delivered_at),
    read_at: iso(row.read_at)
  };
}

function mode() {
  if (!usePostgres) return 'memory-development';
  if (pgDisabled) return 'memory-fallback';
  return 'postgres';
}

function validateDatabaseConfig() {
  if (knownManagedMysqlUrl) return;
  if (databaseUrl && !databaseUrlIsPostgres) {
    lastDbError = 'DATABASE_URL must use the PostgreSQL protocol (postgres://...); running in memory mode';
    console.warn(JSON.stringify({ severity: 'WARNING', event: 'invalid_database_url', message: lastDbError }));
    return;
  }
  if (hasAnyDatabaseSettings && !usePostgres) {
    lastDbError = 'Incomplete PostgreSQL configuration; running in memory mode';
    console.warn(JSON.stringify({ severity: 'WARNING', event: 'incomplete_database_config', message: lastDbError }));
    return;
  }
  if (process.env.NODE_ENV === 'production' && !usePostgres) {
    console.warn(JSON.stringify({ severity: 'WARNING', event: 'production_without_postgres', message: 'Running in production without PostgreSQL; in-memory storage active' }));
  }
}

async function ensureSchema() {
  if (!pool || pgDisabled || schemaEnsured) return;
  try {
    let schema;
    try {
      schema = await fs.readFile(schemaPath, 'utf8');
    } catch {
      schema = EMBEDDED_SCHEMA;
    }
    try {
      await pool.query(schema);
    } catch (err) {
      if (/pgcrypto/i.test(err.message)) {
        const withoutPgcrypto = schema.replace(/CREATE\s+EXTENSION[^;]+;/gi, '');
        await pool.query(withoutPgcrypto);
      } else {
        throw err;
      }
    }
    schemaEnsured = true;
  } catch (err) {
    handleDbError(err, 'ensureSchema');
  }
}

async function health() {
  if (!pool || pgDisabled) {
    return { mode: mode(), error: lastDbError || undefined };
  }
  try {
    await ensureSchema();
    await pool.query('SELECT 1');
    return { mode: 'postgres' };
  } catch (err) {
    handleDbError(err, 'health');
    return { mode: mode(), fallback: true, error: err.message };
  }
}

async function findUserByEmail(email) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        'SELECT id, username, email, created_at, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1',
        [email]
      );
      if (result.rows[0]) return result.rows[0];
    } catch (err) {
      handleDbError(err, 'findUserByEmail');
    }
  }
  const id = memory.emailToId.get(email.toLowerCase());
  return id ? memory.users.get(id) : null;
}

async function findUserById(id) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        'SELECT id, username, email, created_at FROM users WHERE id = $1 LIMIT 1',
        [id]
      );
      if (result.rows[0]) return normalizeUser(result.rows[0]);
    } catch (err) {
      handleDbError(err, 'findUserById');
    }
  }
  return normalizeUser(memory.users.get(id));
}

async function createUser({ id, username, email, passwordHash }) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        `INSERT INTO users (id, username, email, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, email, created_at`,
        [id, username, email.toLowerCase(), passwordHash]
      );
      return normalizeUser(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') throw err;
      handleDbError(err, 'createUser');
    }
  }

  const normalizedEmail = email.toLowerCase();
  const duplicate = [...memory.users.values()].find(
    (user) => user.username.toLowerCase() === username.toLowerCase() || user.email === normalizedEmail
  );
  if (duplicate) {
    const error = new Error('Username or email already exists');
    error.code = '23505';
    throw error;
  }
  const user = { id, username, email: normalizedEmail, password_hash: passwordHash, created_at: new Date() };
  memory.users.set(id, user);
  memory.emailToId.set(normalizedEmail, id);
  return normalizeUser(user);
}

async function listUsers(excludeId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        'SELECT id, username, created_at, last_seen_at FROM users WHERE id <> $1 ORDER BY username ASC LIMIT 500',
        [excludeId]
      );
      return result.rows.map(normalizeUser);
    } catch (err) {
      handleDbError(err, 'listUsers');
    }
  }
  return [...memory.users.values()]
    .filter((user) => user.id !== excludeId)
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(normalizeUser);
}

function memoryConversationFor(userId, otherUserId) {
  return [...memory.conversations.values()].find(
    (conversation) => conversation.participants.has(userId) && conversation.participants.has(otherUserId)
  );
}

async function createOrGetConversation(userId, otherUserId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pairKey = [userId, otherUserId].sort().join(':');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pairKey]);
        const existing = await client.query(
          `SELECT c.id, c.created_at
             FROM conversations c
             JOIN conversation_participants cp ON cp.conversation_id = c.id
            WHERE cp.user_id = ANY($1::uuid[])
            GROUP BY c.id, c.created_at
           HAVING COUNT(DISTINCT cp.user_id) = 2
            LIMIT 1`,
          [[userId, otherUserId]]
        );
        if (existing.rows[0]) {
          await client.query('COMMIT');
          return existing.rows[0];
        }
        const conversation = await client.query('INSERT INTO conversations DEFAULT VALUES RETURNING id, created_at');
        const id = conversation.rows[0].id;
        await client.query(
          'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
          [id, userId, otherUserId]
        );
        await client.query('COMMIT');
        return conversation.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (err) {
      handleDbError(err, 'createOrGetConversation');
    }
  }

  let conversation = memoryConversationFor(userId, otherUserId);
  if (!conversation) {
    conversation = { id: crypto.randomUUID(), created_at: new Date(), participants: new Set([userId, otherUserId]) };
    memory.conversations.set(conversation.id, conversation);
  }
  return { id: conversation.id, created_at: iso(conversation.created_at) };
}

async function userIsParticipant(conversationId, userId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
        [conversationId, userId]
      );
      return result.rowCount > 0;
    } catch (err) {
      handleDbError(err, 'userIsParticipant');
    }
  }
  return Boolean(memory.conversations.get(conversationId)?.participants.has(userId));
}

async function listConversations(userId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        `SELECT c.id, c.created_at, peer.id AS peer_id, peer.username AS peer_username,
                peer.last_seen_at AS peer_last_seen_at,
                last_message.id AS last_message_id, last_message.content AS last_message,
                last_message.created_at AS last_message_at,
                last_message.sender_id AS last_message_sender_id,
                last_message.delivery_status AS last_message_status,
                (SELECT count(*)::int FROM messages um
                  WHERE um.conversation_id = c.id AND um.recipient_id = $1
                    AND um.delivery_status <> 'read') AS unread_count
           FROM conversations c
           JOIN conversation_participants mine ON mine.conversation_id = c.id AND mine.user_id = $1
           JOIN conversation_participants other ON other.conversation_id = c.id AND other.user_id <> $1
           JOIN users peer ON peer.id = other.user_id
           LEFT JOIN LATERAL (
             SELECT id, content, created_at, sender_id, delivery_status FROM messages
              WHERE conversation_id = c.id
              ORDER BY created_at DESC LIMIT 1
           ) last_message ON true
          ORDER BY COALESCE(last_message.created_at, c.created_at) DESC
          LIMIT 200`,
        [userId]
      );
      return result.rows.map((row) => ({
        ...row,
        created_at: iso(row.created_at),
        last_message_at: iso(row.last_message_at || row.created_at),
        peer_last_seen_at: iso(row.peer_last_seen_at) || null
      }));
    } catch (err) {
      handleDbError(err, 'listConversations');
    }
  }

  return [...memory.conversations.values()]
    .filter((conversation) => conversation.participants.has(userId))
    .map((conversation) => {
      const peerId = [...conversation.participants].find((id) => id !== userId);
      const peer = memory.users.get(peerId);
      const messages = [...memory.messages.values()]
        .filter((message) => message.conversation_id === conversation.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return {
        id: conversation.id,
        created_at: iso(conversation.created_at),
        peer_id: peerId,
        peer_username: peer?.username || 'Unknown user',
        peer_last_seen_at: iso(peer?.last_seen_at) || null,
        last_message_id: messages[0]?.id || null,
        last_message: messages[0]?.content || null,
        last_message_at: iso(messages[0]?.created_at || conversation.created_at),
        last_message_sender_id: messages[0]?.sender_id || null,
        last_message_status: messages[0]?.delivery_status || null,
        unread_count: messages.filter((m) => m.recipient_id === userId && m.delivery_status !== 'read').length
      };
    })
    .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
}

async function listMessages(conversationId, userId, { limit = 50, before } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const values = [conversationId, userId, safeLimit];
      let beforeSql = '';
      if (before) {
        values.push(before);
        beforeSql = ' AND m.created_at < $4';
      }
      const result = await pool.query(
        `SELECT m.id, m.conversation_id, m.sender_id, m.recipient_id, m.content,
                m.created_at, m.delivery_status, m.delivered_at, m.read_at
           FROM messages m
           JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = $2
          WHERE m.conversation_id = $1${beforeSql}
          ORDER BY m.created_at DESC
          LIMIT $3`,
        values
      );
      return result.rows.reverse().map(normalizeMessage);
    } catch (err) {
      handleDbError(err, 'listMessages');
    }
  }

  return [...memory.messages.values()]
    .filter((message) => message.conversation_id === conversationId)
    .filter((message) => !before || new Date(message.created_at) < new Date(before))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(-safeLimit)
    .map(normalizeMessage);
}

async function insertMessage(message) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        `INSERT INTO messages (id, conversation_id, sender_id, recipient_id, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, conversation_id, sender_id, recipient_id, content, created_at,
                   delivery_status, delivered_at, read_at`,
        [message.id, message.conversationId, message.senderId, message.recipientId, message.content]
      );
      if (result.rows[0]) return { message: normalizeMessage(result.rows[0]), inserted: true };

      const existing = await pool.query(
        `SELECT id, conversation_id, sender_id, recipient_id, content, created_at,
                delivery_status, delivered_at, read_at
           FROM messages WHERE id = $1 LIMIT 1`,
        [message.id]
      );
      return { message: normalizeMessage(existing.rows[0]), inserted: false };
    } catch (err) {
      handleDbError(err, 'insertMessage');
    }
  }

  const existing = memory.messages.get(message.id);
  if (existing) return { message: normalizeMessage(existing), inserted: false };
  const created = {
    id: message.id,
    conversation_id: message.conversationId,
    sender_id: message.senderId,
    recipient_id: message.recipientId,
    content: message.content,
    created_at: new Date(),
    delivery_status: 'sent',
    delivered_at: null,
    read_at: null
  };
  memory.messages.set(created.id, created);
  return { message: normalizeMessage(created), inserted: true };
}

async function pendingMessages(recipientId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        `SELECT id, conversation_id, sender_id, recipient_id, content, created_at,
                delivery_status, delivered_at, read_at
           FROM messages
          WHERE recipient_id = $1 AND delivery_status = 'sent'
          ORDER BY created_at ASC
          LIMIT 500`,
        [recipientId]
      );
      return result.rows.map(normalizeMessage);
    } catch (err) {
      handleDbError(err, 'pendingMessages');
    }
  }

  return [...memory.messages.values()]
    .filter((message) => message.recipient_id === recipientId && message.delivery_status === 'sent')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(normalizeMessage);
}

async function markDelivered(messageId, recipientId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query(
        `UPDATE messages
            SET delivery_status = 'delivered', delivered_at = now()
          WHERE id = $1 AND recipient_id = $2 AND delivery_status = 'sent'
          RETURNING id, conversation_id, sender_id, recipient_id, content, created_at,
                    delivery_status, delivered_at, read_at`,
        [messageId, recipientId]
      );
      if (result.rows[0]) return normalizeMessage(result.rows[0]);
    } catch (err) {
      handleDbError(err, 'markDelivered');
    }
  }

  const message = memory.messages.get(messageId);
  if (!message || message.recipient_id !== recipientId || message.delivery_status !== 'sent') return null;
  message.delivery_status = 'delivered';
  message.delivered_at = new Date();
  return normalizeMessage(message);
}

async function markRead(conversationId, recipientId, messageIds = []) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const values = [conversationId, recipientId];
      let idFilter = '';
      if (messageIds.length) {
        values.push(messageIds);
        idFilter = ' AND id = ANY($3::uuid[])';
      }
      const result = await pool.query(
        `UPDATE messages
            SET delivery_status = 'read', read_at = now()
          WHERE conversation_id = $1 AND recipient_id = $2
            AND delivery_status <> 'read'${idFilter}
          RETURNING id, conversation_id, sender_id, recipient_id, content, created_at,
                    delivery_status, delivered_at, read_at`,
        values
      );
      return result.rows.map(normalizeMessage);
    } catch (err) {
      handleDbError(err, 'markRead');
    }
  }

  const updated = [];
  for (const message of memory.messages.values()) {
    const selected = message.conversation_id === conversationId && message.recipient_id === recipientId &&
      (!messageIds.length || messageIds.includes(message.id));
    if (selected && message.delivery_status !== 'read') {
      message.delivery_status = 'read';
      message.read_at = new Date();
      updated.push(normalizeMessage(message));
    }
  }
  return updated;
}

async function updateLastSeen(userId) {
  if (pool && !pgDisabled) {
    try {
      await ensureSchema();
      const result = await pool.query('UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at', [userId]);
      if (result.rows[0]) return iso(result.rows[0].last_seen_at);
    } catch (err) {
      handleDbError(err, 'updateLastSeen');
    }
  }
  const user = memory.users.get(userId);
  if (!user) return null;
  user.last_seen_at = new Date();
  return iso(user.last_seen_at);
}

async function close() {
  if (pool) {
    try {
      await pool.end();
    } catch {}
  }
}

module.exports = {
  close,
  createOrGetConversation,
  createUser,
  ensureSchema,
  findUserByEmail,
  findUserById,
  health,
  insertMessage,
  listConversations,
  listMessages,
  listUsers,
  markDelivered,
  markRead,
  mode,
  pendingMessages,
  updateLastSeen,
  validateDatabaseConfig,
  userIsParticipant
};
