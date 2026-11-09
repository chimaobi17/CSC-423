# ChatBridge Transport-Layer Report

## 1. Application overview

ChatBridge is a multi-user, one-to-one real-time text chat application. A user registers with a username and email, logs in, and opens a conversation with another registered user. The browser creates an authenticated WebSocket connection to the Node.js chat server. WebSockets provide a browser-friendly message interface, but the WebSocket connection is carried over a reliable TCP connection.

The server accepts multiple simultaneous client connections through the `/ws` endpoint. Each authenticated socket is associated with a user ID in an in-memory connection registry. Messages use JSON objects such as:

```json
{
  "type": "chat_message",
  "message_id": "client-generated-uuid",
  "conversation_id": "conversation-uuid",
  "recipient_id": "user-uuid",
  "content": "Hello over TCP"
}
```

The server validates the message, verifies conversation participation, stores it in PostgreSQL before acknowledging it, and forwards it to the recipient's socket when that user is online. If the recipient is offline, the stored message is replayed when the recipient reconnects. The client uses a heartbeat, automatic reconnect with exponential backoff, and explicit delivery/read events.

## 2. How the implementation demonstrates transport-layer concepts

- **Server process and port:** Node.js creates an HTTP server and listens on the configured `PORT` (3000 in development and the provider-assigned port in a container). The WebSocket upgrade is handled by the same server.
- **Client process:** Each browser tab is a client process from the application's point of view. It opens a WebSocket connection to the server's host and port.
- **Socket:** A socket is the communication endpoint represented by the server-side WebSocket object and the browser's WebSocket object. The server keeps one current socket per connected user and removes it on close or error.
- **Connection identity:** TCP identifies a connection using the endpoint tuple of source IP, source port, destination IP, and destination port. ChatBridge adds application identity by authenticating a JWT during the WebSocket upgrade and associating the socket with a user ID.
- **Reliable process-to-process communication:** TCP handles ordered, reliable byte delivery underneath WebSockets. ChatBridge adds application-level message IDs, database persistence, acknowledgements, delivery events, read events, and offline replay so the user-visible chat state survives a disconnected client.
- **Disconnection:** When a socket closes or errors, the server removes it from the registry and broadcasts the user's offline state. A reconnecting client opens a new TCP/WebSocket connection and receives pending messages from PostgreSQL.

## 3. TCP vs UDP analysis

### 1. Why is TCP suitable for normal chat messages?

Normal chat messages should arrive completely, in order, and without accidental duplication. TCP provides a reliable ordered byte stream, so the application does not need to implement packet sequencing, retransmission, or loss detection for every message. TCP also performs congestion control and adapts its sending rate to network conditions. That makes TCP a good fit for text where correctness is more important than shaving a small amount of latency.

### 2. What transport-layer guarantees does TCP provide?

TCP provides connection-oriented communication, reliable delivery through acknowledgements and retransmission, ordered delivery, duplicate suppression, flow control, congestion control, and a full-duplex byte stream. TCP does not guarantee unlimited bandwidth, zero latency, or that a connection will stay alive forever. A connection can still fail if a host, network, or process disappears, which is why ChatBridge has heartbeats and reconnect logic.

### 3. What are the differences between TCP and UDP?

TCP establishes a connection and provides an ordered, reliable byte stream. It has acknowledgements, retransmissions, flow control, and congestion control, but it can introduce delay when a missing segment must be retransmitted. UDP is connectionless datagram delivery. It has lower protocol overhead and does not require a handshake, but it does not guarantee delivery, ordering, uniqueness, congestion control, or connection state. An application using UDP must implement any reliability or sequencing it needs.

### 4. Which parts of a chat application could reasonably use UDP?

Normal text messages, login, conversation history, delivery state, and read state should remain on TCP because they require correctness. UDP could be reasonable for latency-sensitive optional features such as live voice/video media, push-to-talk audio, typing animation, cursor/presence hints, or game-like reactions where a late update is less useful than a new update. Those features would need application-level decisions about sequence numbers, timestamps, loss tolerance, encryption, and congestion behavior. ChatBridge intentionally keeps its required text protocol on WebSocket/TCP.

### 5. What happens if a UDP message is lost or arrives out of order?

UDP itself does nothing: the lost datagram is not retransmitted, and the receiver may see a later datagram before an earlier one. The application must decide whether to ignore the missing update, request a resend, reorder using sequence numbers, or replace stale state with the newest timestamp. For example, a typing indicator can simply expire, while a file transfer would need its own reliable protocol. This is another reason normal chat text uses TCP in ChatBridge.

### 6. How do sockets and port numbers enable communication between client and server processes?

The server binds a listening socket to an IP address and port. The operating system uses that port to deliver incoming connection requests to the correct server process. A client opens a socket and connects to the server address and port; the OS assigns the client an ephemeral source port. Once connected, the TCP endpoint pair identifies the connection, and the server receives bytes from that client socket. The WebSocket protocol then frames those bytes as messages and ChatBridge parses them as JSON events.

### 7. What happens when a client disconnects while using TCP?

If the client closes normally, TCP performs connection shutdown and the server receives a close event. If the network disappears, the peer crashes, or the connection becomes unusable, TCP eventually reports a reset, timeout, or failed write. ChatBridge handles the resulting WebSocket close/error event by removing the socket from the registry and marking the user offline. The message remains durable in PostgreSQL if it was already accepted. When the client reconnects, the server replays pending messages, which prevents a temporary TCP disconnect from losing accepted chat data.

## 4. Conclusion

The application demonstrates the transport layer through a practical browser interface: a listening server port accepts multiple client connections; authenticated sockets identify processes and users; WebSockets carry JSON messages over TCP; TCP supplies the underlying reliable ordered transport; and the application adds persistence, acknowledgements, heartbeats, reconnection, and offline replay for a complete chat experience.
