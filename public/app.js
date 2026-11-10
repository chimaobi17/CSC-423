const state = {
  token: localStorage.getItem('chatbridge_token'),
  user: JSON.parse(localStorage.getItem('chatbridge_user') || 'null'),
  socket: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  intentionalClose: false,
  hasConnected: false,
  listsLoaded: false,
  activeConversation: null,
  messages: [],
  users: [],
  conversations: [],
  outbox: JSON.parse(localStorage.getItem('chatbridge_outbox') || '[]'),
  onlineUsers: new Set(),
  lastSeen: new Map(),
  typing: new Map(),
  seenIds: new Set(),
  search: ''
};

const views = ['login', 'register', 'app'];
const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };
const $ = (selector) => document.querySelector(selector);

// Backend origin: set in config.js when the frontend is hosted separately (Vercel).
const API_ORIGIN = String(window.CHATBRIDGE_API_ORIGIN || window.location.origin).replace(/\/+$/, '');
const api = async (path, options = {}) => {
  const response = await fetch(`${API_ORIGIN}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && state.token && !/^\/(login|register)/.test(path)) {
    logout(false);
    throw new Error('Your session expired. Please log in again.');
  }
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

/* ---------- small helpers ---------- */

function setConnectionStatus(status) {
  const pill = $('#connection-pill');
  pill.className = `connection-pill ${status.toLowerCase()}`;
  $('#connection-label').textContent = status;
  const banner = $('#connection-banner');
  banner.hidden = status === 'Connected';
  banner.textContent = status === 'Offline' ? 'Offline — messages will send when you reconnect'
    : status === 'Connected' ? '' : 'Connecting…';
}

function showNotice(text) {
  const el = $('#dashboard-error');
  el.textContent = text;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { el.textContent = ''; }, 5000);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function dayLabel(value) {
  const date = new Date(value);
  const now = new Date();
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(date);
}

function listTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  if (sameDay(date, now)) return formatTime(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function lastSeenLabel(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  if (sameDay(date, now)) return `last seen today at ${formatTime(iso)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `last seen yesterday at ${formatTime(iso)}`;
  return `last seen ${listTime(iso)}`;
}

function paintAvatar(element, name) {
  const text = String(name || '?');
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  element.textContent = text.charAt(0).toUpperCase();
  element.style.background = `hsl(${hash} 38% 34%)`;
}

function makeAvatar(name, online) {
  const wrap = document.createElement('span');
  wrap.className = 'avatar';
  paintAvatar(wrap, name);
  if (online) {
    const dot = document.createElement('i');
    dot.className = 'presence-dot';
    wrap.append(dot);
  }
  return wrap;
}

function rank(status) {
  return STATUS_RANK[status] ?? 0;
}

function tickMarkup(status) {
  const span = document.createElement('span');
  span.className = 'ticks';
  if (status === 'pending') { span.textContent = '◷'; span.classList.add('pending'); }
  else if (status === 'read') { span.textContent = '✓✓'; span.classList.add('read'); }
  else if (status === 'delivered') span.textContent = '✓✓';
  else span.textContent = '✓';
  return span;
}

function peerStatus(peerId, conversationId) {
  if (conversationId && state.typing.has(conversationId)) return 'typing…';
  if (state.onlineUsers.has(peerId)) return 'online';
  const conversation = state.conversations.find((item) => item.peer_id === peerId);
  const user = state.users.find((item) => item.id === peerId);
  return lastSeenLabel(state.lastSeen.get(peerId) || conversation?.peer_last_seen_at || user?.last_seen_at);
}

function updateTitle() {
  const unread = state.conversations.reduce((sum, item) => sum + (item.unread_count || 0), 0);
  document.title = unread ? `(${unread}) ChatBridge` : 'ChatBridge';
}

/* ---------- routing ---------- */

function currentRoute() {
  const raw = window.location.hash.replace(/^#/, '') || (state.token ? 'dashboard' : 'login');
  const [name, id] = raw.split('/');
  if (name === 'dashboard' || name === 'conversation') return { view: 'app', name, id };
  return { view: name === 'register' ? 'register' : 'login', name, id };
}

function showView(view) {
  for (const name of views) $(`#view-${name}`).hidden = name !== view;
  document.body.classList.toggle('in-app', view === 'app');
}

/* ---------- message state ---------- */

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
  if (existing) {
    if (rank(existing.delivery_status) > rank(normalized.delivery_status)) normalized.delivery_status = existing.delivery_status;
    Object.assign(existing, normalized);
  } else {
    state.messages.push(normalized);
  }
  state.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function setStatus(messageId, status) {
  const message = messageById(messageId);
  if (message && rank(status) > rank(message.delivery_status)) message.delivery_status = status;
  const conversation = state.conversations.find((item) => item.last_message_id === messageId);
  if (conversation && rank(status) > rank(conversation.last_message_status)) conversation.last_message_status = status;
}

function conversationById(id) {
  return state.conversations.find((item) => item.id === id);
}

function touchConversation(conversation, message) {
  conversation.last_message_id = message.id;
  conversation.last_message = message.content;
  conversation.last_message_at = message.created_at;
  conversation.last_message_sender_id = message.sender_id;
  conversation.last_message_status = message.delivery_status;
  state.conversations.sort((a, b) => new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at));
}

function isViewingActive() {
  return document.visibilityState === 'visible';
}

/* ---------- rendering ---------- */

function renderAll() {
  renderSidebar();
  renderHeader();
  renderMessages();
  updateTitle();
}

function listHeading(text) {
  const heading = document.createElement('div');
  heading.className = 'list-heading';
  heading.textContent = text;
  return heading;
}

function renderSidebar() {
  const list = $('#chat-list');
  const query = state.search.trim().toLowerCase();
  const rows = [];

  const conversations = state.conversations.filter((item) => !query || item.peer_username.toLowerCase().includes(query));
  for (const conversation of conversations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-row';
    if (state.activeConversation?.id === conversation.id) button.classList.add('active');

    const body = document.createElement('span');
    body.className = 'chat-row-body';
    const top = document.createElement('span');
    top.className = 'chat-row-top';
    const name = document.createElement('strong');
    name.textContent = conversation.peer_username;
    const time = document.createElement('small');
    time.textContent = conversation.last_message ? listTime(conversation.last_message_at) : '';
    if (conversation.unread_count) time.classList.add('unread-time');
    top.append(name, time);

    const bottom = document.createElement('span');
    bottom.className = 'chat-row-bottom';
    const preview = document.createElement('span');
    preview.className = 'preview';
    if (state.typing.has(conversation.id)) {
      preview.textContent = 'typing…';
      preview.classList.add('typing');
    } else if (conversation.last_message) {
      if (conversation.last_message_sender_id === state.user.id) {
        preview.append(tickMarkup(conversation.last_message_status || 'sent'), ' ');
      }
      preview.append(document.createTextNode(conversation.last_message));
    } else {
      preview.textContent = 'No messages yet';
      preview.classList.add('empty');
    }
    bottom.append(preview);
    if (conversation.unread_count) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = conversation.unread_count > 99 ? '99+' : String(conversation.unread_count);
      bottom.append(badge);
    }
    body.append(top, bottom);
    button.append(makeAvatar(conversation.peer_username, state.onlineUsers.has(conversation.peer_id)), body);
    button.addEventListener('click', () => openConversation({ id: conversation.peer_id, username: conversation.peer_username }));
    rows.push(button);
  }

  const chatting = new Set(state.conversations.map((item) => item.peer_id));
  const people = state.users.filter((user) => !chatting.has(user.id) && (!query || user.username.toLowerCase().includes(query)));
  if (people.length) {
    rows.push(listHeading(query ? 'People' : 'Start a new chat'));
    for (const user of people) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-row person';
      const body = document.createElement('span');
      body.className = 'chat-row-body';
      const name = document.createElement('strong');
      name.textContent = user.username;
      const sub = document.createElement('span');
      sub.className = 'preview';
      sub.textContent = peerStatus(user.id) || 'Tap to say hello';
      body.append(name, sub);
      button.append(makeAvatar(user.username, state.onlineUsers.has(user.id)), body);
      button.addEventListener('click', () => openConversation(user));
      rows.push(button);
    }
  }

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = query ? 'No one matches that search.'
      : 'No other users yet. Open ChatBridge on a second device and create another account to start chatting.';
    rows.push(empty);
  }
  list.replaceChildren(...rows);
}

