const http = require('node:http');
const path = require('node:path');
const express = require('express');
const db = require('./src/db');
const { validateAuthConfig } = require('./src/auth');
const { createRouter } = require('./src/routes');
const { createWebSocketServer } = require('./src/ws');

const app = express();
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('/health', async (_request, response) => {
  try {
    return response.json({ ok: true, service: 'chatbridge', database: (await db.health()).mode });
  } catch {
    return response.status(503).json({ ok: false, service: 'chatbridge' });
  }
});
app.use('/api', createRouter({ db }));
app.get(/^(?!\/api(?:\/|$)|\/health$|\/ws$).*/, (_request, response) => {
  response.sendFile(path.join(publicDir, 'index.html'));
});

const httpServer = http.createServer(app);
createWebSocketServer(httpServer, { db });

async function start() {
  validateAuthConfig();
  db.validateDatabaseConfig();
  if (process.env.NODE_ENV === 'production' && !/^https:\/\//i.test(process.env.ALLOWED_ORIGIN || '')) {
    throw new Error('Production requires an HTTPS ALLOWED_ORIGIN');
  }
  await db.ensureSchema();
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ severity: 'INFO', event: 'server_started', port, database: db.mode() }));
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(JSON.stringify({ severity: 'CRITICAL', event: 'startup_failed', message: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { app, httpServer, start };
