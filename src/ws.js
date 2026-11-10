const { WebSocketServer, WebSocket } = require('ws');
const { verifyToken } = require('./auth');
const { allowedOrigins, explicitOrigins } = require('./origins');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_DEVICES_PER_USER = 5;

function createWebSocketServer(httpServer, { db }) {
  const wss = new WebSocketServer({ noServer: true });
  // userId -> Set<socket>. One user can be signed in on several devices at once.
  const connections = new Map();
  const isProduction = process.env.NODE_ENV === 'production';

  function send(socket, event) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  function sendToUser(userId, event, exceptSocket) {
    for (const socket of connections.get(userId) || []) {
      if (socket !== exceptSocket) send(socket, event);
    }
  }

  function broadcast(event, exceptUserId) {
    for (const userId of connections.keys()) {
      if (userId !== exceptUserId) sendToUser(userId, event);
    }
  }

  function addConnection(userId, socket) {
    let sockets = connections.get(userId);
    const firstDevice = !sockets;
    if (!sockets) {
      sockets = new Set();
      connections.set(userId, sockets);
    }
    sockets.add(socket);
    while (sockets.size > MAX_DEVICES_PER_USER) {
      const oldest = sockets.values().next().value;
      sockets.delete(oldest);
      oldest.close(4000, 'Too many devices');
    }
    return firstDevice;
  }

  function removeConnection(userId, socket) {
    const sockets = connections.get(userId);
    if (!sockets || !sockets.delete(socket)) return false;
    if (sockets.size > 0) return true;
    connections.delete(userId);
    const lastSeen = new Date().toISOString();
    broadcast({ type: 'user_offline', user_id: userId, last_seen: lastSeen }, userId);
    db.updateLastSeen(userId).catch(() => {});
    return true;
  }

  function errorEvent(socket, message, refMessageId) {
    send(socket, { type: 'error', code: 'INVALID_PAYLOAD', message, ...(refMessageId ? { ref_message_id: refMessageId } : {}) });
  }

  function originForRequest(request) {
    const protocol = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = request.headers.host;
    return host ? `${protocol}://${host}` : '';
  }

  function chatPayload(message, extra = {}) {
    return {
      type: 'chat_message',
      message_id: message.id,
      conversation_id: message.conversation_id,
      sender_id: message.sender_id,
      recipient_id: message.recipient_id,
      content: message.content,
      timestamp: message.created_at,
      status: message.delivery_status,
      ...extra
    };
  }

  async function handleEvent(socket, event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return errorEvent(socket, 'Message must be a JSON object with a type field');
    }
    const me = socket.user.userId;

    if (event.type === 'chat_message') {
      const messageId = typeof event.message_id === 'string' ? event.message_id : '';
      const conversationId = typeof event.conversation_id === 'string' ? event.conversation_id : '';
      const recipientId = typeof event.recipient_id === 'string' ? event.recipient_id : '';
      const content = typeof event.content === 'string' ? event.content.trim() : '';
      if (!UUID_PATTERN.test(messageId) || !UUID_PATTERN.test(conversationId) || !UUID_PATTERN.test(recipientId)) {
        return errorEvent(socket, 'Message, conversation, and recipient IDs must be UUIDs', messageId);
      }
      if (!content || content.length > MAX_MESSAGE_LENGTH) {
        return errorEvent(socket, 'Message content must be 1–1,000 characters', messageId);
      }
      if (recipientId === me || !(await db.findUserById(recipientId))) {
        return errorEvent(socket, 'Recipient does not exist', messageId);
      }
      if (!(await db.userIsParticipant(conversationId, me)) ||
          !(await db.userIsParticipant(conversationId, recipientId))) {
        return errorEvent(socket, 'You are not a participant in this conversation', messageId);
      }

      const { message, inserted } = await db.insertMessage({
        id: messageId,
        conversationId,
        senderId: me,
        recipientId,
        content
      });
      send(socket, {
        type: 'message_ack',
        message_id: message.id,
        conversation_id: message.conversation_id,
        status: message.delivery_status,
        created_at: message.created_at
      });

      // A retry of an already-stored message is acknowledged but not forwarded twice.
      if (inserted) {
        sendToUser(recipientId, chatPayload(message));
        // Keep the sender's other devices in sync with what they just sent.
        sendToUser(me, chatPayload(message, { echo: true }), socket);
      }
      return;
    }

    if (event.type === 'message_delivered') {
      if (!UUID_PATTERN.test(event.message_id || '')) return errorEvent(socket, 'Invalid message ID');
      const message = await db.markDelivered(event.message_id, me);
      if (message) {
        sendToUser(message.sender_id, {
          type: 'message_delivered',
          message_id: message.id,
          conversation_id: message.conversation_id,
          status: message.delivery_status
        });
      }
      return;
    }

    if (event.type === 'message_read') {
      const conversationId = event.conversation_id;
      const messageIds = Array.isArray(event.message_ids) ? event.message_ids.slice(0, 100) : [];
      if (!UUID_PATTERN.test(conversationId) || messageIds.some((id) => !UUID_PATTERN.test(id))) {
        return errorEvent(socket, 'Invalid conversation or message IDs');
      }
      const updated = await db.markRead(conversationId, me, messageIds);
      const bySender = new Map();
      for (const message of updated) {
        if (!bySender.has(message.sender_id)) bySender.set(message.sender_id, []);
        bySender.get(message.sender_id).push(message.id);
      }
      for (const [senderId, ids] of bySender) {
        sendToUser(senderId, {
          type: 'message_read',
          conversation_id: conversationId,
          message_ids: ids,
          status: 'read'
        });
      }
      // The reader's other devices should clear their unread badge too.
      if (updated.length) {
        sendToUser(me, {
          type: 'conversation_read',
          conversation_id: conversationId,
          message_ids: updated.map((message) => message.id)
        }, socket);
      }
      return;
    }

    if (event.type === 'typing') {
      const conversationId = typeof event.conversation_id === 'string' ? event.conversation_id : '';
      const recipientId = typeof event.recipient_id === 'string' ? event.recipient_id : '';
      if (!UUID_PATTERN.test(conversationId) || !UUID_PATTERN.test(recipientId) || recipientId === me) return;
      if (!connections.has(recipientId)) return;
      if (!(await db.userIsParticipant(conversationId, me)) ||
          !(await db.userIsParticipant(conversationId, recipientId))) return;
      sendToUser(recipientId, {
        type: 'typing',
        conversation_id: conversationId,
        user_id: me,
        is_typing: Boolean(event.is_typing)
      });
      return;
    }

    if (event.type === 'reconnect' || event.type === 'ping') {
      return send(socket, { type: 'pong', server_time: new Date().toISOString() });
    }

    return errorEvent(socket, `Unknown event type: ${event.type}`);
  }

  httpServer.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const explicit = explicitOrigins();
    const permitted = [...allowedOrigins(), ...(isProduction ? [originForRequest(request)] : [])];
    const originAllowed = !isProduction && explicit.length === 0
      ? true
      : permitted.includes(origin) || (!isProduction && !origin);
    if (!originAllowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let user;
    try {
      const token = url.searchParams.get('token');
      user = token ? verifyToken(token) : null;
      if (!user?.userId) throw new Error('missing token');
    } catch {
      wss.handleUpgrade(request, socket, head, (ws) => ws.close(4401, 'Unauthorized'));
      console.warn(JSON.stringify({ severity: 'WARNING', event: 'ws_auth_failed' }));
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, user);
    });
  });

  wss.on('connection', (socket, _request, user) => {
    socket.user = user;
    socket.isAlive = true;
    const firstDevice = addConnection(user.userId, socket);
    console.log(JSON.stringify({ severity: 'INFO', event: 'ws_connect', userId: user.userId }));
    send(socket, { type: 'connection_established', user_id: user.userId, server_time: new Date().toISOString() });
    send(socket, {
      type: 'presence_snapshot',
      online_user_ids: [...connections.keys()].filter((id) => id !== user.userId)
    });
    if (firstDevice) broadcast({ type: 'user_online', user_id: user.userId }, user.userId);

    db.pendingMessages(user.userId).then((messages) => {
      for (const message of messages) send(socket, chatPayload(message, { pending: true }));
    }).catch((error) => {
      console.error(JSON.stringify({ severity: 'ERROR', event: 'pending_delivery_failed', userId: user.userId, code: error.code }));
    });

    let windowStarted = Date.now();
    let eventCount = 0;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', async (raw) => {
      if (Date.now() - windowStarted >= 1000) {
        windowStarted = Date.now();
        eventCount = 0;
      }
      eventCount += 1;
      if (eventCount > 10) return errorEvent(socket, 'Message rate limit exceeded; try again shortly');
      try {
        await handleEvent(socket, JSON.parse(raw.toString()));
      } catch (error) {
        console.error(JSON.stringify({ severity: 'ERROR', event: 'ws_event_failed', userId: user.userId, code: error.code }));
        errorEvent(socket, 'Unable to process that message');
      }
    });
    socket.on('error', (error) => {
      console.error(JSON.stringify({ severity: 'ERROR', event: 'ws_error', userId: user.userId, message: error.message }));
      removeConnection(user.userId, socket);
    });
    socket.on('close', () => {
      removeConnection(user.userId, socket);
      console.log(JSON.stringify({ severity: 'INFO', event: 'ws_close', userId: user.userId }));
    });
  });

  const heartbeat = setInterval(() => {
    for (const [userId, sockets] of [...connections]) {
      for (const socket of [...sockets]) {
        if (socket.isAlive === false) {
          removeConnection(userId, socket);
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, 25_000);
  heartbeat.unref();

  return { connections, wss };
}

module.exports = { createWebSocketServer };
