const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const WebSocket = require('ws');
const { httpServer } = require('../server');
const db = require('../src/db');

let baseUrl;
let wsUrl;

function unique(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function waitForMessage(socket, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket event'));
    }, timeout);
    function onMessage(raw) {
      const event = JSON.parse(raw.toString());
      if (!predicate(event)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(event);
    }
    socket.on('message', onMessage);
  });
}

function waitForClose(socket, timeout = 5000) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(1000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close')), timeout);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function connect(token) {
  return new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
}

function closeAndWait(socket) {
  const closed = waitForClose(socket);
  if (socket.readyState !== WebSocket.CLOSED) socket.close();
  return closed;
}

before(async () => {
  await db.ensureSchema();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await db.close();
});

test('health, registration, duplicate protection, login, and authorization', async () => {
  const stamp = unique('test');
  const password = 'S3curepass';
  const account = {
    username: `${stamp}a`,
    email: `${stamp}a@example.com`,
    password
  };

  const health = await request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const registered = await request('/api/register', {
    method: 'POST',
    body: JSON.stringify(account)
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.username, account.username);

  const duplicate = await request('/api/register', {
    method: 'POST',
    body: JSON.stringify(account)
  });
  assert.equal(duplicate.response.status, 409);

  const unauthorized = await request('/api/users');
  assert.equal(unauthorized.response.status, 401);

  const loggedIn = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, password })
  });
  assert.equal(loggedIn.response.status, 200);
  assert.ok(loggedIn.body.token);

  const users = await request('/api/users', {
    headers: { authorization: `Bearer ${loggedIn.body.token}` }
  });
  assert.equal(users.response.status, 200);
  assert.ok(Array.isArray(users.body.users));
});

test('two authenticated sockets exchange, persist, and replay an offline message', async () => {
  const stamp = unique('chat');
  const password = 'S3curepass';
  const accountA = { username: `${stamp}a`, email: `${stamp}a@example.com`, password };
  const accountB = { username: `${stamp}b`, email: `${stamp}b@example.com`, password };
  const registeredA = await request('/api/register', { method: 'POST', body: JSON.stringify(accountA) });
  const registeredB = await request('/api/register', { method: 'POST', body: JSON.stringify(accountB) });
  const loginA = await request('/api/login', { method: 'POST', body: JSON.stringify({ email: accountA.email, password }) });
  const loginB = await request('/api/login', { method: 'POST', body: JSON.stringify({ email: accountB.email, password }) });
  const conversation = await request('/api/conversations', {
    method: 'POST',
    headers: { authorization: `Bearer ${loginA.body.token}` },
    body: JSON.stringify({ other_user_id: registeredB.body.id })
  });
  assert.equal(conversation.response.status, 200);
  const conversationId = conversation.body.conversation_id;

  const socketA = connect(loginA.body.token);
  const socketB = connect(loginB.body.token);
  await Promise.all([
    waitForMessage(socketA, (event) => event.type === 'connection_established'),
    waitForMessage(socketB, (event) => event.type === 'connection_established')
  ]);

  const onlineMessageId = crypto.randomUUID();
  socketA.send(JSON.stringify({
    type: 'chat_message',
    message_id: onlineMessageId,
    conversation_id: conversationId,
    recipient_id: registeredB.body.id,
    content: 'Online delivery check'
  }));
  const [ack, received] = await Promise.all([
    waitForMessage(socketA, (event) => event.type === 'message_ack' && event.message_id === onlineMessageId),
    waitForMessage(socketB, (event) => event.type === 'chat_message' && event.message_id === onlineMessageId)
  ]);
  assert.equal(ack.status, 'sent');
  assert.equal(received.content, 'Online delivery check');
  socketB.send(JSON.stringify({ type: 'message_delivered', message_id: onlineMessageId }));
  const delivered = await waitForMessage(socketA, (event) => event.type === 'message_delivered' && event.message_id === onlineMessageId);
  assert.equal(delivered.status, 'delivered');

  await closeAndWait(socketB);
  const offlineMessageId = crypto.randomUUID();
  socketA.send(JSON.stringify({
    type: 'chat_message',
    message_id: offlineMessageId,
    conversation_id: conversationId,
    recipient_id: registeredB.body.id,
    content: 'Offline replay check'
  }));
  const offlineAck = await waitForMessage(socketA, (event) => event.type === 'message_ack' && event.message_id === offlineMessageId);
  assert.equal(offlineAck.status, 'sent');

  const socketBReconnected = connect(loginB.body.token);
  const pendingPromise = waitForMessage(
    socketBReconnected,
    (event) => event.type === 'chat_message' && event.message_id === offlineMessageId
  );
  await waitForMessage(socketBReconnected, (event) => event.type === 'connection_established');
  const pending = await pendingPromise;
  assert.equal(pending.pending, true);
  assert.equal(pending.content, 'Offline replay check');
  socketBReconnected.send(JSON.stringify({ type: 'message_delivered', message_id: offlineMessageId }));

  const history = await request(`/api/conversations/${conversationId}/messages?limit=50`, {
    headers: { authorization: `Bearer ${loginA.body.token}` }
  });
  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages.length, 2);
  assert.deepEqual(history.body.messages.map((message) => message.id), [onlineMessageId, offlineMessageId]);

  await Promise.all([closeAndWait(socketA), closeAndWait(socketBReconnected)]);
});

test('invalid WebSocket tokens are rejected with close code 4401', async () => {
  const socket = connect('not-a-valid-token');
  const closeCode = await waitForClose(socket);
  assert.equal(closeCode, 4401);
});