function renderHeader() {
  const active = state.activeConversation;
  $('#chat-empty').hidden = Boolean(active);
  $('#chat-active').hidden = !active;
  $('#view-app').dataset.mode = active ? 'chat' : 'list';
  if (!active) return;
  $('#conversation-name').textContent = active.peer_username;
  paintAvatar($('#chat-avatar'), active.peer_username);
  const status = peerStatus(active.peer_id, active.id);
  const el = $('#chat-status');
  el.textContent = status;
  el.className = status === 'online' || status === 'typing…' ? 'live' : '';
}

function renderMessages(forceScroll = false) {
  const list = $('#message-list');
  const current = state.activeConversation;
  if (!current) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  const messages = state.messages.filter((message) => message.conversation_id === current.id);
  if (!messages.length) {
    list.innerHTML = '<div class="empty-state centered">No messages yet. Say hello 👋</div>';
    return;
  }
  const nodes = [];
  let lastDay = null;
  for (const message of messages) {
    const date = new Date(message.created_at);
    const dayKey = date.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const separator = document.createElement('div');
      separator.className = 'day-separator';
      const pill = document.createElement('span');
      pill.textContent = dayLabel(message.created_at);
      separator.append(pill);
      nodes.push(separator);
    }
    const mine = message.sender_id === state.user.id;
    const row = document.createElement('div');
    row.className = `message-row ${mine ? 'mine' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const text = document.createElement('span');
    text.className = 'message-text';
    text.textContent = message.content;
    const meta = document.createElement('span');
    meta.className = 'message-meta';
    const time = document.createElement('span');
    time.textContent = formatTime(message.created_at);
    meta.append(time);
    if (mine) meta.append(tickMarkup(message.delivery_status));
    bubble.append(text, meta);
    row.append(bubble);
    nodes.push(row);
  }
  list.replaceChildren(...nodes);
  if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
}

/* ---------- data loading ---------- */

async function loadLists() {
  try {
    const [users, conversations] = await Promise.all([api('/users'), api('/conversations')]);
    state.users = users.users;
    state.conversations = conversations.conversations;
    state.listsLoaded = true;
    renderSidebar();
    updateTitle();
  } catch (error) {
    showNotice(error.message);
  }
}

async function loadHistory(conversationId) {
  const history = await api(`/conversations/${conversationId}/messages?limit=100`);
  state.messages = history.messages;
  // Show messages still waiting in the outbox as pending.
  for (const item of state.outbox) {
    if (item.conversation_id === conversationId && !messageById(item.message_id)) {
      upsertMessage({ ...item, sender_id: state.user.id, created_at: item.created_at || new Date().toISOString(), status: 'pending' });
    }
  }
}

async function openConversation(user) {
  try {
    const result = await api('/conversations', { method: 'POST', body: JSON.stringify({ other_user_id: user.id }) });
    if (!conversationById(result.conversation_id)) {
      state.conversations.unshift({
        id: result.conversation_id,
        created_at: new Date().toISOString(),
        peer_id: user.id,
        peer_username: user.username,
        last_message: null,
        last_message_at: new Date().toISOString(),
        unread_count: 0
      });
    }
    if (window.location.hash === `#conversation/${result.conversation_id}`) await activateConversation(result.conversation_id);
    else window.location.hash = `conversation/${result.conversation_id}`;
  } catch (error) {
    showNotice(error.message);
  }
}

