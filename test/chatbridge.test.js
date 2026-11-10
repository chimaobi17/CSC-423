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

async function makeUser(prefix) {
  const stamp = unique(prefix);
  const password = 'S3curepass';
  const account = { username: stamp, email: `${stamp}@example.com`, password };
  const registered = await request('/api/register', { method: 'POST', body: JSON.stringify(account) });
  const login = await request('/api/login', { method: 'POST', body: JSON.stringify({ email: account.email, password }) });
  return { id: registered.body.id, username: account.username, token: login.body.token };
}

async function startChat(a, b) {
  const conversation = await request('/api/conversations', {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ other_user_id: b.id })
  });
  return conversation.body.conversation_id;
}

async function open(user) {
  const socket = connect(user.token);
  await waitForMessage(socket, (event) => event.type === 'connection_established');
  return socket;
}

function sendChat(socket, conversationId, recipientId, content) {
  const messageId = crypto.randomUUID();
  socket.send(JSON.stringify({ type: 'chat_message', message_id: messageId, conversation_id: conversationId, recipient_id: recipientId, content }));
  return messageId;
}

test('one user can be signed in on several devices and all of them stay in sync', async () => {
  const [alice, bob] = await Promise.all([makeUser('alice'), makeUser('bob')]);
  const conversationId = await startChat(alice, bob);

  const alicePhone = await open(alice);
  const aliceLaptop = await open(alice);
  const bobPhone = await open(bob);

  // Opening a second device must not kick the first one off.
  assert.equal(alicePhone.readyState, WebSocket.OPEN);

  // Both of Bob's devices receive the message; Alice's other device gets an echo.
  const bobLaptop = await open(bob);
  const toBobPhone = waitForMessage(bobPhone, (event) => event.type === 'chat_message');
  const toBobLaptop = waitForMessage(bobLaptop, (event) => event.type === 'chat_message');
  const echo = waitForMessage(aliceLaptop, (event) => event.type === 'chat_message' && event.echo === true);
  const ack = waitForMessage(alicePhone, (event) => event.type === 'message_ack');
  const messageId = sendChat(alicePhone, conversationId, bob.id, 'hi from my phone');
  const [phoneEvent, laptopEvent, echoEvent] = await Promise.all([toBobPhone, toBobLaptop, echo, ack]);
  assert.equal(phoneEvent.message_id, messageId);
  assert.equal(laptopEvent.content, 'hi from my phone');
  assert.equal(echoEvent.sender_id, alice.id);

  // Unread count is reported to Bob; reading on one device clears it on the other.
  const listed = await request('/api/conversations', { headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(listed.body.conversations[0].unread_count, 1);
  assert.equal(listed.body.conversations[0].last_message, 'hi from my phone');
  assert.equal(listed.body.conversations[0].last_message_sender_id, alice.id);

  const syncedRead = waitForMessage(bobLaptop, (event) => event.type === 'conversation_read');
  const aliceSeesRead = waitForMessage(alicePhone, (event) => event.type === 'message_read');
  const aliceLaptopSeesRead = waitForMessage(aliceLaptop, (event) => event.type === 'message_read');
  bobPhone.send(JSON.stringify({ type: 'message_read', conversation_id: conversationId, message_ids: [messageId] }));
  await Promise.all([syncedRead, aliceSeesRead, aliceLaptopSeesRead]);

  const after = await request('/api/conversations', { headers: { authorization: `Bearer ${bob.token}` } });
  assert.equal(after.body.conversations[0].unread_count, 0);

  await Promise.all([alicePhone, aliceLaptop, bobPhone, bobLaptop].map(closeAndWait));
});

test('presence snapshot, typing indicator, and last seen', async () => {
  const [carol, dave] = await Promise.all([makeUser('carol'), makeUser('dave')]);
  const conversationId = await startChat(carol, dave);

  const carolSocket = await open(carol);
  const daveSocket = connect(dave.token);
  const snapshotPromise = waitForMessage(daveSocket, (event) => event.type === 'presence_snapshot');
  const snapshot = await snapshotPromise;
  assert.ok(snapshot.online_user_ids.includes(carol.id));

  const typing = waitForMessage(daveSocket, (event) => event.type === 'typing');
  carolSocket.send(JSON.stringify({ type: 'typing', conversation_id: conversationId, recipient_id: dave.id, is_typing: true }));
  const typingEvent = await typing;
  assert.equal(typingEvent.user_id, carol.id);
  assert.equal(typingEvent.is_typing, true);

  const offline = waitForMessage(daveSocket, (event) => event.type === 'user_offline' && event.user_id === carol.id);
  await closeAndWait(carolSocket);
  const offlineEvent = await offline;
  assert.ok(offlineEvent.last_seen);

  const users = await request('/api/users', { headers: { authorization: `Bearer ${dave.token}` } });
  const carolRow = users.body.users.find((user) => user.id === carol.id);
  assert.ok(carolRow.last_seen_at, 'last_seen_at is stored when the last device disconnects');

  await closeAndWait(daveSocket);
});

test('a retried message is acknowledged but delivered only once', async () => {
  const [erin, frank] = await Promise.all([makeUser('erin'), makeUser('frank')]);
  const conversationId = await startChat(erin, frank);
  const erinSocket = await open(erin);
  const frankSocket = await open(frank);

  const received = [];
  frankSocket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'chat_message') received.push(event);
  });
  const messageId = crypto.randomUUID();
  const payload = { type: 'chat_message', message_id: messageId, conversation_id: conversationId, recipient_id: frank.id, content: 'only once' };
  erinSocket.send(JSON.stringify(payload));
  await waitForMessage(erinSocket, (event) => event.type === 'message_ack');
  erinSocket.send(JSON.stringify(payload));
  await waitForMessage(erinSocket, (event) => event.type === 'message_ack');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.length, 1);

  await Promise.all([closeAndWait(erinSocket), closeAndWait(frankSocket)]);
});
