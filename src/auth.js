const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_TTL = '2h';

function jwtSecret() {
  return process.env.JWT_SECRET || 'chatbridge-development-secret-change-me';
}

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ userId: user.id, username: user.username }, jwtSecret(), {
    expiresIn: JWT_TTL
  });
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret());
}

function tokenFromRequest(request) {
  const header = request.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

function requireAuth(request, response, next) {
  const token = tokenFromRequest(request);
  if (!token) return response.status(401).json({ error: 'Authentication required' });

  try {
    request.user = verifyToken(token);
    return next();
  } catch {
    return response.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  comparePassword,
  hashPassword,
  requireAuth,
  signToken,
  tokenFromRequest,
  verifyToken
};