async function activateConversation(conversationId) {
  let conversation = conversationById(conversationId);
  if (!conversation) {
    await loadLists();
    conversation = conversationById(conversationId);
  }
  if (!conversation) {
    window.location.hash = 'dashboard';
    return;
  }
  state.activeConversation = { id: conversation.id, peer_id: conversation.peer_id, peer_username: conversation.peer_username };
  state.messages = [];
  renderAll();
  try {
    await loadHistory(conversationId);
  } catch (error) {
    showNotice(error.message);
  }
  if (state.activeConversation?.id !== conversationId) return;
  renderAll();
  $('#message-list').scrollTop = $('#message-list').scrollHeight;
  markActiveMessagesRead();
  if (!window.matchMedia('(pointer: coarse)').matches) $('#message-input').focus();
}

function closeConversation() {
  stopTyping();
  state.activeConversation = null;
  state.messages = [];
  renderAll();
}

/* ---------- socket ---------- */

function sendSocket(event) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(event));
    return true;
  }
  return false;
}

function markActiveMessagesRead() {
  if (!state.activeConversation || !state.user || !isViewingActive()) return;
  const conversationId = state.activeConversation.id;
  const ids = state.messages
    .filter((message) => message.conversation_id === conversationId && message.recipient_id === state.user.id && message.delivery_status !== 'read')
    .map((message) => message.id);
  const conversation = conversationById(conversationId);
  if (conversation && conversation.unread_count) conversation.unread_count = 0;
  if (ids.length) {
    sendSocket({ type: 'message_read', conversation_id: conversationId, message_ids: ids });
    for (const id of ids) setStatus(id, 'read');
  }
  renderAll();
}

