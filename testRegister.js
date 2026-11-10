// Quick test of register route without network
const { createRouter } = require('./src/routes');
const db = require('./src/db');

(async () => {
  // Ensure schema (memory mode)
  await db.ensureSchema();
  const router = createRouter({ db });
  // Find the POST /register handler
  const layer = router.stack.find(l => l.route && l.route.path === '/register' && l.route.methods.post);
  if (!layer) {
    console.error('Register route not found');
    process.exit(1);
  }
  const handler = layer.route.stack[0].handle;
  // Mock request and response with ip
  const mockReq = {
    ip: '127.0.0.1',
    body: { username: 'testuser', email: 'test@example.com', password: 'password123' }
  };
  const mockRes = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; console.log('Response:', this.statusCode, payload); }
  };
  await handler(mockReq, mockRes);
})();
