const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  comparePassword,
  hashPassword,
  requireAuth,
  signToken
} = require('./auth');

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,50}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createRouter({ db }) {
  const router = express.Router();
  const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 100, // allow more attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' }
});

  router.post('/register', authLimiter, async (request, response) => {
    const username = cleanText(request.body?.username);
    const email = cleanText(request.body?.email).toLowerCase();
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!USERNAME_PATTERN.test(username)) {
      return response.status(400).json({ error: 'Username must be 3–50 letters, numbers, dots, dashes, or underscores' });
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 255) {
      return response.status(400).json({ error: 'Enter a valid email address' });
    }
    if (password.length < 8 || password.length > 128) {
      return response.status(400).json({ error: 'Password must be 8–128 characters' });
    }

    try {
      const user = await db.createUser({
        id: crypto.randomUUID(),
        username,
        email,
        passwordHash: await hashPassword(password)
      });
      return response.status(201).json({ id: user.id, username: user.username });
    } catch (error) {
      if (error.code === '23505') return response.status(409).json({ error: 'Username or email already exists' });
      console.error('Register failed:', { code: error.code, message: error.message });
      const msg = error.message ? error.message : (error.code ? 'Database error' : 'Unable to create account');
      return response.status(500).json({ error: msg });
    }
  });

  router.post('/login', authLimiter, async (request, response) => {
    const email = cleanText(request.body?.email).toLowerCase();
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    try {
      const user = await db.findUserByEmail(email);
      const valid = user && await comparePassword(password, user.password_hash);
      if (!valid) return response.status(401).json({ error: 'Invalid credentials' });
      const safeUser = { id: user.id, username: user.username, email: user.email };
      console.log(JSON.stringify({ severity: 'INFO', event: 'login_success', userId: user.id }));
      return response.json({ token: signToken(safeUser), user: safeUser });
    } catch (error) {
      console.error(JSON.stringify({ severity: 'ERROR', event: 'login_failed', code: error.code, message: error.message }));
      return response.status(500).json({ error: error.message || 'Unable to log in' });
    }
  });

  router.post('/logout', requireAuth, (_request, response) => response.json({ ok: true }));

  router.get('/me', requireAuth, async (request, response) => {
    const user = await db.findUserById(request.user.userId);
    if (!user) return response.status(401).json({ error: 'User no longer exists' });
    return response.json({ user });
  });

  router.get('/users', requireAuth, async (request, response) => {
    return response.json({ users: await db.listUsers(request.user.userId) });
  });

  router.post('/conversations', requireAuth, async (request, response) => {
    const otherUserId = cleanText(request.body?.other_user_id);
    if (!UUID_PATTERN.test(otherUserId) || otherUserId === request.user.userId) {
      return response.status(400).json({ error: 'Choose another registered user' });
    }
    const otherUser = await db.findUserById(otherUserId);
    if (!otherUser) return response.status(404).json({ error: 'User not found' });
    const conversation = await db.createOrGetConversation(request.user.userId, otherUserId);
    return response.json({ conversation_id: conversation.id });
  });

  router.get('/conversations', requireAuth, async (request, response) => {
    return response.json({ conversations: await db.listConversations(request.user.userId) });
  });

  router.get('/conversations/:id/messages', requireAuth, async (request, response) => {
    const conversationId = request.params.id;
    if (!UUID_PATTERN.test(conversationId)) return response.status(400).json({ error: 'Invalid conversation ID' });
    if (!(await db.userIsParticipant(conversationId, request.user.userId))) {
      return response.status(403).json({ error: 'Not a participant' });
    }
    const messages = await db.listMessages(conversationId, request.user.userId, {
      limit: request.query.limit,
      before: request.query.before
    });
    return response.json({ messages });
  });

  return router;
}

module.exports = { createRouter };