function flushOutbox() {
  state.outbox.forEach((item, index) => {
    setTimeout(() => sendSocket({ type: 'chat_message', ...item }), index * 120);
  });
}

async function refreshAfterReconnect() {
  await loadLists();
  const active = state.activeConversation;
  if (!active) return;
  try {
    await loadHistory(active.id);
    renderAll();
    markActiveMessagesRead();
  } catch (error) {
    showNotice(error.message);
  }
}

// New accounts can appear while we are online; refetch when we see someone we don't know.
let userRefreshTimer = null;
function refreshIfUnknownUsers(ids) {
  if (!state.user || !state.listsLoaded) return;
  const known = new Set(state.users.map((user) => user.id));
  if (!ids.some((id) => id !== state.user.id && !known.has(id))) return;
  clearTimeout(userRefreshTimer);
  userRefreshTimer = setTimeout(loadLists, 400);
}

function setTyping(conversationId, isTyping) {
  clearTimeout(state.typing.get(conversationId));
  if (isTyping) {
    state.typing.set(conversationId, setTimeout(() => { state.typing.delete(conversationId); renderSidebar(); renderHeader(); }, 4500));
  } else {
    state.typing.delete(conversationId);
  }
  renderSidebar();
  renderHeader();
}

async function handleSocketEvent(event) {
  switch (event.type) {
    case 'connection_established': {
      state.reconnectDelay = 1000;
      setConnectionStatus('Connected');
      flushOutbox();
      if (state.hasConnected) refreshAfterReconnect();
      state.hasConnected = true;
      return;
    }
    case 'presence_snapshot':
      state.onlineUsers = new Set(event.online_user_ids || []);
      refreshIfUnknownUsers([...state.onlineUsers]);
      renderAll();
      return;
    case 'user_online':
      state.onlineUsers.add(event.user_id);
      refreshIfUnknownUsers([event.user_id]);
      renderAll();
      return;
    case 'user_offline':
      state.onlineUsers.delete(event.user_id);
      if (event.last_seen) state.lastSeen.set(event.user_id, event.last_seen);
      for (const [conversationId, timer] of [...state.typing]) {
        if (conversationById(conversationId)?.peer_id === event.user_id) { clearTimeout(timer); state.typing.delete(conversationId); }
      }
      renderAll();
      return;
    case 'typing': {
      const conversation = conversationById(event.conversation_id);
      if (conversation && conversation.peer_id === event.user_id) setTyping(event.conversation_id, event.is_typing);
      return;
    }
    case 'chat_message':
      await handleIncomingMessage(event);
      return;
    case 'message_ack': {
      state.outbox = state.outbox.filter((item) => item.message_id !== event.message_id);
      saveOutbox();
      const message = messageById(event.message_id);
      if (message) {
        message.created_at = event.created_at || message.created_at;
        setStatus(event.message_id, event.status || 'sent');
        if (message.delivery_status === 'pending') message.delivery_status = 'sent';
      }
      const conversation = conversationById(event.conversation_id);
      if (conversation && conversation.last_message_id === event.message_id && conversation.last_message_status === 'pending') {
        conversation.last_message_status = 'sent';
      }
      renderAll();
      return;
    }
    case 'message_delivered':
      setStatus(event.message_id, 'delivered');
      renderAll();
      return;
    case 'message_read':
      for (const id of event.message_ids || []) setStatus(id, 'read');
      renderAll();
      return;
    case 'conversation_read': {
      const conversation = conversationById(event.conversation_id);
      if (conversation) conversation.unread_count = 0;
      for (const id of event.message_ids || []) setStatus(id, 'read');
      renderAll();
      return;
    }
    case 'error':
      showNotice(event.message || 'Message error');
      return;
    default:
  }
}

