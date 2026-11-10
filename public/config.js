// Where the ChatBridge backend (REST + WebSocket) lives.
// Leave empty to use the same host that served this page (local dev).
window.CHATBRIDGE_API_ORIGIN = (function () {
  var host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return '';
  return 'https://chatbridge-59ln.onrender.com';
})();
