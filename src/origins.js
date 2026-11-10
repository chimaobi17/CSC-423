// Browser origins allowed to call the API / open the WebSocket from another host
// (e.g. the Vercel frontend). Add more via ALLOWED_ORIGIN or CORS_ORIGINS
// (comma-separated). Auth uses bearer tokens, not cookies.
const DEFAULT_PRODUCTION_ORIGINS = ['https://csc-423-chat-bridge.vercel.app'];

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function explicitOrigins() {
  return [...parseList(process.env.ALLOWED_ORIGIN), ...parseList(process.env.CORS_ORIGINS)];
}

function allowedOrigins() {
  const production = process.env.NODE_ENV === 'production';
  return [...new Set([...explicitOrigins(), ...(production ? DEFAULT_PRODUCTION_ORIGINS : [])])];
}

module.exports = { allowedOrigins, explicitOrigins };