async function handleIncomingMessage(event) {
  const mine = event.sender_id === state.user.id;
  const message = {
    id: event.message_id,
    conversation_id: event.conversation_id,
    sender_id: event.sender_id,
    recipient_id: event.recipient_id,
    content: event.content,
    created_at: event.timestamp,
    delivery_status: event.status || 'sent'
  };
  const alreadySeen = state.seenIds.has(message.id);
  state.seenIds.add(message.id);

  let conversation = conversationById(event.conversation_id);
  let freshFromServer = false;
  if (!conversation) {
    await loadLists();
    conversation = conversationById(event.conversation_id);
    freshFromServer = true;
  }

  const isActive = state.activeConversation?.id === event.conversation_id;
  if (isActive) upsertMessage(message);

  if (conversation) {
    if (!freshFromServer) touchConversation(conversation, message);
    // Replayed (pending) messages are already counted by the server's unread total.
    if (!mine && !alreadySeen && !freshFromServer && !event.pending && !(isActive && isViewingActive())) {
      conversation.unread_count = (conversation.unread_count || 0) + 1;
    }
    if (!mine) clearTypingFor(conversation);
  }

  if (!mine) sendSocket({ type: 'message_delivered', message_id: message.id });
  if (!mine && isActive) markActiveMessagesRead();
  renderAll();
}

function clearTypingFor(conversation) {
  if (state.typing.has(conversation.id)) {
    clearTimeout(state.typing.get(conversation.id));
    state.typing.delete(conversation.id);
  }
}

function connectSocket() {
  if (!state.token || state.intentionalClose) return;
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.reconnectTimer);
  setConnectionStatus('Connecting');
  const socket = new WebSocket(`${API_ORIGIN.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(state.token)}`);
  state.socket = socket;
  socket.addEventListener('message', (message) => {
    try { handleSocketEvent(JSON.parse(message.data)); } catch { /* keep the socket alive on malformed server data */ }
  });
  socket.addEventListener('close', (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.onlineUsers.clear();
    if (event.code === 4401) {
      logout(false);
      return;
    }
    if (!state.intentionalClose && state.token && event.code !== 4000) {
      setConnectionStatus('Reconnecting');
      state.reconnectTimer = setTimeout(connectSocket, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30_000);
    } else {
      setConnectionStatus('Offline');
    }
    renderAll();
  });
  socket.addEventListener('error', () => setConnectionStatus('Reconnecting'));
}

function reconnectNow() {
  if (!state.token || state.intentionalClose) return;
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  state.reconnectDelay = 1000;
  connectSocket();
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
  state.conversations = [];
  state.users = [];
  state.listsLoaded = false;
  state.hasConnected = false;
  state.onlineUsers.clear();
  state.typing.clear();
  state.search = '';
  state.outbox = [];
  saveOutbox();
  saveSession();
  setConnectionStatus('Offline');
  document.title = 'ChatBridge';
  window.location.hash = 'login';
}

