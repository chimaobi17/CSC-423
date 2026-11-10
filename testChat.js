// Manual WebSocket smoke test.
// Usage: TOKEN=<jwt> CONVERSATION_ID=<id> RECIPIENT_ID=<id> [HOST=localhost:3000] [WS_PROTOCOL=ws] node testChat.js
const crypto = require('node:crypto');
const WebSocket = require('ws');

const { TOKEN, CONVERSATION_ID, RECIPIENT_ID } = process.env;
if (!TOKEN || !CONVERSATION_ID || !RECIPIENT_ID) {
  console.error('Set TOKEN, CONVERSATION_ID and RECIPIENT_ID environment variables.');
  process.exit(1);
}

const host = process.env.HOST || 'localhost:3000';
const protocol = process.env.WS_PROTOCOL || 'ws';
const ws = new WebSocket(`${protocol}://${host}/ws?token=${encodeURIComponent(TOKEN)}`);

ws.on('open', () => {
  console.log('WebSocket connected');
  ws.send(JSON.stringify({
    type: 'chat_message',
    message_id: crypto.randomUUID(),
    conversation_id: CONVERSATION_ID,
    recipient_id: RECIPIENT_ID,
    content: 'Hello via automated test!'
  }));
});

ws.on('message', (data) => console.log('Received:', data.toString()));
ws.on('close', () => console.log('WebSocket closed'));
ws.on('error', (err) => console.error('WebSocket error', err));
