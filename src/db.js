const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const schemaPath = path.join(__dirname, '..', 'schema.sql');
const databaseUrlIsPostgres = /^postgres(?:ql)?:/i.test(process.env.DATABASE_URL || '');
const usePostgres = Boolean(
  databaseUrlIsPostgres ||
  (process.env.DB_USER && process.env.DB_NAME && (process.env.DB_HOST || process.env.INSTANCE_CONNECTION_NAME))
);

const pool = usePostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      host: process.env.DB_HOST || (
        process.env.INSTANCE_CONNECTION_NAME
          ? `${process.env.DB_SOCKET_DIR || '/cloudsql'}/${process.env.INSTANCE_CONNECTION_NAME}`
          : undefined
      ),
      max: 5,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    })
  : null;

const memory = {
  users: new Map(),
  emailToId: new Map(),
  conversations: new Map(),
  messages: new Map()
};

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    created_at: iso(row.created_at)
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
  return usePostgres ? 'postgres' : 'memory-development';
}

async function ensureSchema() {
  if (!pool) return;
  const schema = await fs.readFile(schemaPath, 'utf8');
  await pool.query(schema);
}

async function health() {
  if (!pool) return { mode: mode() };
  await pool.query('SELECT 1');
  return { mode: mode() };
}

async function findUserByEmail(email) {
  if (!pool) {
    const id = memory.emailToId.get(email.toLowerCase());
    return id ? memory.users.get(id) : null;
  }
  const result = await pool.query(
    'SELECT id, username, email, created_at, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [email]
  );
  return result.rows[0] || null;
}

async function findUserById(id) {
  if (!pool) return normalizeUser(memory.users.get(id));
  const result = await pool.query(
    'SELECT id, username, email, created_at FROM users WHERE id = $1 LIMIT 1',
    [id]
  );
  return normalizeUser(result.rows[0]);
}

async function createUser({ id, username, email, passwordHash }) {
  if (!pool) {
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

  const result = await pool.query(
    `INSERT INTO users (id, username, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, created_at`,
    [id, username, email.toLowerCase(), passwordHash]
  );
  return normalizeUser(result.rows[0]);
}

async function listUsers(excludeId) {
  if (!pool) {
    return [...memory.users.values()]
      .filter((user) => user.id !== excludeId)
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(normalizeUser);
  }
  const result = await pool.query(
    'SELECT id, username, created_at FROM users WHERE id <> $1 ORDER BY username ASC LIMIT 500',
    [excludeId]
  );
  return result.rows.map(normalizeUser);
}

function memoryConversationFor(userId, otherUserId) {
  return [...memory.conversations.values()].find(
    (conversation) => conversation.participants.has(userId) && conversation.participants.has(otherUserId)
  );
}

async function createOrGetConversation(userId, otherUserId) {
  if (!pool) {
    let conversation = memoryConversationFor(userId, otherUserId);
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), created_at: new Date(), participants: new Set([userId, otherUserId]) };
      memory.conversations.set(conversation.id, conversation);
    }
    return { id: conversation.id, created_at: iso(conversation.created_at) };
  }

  const existing = await pool.query(
    `SELECT c.id, c.created_at
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id
      WHERE cp.user_id = ANY($1::uuid[])
      GROUP BY c.id, c.created_at
     HAVING COUNT(DISTINCT cp.user_id) = 2
      LIMIT 1`,
    [[userId, otherUserId]]
  );
  if (existing.rows[0]) return existing.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
}

async function userIsParticipant(conversationId, userId) {
  if (!pool) return Boolean(memory.conversations.get(conversationId)?.participants.has(userId));
  const result = await pool.query(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
    [conversationId, userId]
  );
  return result.rowCount > 0;
}

async function listConversations(userId) {
  if (!pool) {
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
          last_message: messages[0]?.content || 'No messages yet',
          last_message_at: iso(messages[0]?.created_at || conversation.created_at)
        };
      })
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
  }

  const result = await pool.query(
    `SELECT c.id, c.created_at, peer.id AS peer_id, peer.username AS peer_username,
            last_message.content AS last_message, last_message.created_at AS last_message_at
       FROM conversations c
       JOIN conversation_participants mine ON mine.conversation_id = c.id AND mine.user_id = $1
       JOIN conversation_participants other ON other.conversation_id = c.id AND other.user_id <> $1
       JOIN users peer ON peer.id = other.user_id
       LEFT JOIN LATERAL (
         SELECT content, created_at FROM messages WHERE conversation_id = c.id
         ORDER BY created_at DESC LIMIT 1
       ) last_message ON true
      ORDER BY COALESCE(last_message.created_at, c.created_at) DESC
      LIMIT 200`,
    [userId]
  );
  return result.rows.map((row) => ({ ...row, created_at: iso(row.created_at), last_message_at: iso(row.last_message_at) }));
}

async function listMessages(conversationId, userId, { limit = 50, before } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  if (!pool) {
    return [...memory.messages.values()]
      .filter((message) => message.conversation_id === conversationId)
      .filter((message) => !before || new Date(message.created_at) < new Date(before))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .slice(-safeLimit)
      .map(normalizeMessage);
  }
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
}

async function insertMessage(message) {
  if (!pool) {
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
}

async function pendingMessages(recipientId) {
  if (!pool) {
    return [...memory.messages.values()]
      .filter((message) => message.recipient_id === recipientId && message.delivery_status === 'sent')
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(normalizeMessage);
  }
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
}

async function markDelivered(messageId, recipientId) {
  if (!pool) {
    const message = memory.messages.get(messageId);
    if (!message || message.recipient_id !== recipientId || message.delivery_status !== 'sent') return null;
    message.delivery_status = 'delivered';
    message.delivered_at = new Date();
    return normalizeMessage(message);
  }
  const result = await pool.query(
    `UPDATE messages
        SET delivery_status = 'delivered', delivered_at = now()
      WHERE id = $1 AND recipient_id = $2 AND delivery_status = 'sent'
      RETURNING id, conversation_id, sender_id, recipient_id, content, created_at,
                delivery_status, delivered_at, read_at`,
    [messageId, recipientId]
  );
  return normalizeMessage(result.rows[0]);
}

async function markRead(conversationId, recipientId, messageIds = []) {
  if (!pool) {
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
}

async function close() {
  if (pool) await pool.end();
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
  userIsParticipant
};