/* ---------- typing indicator (outgoing) ---------- */

let typingSentAt = 0;
let typingIdleTimer = null;

function sendTyping(isTyping) {
  const active = state.activeConversation;
  if (!active) return;
  sendSocket({ type: 'typing', conversation_id: active.id, recipient_id: active.peer_id, is_typing: isTyping });
}

function stopTyping() {
  clearTimeout(typingIdleTimer);
  if (typingSentAt) sendTyping(false);
  typingSentAt = 0;
}

/* ---------- forms & routing ---------- */

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
  const { view, name, id } = currentRoute();
  if (!state.token && view === 'app') {
    window.location.hash = 'login';
    return;
  }
  showView(view);
  if (view !== 'app') {
    state.activeConversation = null;
    return;
  }
  $('#me-name').textContent = state.user.username;
  $('#me-email').textContent = state.user.email || '';
  paintAvatar($('#me-avatar'), state.user.username);
  if (!state.listsLoaded) await loadLists();
  if (name === 'conversation' && id) {
    if (state.activeConversation?.id !== id) await activateConversation(id);
  } else {
    closeConversation();
  }
}

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, '/login', async (data) => {
    state.token = data.token;
    state.user = data.user;
    state.intentionalClose = false;
    state.hasConnected = false;
    state.listsLoaded = false;
    saveSession();
    window.location.hash = 'dashboard';
    connectSocket();
    route();
  }, $('#login-error'));
});

$('#register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submitForm(form, '/register', async () => {
    form.reset();
    window.location.hash = 'login';
    $('#login-error').textContent = 'Account created. Log in to start chatting.';
  }, $('#register-error'));
});

$('#logout-button').addEventListener('click', () => logout());
$('#back-button').addEventListener('click', () => { window.location.hash = 'dashboard'; });
$('#search-input').addEventListener('focus', () => { if (state.listsLoaded) loadLists(); });
$('#search-input').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderSidebar();
});

const input = $('#message-input');

function sendCurrentMessage() {
  const content = input.value.trim();
  if (!content || !state.activeConversation || !state.user) return;
  const item = {
    message_id: crypto.randomUUID(),
    conversation_id: state.activeConversation.id,
    recipient_id: state.activeConversation.peer_id,
    content,
    created_at: new Date().toISOString()
  };
  state.outbox.push(item);
  saveOutbox();
  const message = { ...item, sender_id: state.user.id, status: 'pending' };
  upsertMessage(message);
  state.seenIds.add(item.message_id);
  const conversation = conversationById(item.conversation_id);
  if (conversation) {
    touchConversation(conversation, { id: item.message_id, content, created_at: item.created_at, sender_id: state.user.id, delivery_status: 'pending' });
  }
  input.value = '';
  input.style.height = 'auto';
  stopTyping();
  renderAll();
  renderMessages(true);
  sendSocket({ type: 'chat_message', message_id: item.message_id, conversation_id: item.conversation_id, recipient_id: item.recipient_id, content });
}

$('#message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendCurrentMessage();
});

input.addEventListener('keydown', (event) => {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touch) {
    event.preventDefault();
    sendCurrentMessage();
  }
});

input.addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
  if (!event.target.value.trim()) {
    stopTyping();
    return;
  }
  const now = Date.now();
  if (now - typingSentAt > 2500) {
    typingSentAt = now;
    sendTyping(true);
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, 3000);
});

input.addEventListener('blur', stopTyping);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  reconnectNow();
  markActiveMessagesRead();
});
window.addEventListener('online', reconnectNow);
window.addEventListener('focus', markActiveMessagesRead);
window.addEventListener('hashchange', route);
window.addEventListener('load', () => {
  if (state.token) {
    state.intentionalClose = false;
    connectSocket();
  }
  route();
});
