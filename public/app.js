const state = {
  token: localStorage.getItem('chatbridge_token'),
  user: JSON.parse(localStorage.getItem('chatbridge_user') || 'null'),
  socket: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  intentionalClose: false,
  activeConversation: null,
  messages: [],
  users: [],
  conversations: [],
  outbox: JSON.parse(localStorage.getItem('chatbridge_outbox') || '[]'),
  onlineUsers: new Set()
};

const views = ['login', 'register', 'dashboard', 'conversation'];
const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => {
  const url = `${window.location.origin}/api${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
};

function saveSession() {
  if (state.token) localStorage.setItem('chatbridge_token', state.token);
  else localStorage.removeItem('chatbridge_token');
  if (state.user) localStorage.setItem('chatbridge_user', JSON.stringify(state.user));
  else localStorage.removeItem('chatbridge_user');
}

function saveOutbox() {
  localStorage.setItem('chatbridge_outbox', JSON.stringify(state.outbox.slice(-100)));
}

function setConnectionStatus(status) {
  const pill = $('#connection-pill');
  const label = $('#connection-label');
  pill.className = `connection-pill ${status.toLowerCase()}`;
  label.textContent = status;
}

function currentRoute() {
  const raw = window.location.hash.replace(/^#/, '') || (state.token ? 'dashboard' : 'login');
  const [view, id] = raw.split('/');
  return { view: views.includes(view) ? view : 'login', id };
}

function showView(view) {
  for (const name of views) $(`#view-${name}`).hidden = name !== view;
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function messageById(id) {
  return state.messages.find((message) => message.id === id);
}

function upsertMessage(message) {
  const normalized = {
    id: message.id || message.message_id,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
    recipient_id: message.recipient_id,
    content: message.content,
    created_at: message.created_at || message.timestamp,
    delivery_status: message.delivery_status || message.status || 'sent'
  };
  const existing = messageById(normalized.id);
  if (existing) Object.assign(existing, normalized);
  else state.messages.push(normalized);
  state.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function tickMarkup(status) {
  if (status === 'read') return '<span class="ticks read">✓✓</span>';
  if (status === 'delivered') return '<span class="ticks">✓✓</span>';
  return '<span class="ticks">✓</span>';
}

function renderMessages() {
  const list = $('#message-list');
  const current = state.activeConversation;
  if (!current) return;
  const messages = state.messages.filter((message) => message.conversation_id === current.id);
  if (!messages.length) {
    list.innerHTML = '<div class="empty-state">No messages yet. Send the first signal.</div>';
    return;
  }
  list.replaceChildren(...messages.map((message) => {
    const row = document.createElement('div');
    row.className = `message-row ${message.sender_id === state.user.id ? 'mine' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = message.content;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.innerHTML = `<span>${formatTime(message.created_at)}</span>${message.sender_id === state.user.id ? tickMarkup(message.delivery_status) : ''}`;
    row.append(bubble, meta);
    return row;
  }));
  list.scrollTop = list.scrollHeight;
}

function renderUsers() {
  const list = $('#user-list');
  if (!state.users.length) {
    list.innerHTML = '<div class="empty-state">No other users yet. Open a second browser to create a conversation.</div>';
    return;
  }
  list.replaceChildren(...state.users.map((user) => {
    const button = document.createElement('button');
    button.className = 'user-card';
    button.type = 'button';
    const details = document.createElement('span');
    const username = document.createElement('strong');
    username.textContent = user.username;
    const availability = document.createElement('small');
    availability.textContent = state.onlineUsers.has(user.id) ? 'ONLINE NOW' : 'AVAILABLE TO MESSAGE';
    details.append(username, availability);
    const arrow = document.createElement('span');
    arrow.className = 'user-arrow';
    arrow.textContent = '→';
    button.append(details, arrow);
    button.addEventListener('click', () => openConversation(user));
    return button;
  }));
}

function renderConversations() {
  const list = $('#conversation-list');
  if (!state.conversations.length) {
    list.innerHTML = '<div class="empty-state">Your recent channels will appear here.</div>';
    return;
  }
  list.replaceChildren(...state.conversations.map((conversation) => {
    const button = document.createElement('button');
    button.className = 'conversation-card';
    button.type = 'button';
    const details = document.createElement('span');
    const username = document.createElement('strong');
    username.textContent = conversation.peer_username;
    const preview = document.createElement('span');
    preview.className = 'preview';
    preview.textContent = conversation.last_message || 'No messages yet';
    details.append(username, preview);
    const date = document.createElement('small');
    date.textContent = formatDate(conversation.last_message_at);
    button.append(details, date);
    button.addEventListener('click', () => openConversation({ id: conversation.peer_id, username: conversation.peer_username }));
    return button;
  }));
}

async function loadDashboard() {
  $('#dashboard-greeting').textContent = `Hi, ${state.user.username}`;
  $('#dashboard-email').textContent = state.user.email || '';
  try {
    const [users, conversations] = await Promise.all([api('/users'), api('/conversations')]);
    state.users = users.users;
    state.conversations = conversations.conversations;
    renderUsers();
    renderConversations();
  } catch (error) {
    $('#dashboard-error').textContent = error.message;
  }
}

async function openConversation(user) {
  try {
    const result = await api('/conversations', { method: 'POST', body: JSON.stringify({ other_user_id: user.id }) });
    const history = await api(`/conversations/${result.conversation_id}/messages?limit=100`);
    state.activeConversation = { id: result.conversation_id, peer_id: user.id, peer_username: user.username };
    state.messages = history.messages;
    $('#conversation-name').textContent = user.username;
    $('#channel-id').textContent = result.conversation_id;
    window.location.hash = `conversation/${result.conversation_id}`;
    renderMessages();
    markActiveMessagesRead();
  } catch (error) {
    $('#dashboard-error').textContent = error.message;
  }
}

async function restoreConversation(conversationId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    window.location.hash = 'dashboard';
    return;
  }
  state.activeConversation = { id: conversation.id, peer_id: conversation.peer_id, peer_username: conversation.peer_username };
  $('#conversation-name').textContent = conversation.peer_username;
  $('#channel-id').textContent = conversation.id;
  try {
    const history = await api(`/conversations/${conversationId}/messages?limit=100`);
    state.messages = history.messages;
    renderMessages();
    markActiveMessagesRead();
  } catch (error) {
    $('#conversation-name').textContent = error.message;
  }
}

function sendSocket(event) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(event));
}

function markActiveMessagesRead() {
  if (!state.activeConversation || !state.user) return;
  const ids = state.messages
    .filter((message) => message.conversation_id === state.activeConversation.id && message.recipient_id === state.user.id && message.delivery_status !== 'read')
    .map((message) => message.id);
  if (!ids.length) return;
  sendSocket({ type: 'message_read', conversation_id: state.activeConversation.id, message_ids: ids });
  for (const id of ids) {
    const message = messageById(id);
    if (message) message.delivery_status = 'read';
  }
  renderMessages();
}

function flushOutbox() {
  for (const item of state.outbox) sendSocket({ type: 'chat_message', ...item });
}

function handleSocketEvent(event) {
  if (event.type === 'connection_established') {
    state.reconnectDelay = 1000;
    setConnectionStatus('Connected');
    flushOutbox();
    return;
  }
  if (event.type === 'chat_message') {
    upsertMessage(event);
    sendSocket({ type: 'message_delivered', message_id: event.message_id });
    if (state.activeConversation?.id === event.conversation_id) markActiveMessagesRead();
    renderMessages();
    return;
  }
  if (event.type === 'message_ack') {
    const message = messageById(event.message_id);
    if (message) {
      message.delivery_status = event.status || 'sent';
      message.created_at = event.created_at || message.created_at;
    }
    state.outbox = state.outbox.filter((item) => item.message_id !== event.message_id);
    saveOutbox();
    renderMessages();
    return;
  }
  if (event.type === 'message_delivered') {
    const message = messageById(event.message_id);
    if (message) message.delivery_status = 'delivered';
    renderMessages();
    return;
  }
  if (event.type === 'message_read') {
    for (const id of event.message_ids || []) {
      const message = messageById(id);
      if (message) message.delivery_status = 'read';
    }
    renderMessages();
    return;
  }
  if (event.type === 'user_online') {
    state.onlineUsers.add(event.user_id);
    renderUsers();
    return;
  }
  if (event.type === 'user_offline') {
    state.onlineUsers.delete(event.user_id);
    renderUsers();
    return;
  }
  if (event.type === 'error') {
    $('#conversation-name').textContent = event.message || 'Message error';
  }
}

function connectSocket() {
  if (!state.token || state.intentionalClose || state.socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(state.reconnectTimer);
  setConnectionStatus('Connecting');
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socket.addEventListener('open', () => setConnectionStatus('Connecting'));
  socket.addEventListener('message', (message) => {
    try { handleSocketEvent(JSON.parse(message.data)); } catch { /* keep the socket alive on malformed server data */ }
  });
  socket.addEventListener('close', (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (event.code === 4401) {
      logout(false);
      return;
    }
    if (!state.intentionalClose && state.token) {
      setConnectionStatus('Reconnecting');
      state.reconnectTimer = setTimeout(connectSocket, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30_000);
    } else {
      setConnectionStatus('Offline');
    }
  });
  socket.addEventListener('error', () => setConnectionStatus('Reconnecting'));
}

function logout(callServer = true) {
  if (callServer && state.token) api('/logout', { method: 'POST' }).catch(() => {});
  state.intentionalClose = true;
  clearTimeout(state.reconnectTimer);
  state.socket?.close();
  state.socket = null;
  state.token = null;
  state.user = null;
  state.activeConversation = null;
  state.messages = [];
  saveSession();
  setConnectionStatus('Offline');
  window.location.hash = 'login';
}

async function submitForm(form, endpoint, onSuccess, errorTarget) {
  errorTarget.textContent = '';
  try {
    const data = Object.fromEntries(new FormData(form));
    await onSuccess(await api(endpoint, { method: 'POST', body: JSON.stringify(data) }));
  } catch (error) {
    errorTarget.textContent = error.message;
  }
}

async function route() {
  const { view, id } = currentRoute();
  if (!state.token && (view === 'dashboard' || view === 'conversation')) {
    window.location.hash = 'login';
    return;
  }
  showView(view);
  if (view === 'dashboard') await loadDashboard();
  if (view === 'conversation' && id) {
    if (!state.conversations.length) await loadDashboard();
    await restoreConversation(id);
  }
}

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, '/login', async (data) => {
    state.token = data.token;
    state.user = data.user;
    state.intentionalClose = false;
    saveSession();
    window.location.hash = 'dashboard';
    connectSocket();
  }, $('#login-error'));
});

$('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, '/register', async () => {
    event.currentTarget.reset();
    window.location.hash = 'login';
    $('#login-error').textContent = 'Account created. Log in to open your relay.';
  }, $('#register-error'));
});

$('#logout-button').addEventListener('click', () => logout());
$('#refresh-button').addEventListener('click', () => loadDashboard());
$('#back-button').addEventListener('click', () => { state.activeConversation = null; window.location.hash = 'dashboard'; });
$('#message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const content = input.value.trim();
  if (!content || !state.activeConversation || !state.user) return;
  const item = {
    message_id: crypto.randomUUID(),
    conversation_id: state.activeConversation.id,
    recipient_id: state.activeConversation.peer_id,
    content
  };
  state.outbox.push(item);
  saveOutbox();
  upsertMessage({ ...item, sender_id: state.user.id, created_at: new Date().toISOString(), status: 'sent' });
  input.value = '';
  renderMessages();
  sendSocket({ type: 'chat_message', ...item });
});

$('#message-input').addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
});

window.addEventListener('hashchange', route);
window.addEventListener('load', () => {
  if (state.token) {
    state.intentionalClose = false;
    connectSocket();
  }
  route();
});
