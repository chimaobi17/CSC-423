const { WebSocketServer, WebSocket } = require('ws');
const { verifyToken } = require('./auth');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 1000;

function createWebSocketServer(httpServer, { db }) {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map();
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const isProduction = process.env.NODE_ENV === 'production';

  function send(socket, event) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }

  function broadcast(event, exceptUserId) {
    for (const [userId, socket] of connections) {
      if (userId !== exceptUserId) send(socket, event);
    }
  }

  function removeConnection(userId, socket) {
    if (connections.get(userId) !== socket) return false;
    connections.delete(userId);
    broadcast({ type: 'user_offline', user_id: userId, last_seen: new Date().toISOString() }, userId);
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

  async function handleEvent(socket, event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return errorEvent(socket, 'Message must be a JSON object with a type field');
    }

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
      if (recipientId === socket.user.userId || !(await db.findUserById(recipientId))) {
        return errorEvent(socket, 'Recipient does not exist', messageId);
      }
      if (!(await db.userIsParticipant(conversationId, socket.user.userId)) ||
          !(await db.userIsParticipant(conversationId, recipientId))) {
        return errorEvent(socket, 'You are not a participant in this conversation', messageId);
      }

      const { message } = await db.insertMessage({
        id: messageId,
        conversationId,
        senderId: socket.user.userId,
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

      const recipientSocket = connections.get(recipientId);
      if (recipientSocket) {
        send(recipientSocket, {
          type: 'chat_message',
          message_id: message.id,
          conversation_id: message.conversation_id,
          sender_id: message.sender_id,
          recipient_id: message.recipient_id,
          content: message.content,
          timestamp: message.created_at,
          status: message.delivery_status
        });
      }
      return;
    }

    if (event.type === 'message_delivered') {
      if (!UUID_PATTERN.test(event.message_id || '')) return errorEvent(socket, 'Invalid message ID');
      const message = await db.markDelivered(event.message_id, socket.user.userId);
      if (message) {
        send(connections.get(message.sender_id), {
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
      const updated = await db.markRead(conversationId, socket.user.userId, messageIds);
      const bySender = new Map();
      for (const message of updated) {
        if (!bySender.has(message.sender_id)) bySender.set(message.sender_id, []);
        bySender.get(message.sender_id).push(message.id);
      }
      for (const [senderId, ids] of bySender) {
        send(connections.get(senderId), {
          type: 'message_read',
          conversation_id: conversationId,
          message_ids: ids,
          status: 'read'
        });
      }
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
    const expectedOrigin = allowedOrigin || (isProduction ? originForRequest(request) : '');
    const originAllowed = expectedOrigin ? origin === expectedOrigin || (!isProduction && !origin) : !isProduction;
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
    const previous = connections.get(user.userId);
    if (previous && previous !== socket) previous.close(4000, 'Replaced by a newer connection');
    connections.set(user.userId, socket);
    console.log(JSON.stringify({ severity: 'INFO', event: 'ws_connect', userId: user.userId }));
    send(socket, { type: 'connection_established', user_id: user.userId, server_time: new Date().toISOString() });
    broadcast({ type: 'user_online', user_id: user.userId }, user.userId);

    db.pendingMessages(user.userId).then((messages) => {
      for (const message of messages) {
        send(socket, {
          type: 'chat_message',
          message_id: message.id,
          conversation_id: message.conversation_id,
          sender_id: message.sender_id,
          recipient_id: message.recipient_id,
          content: message.content,
          timestamp: message.created_at,
          status: message.delivery_status,
          pending: true
        });
      }
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
    for (const [userId, socket] of connections) {
      if (socket.isAlive === false) {
        removeConnection(userId, socket);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 25_000);
  heartbeat.unref();

  return { connections, wss };
}

module.exports = { createWebSocketServer };
