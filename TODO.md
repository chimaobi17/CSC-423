# ChatBridge delivery checklist

## Account access and authorization

- [ ] Users can register with a unique username, unique email, and password; duplicate username or email returns HTTP 409.
- [ ] Passwords are hashed with bcrypt-compatible hashing before storage; plaintext passwords are never stored or logged.
- [ ] Successful login returns a signed JWT that expires after two hours; logout clears the client token.
- [ ] Protected REST routes require a valid bearer token, and invalid or missing tokens return HTTP 401.

## Persistent messaging data

- [ ] PostgreSQL stores users, conversations, two participants per conversation, messages, delivery status, and timestamps using the documented schema and parameterized SQL.
- [ ] A user can list other registered users, create or fetch a one-to-one conversation, list their conversations, and reload chronological message history only when they are a participant.
- [ ] Messages are text-only, validated to 1–1,000 characters, and use a client-generated message ID with a unique database constraint so retries do not create duplicates.

## WebSocket delivery

- [ ] Each authenticated client opens `/ws?token=<JWT>`; the server verifies the JWT during upgrade, keeps a `Map` of user ID to socket, and rejects invalid connections with close code 4401.
- [ ] The UI shows Connecting, Connected, Reconnecting, and Offline states; the client retries with exponential backoff of 1s, 2s, 4s, up to 30s.
- [ ] The server sends heartbeat pings every 25 seconds and removes dead sockets on close or error.
- [ ] A saved message is acknowledged to its sender as Sent before online forwarding; the recipient can acknowledge Delivered, and opening the conversation marks messages Read.
- [ ] Messages sent to offline users remain Sent and are pushed after the recipient reconnects; delivery acknowledgement updates the sender.

## Browser experience

- [ ] The browser provides register, login, dashboard, and conversation views in a responsive phone/laptop layout.
- [ ] The dashboard lists other users and existing conversations; a user can open a private conversation and see timestamps in chronological order.
- [ ] Message ticks communicate one tick for Sent, two ticks for Delivered, and blue ticks for Read; rendering uses safe text nodes rather than HTML injection.
- [ ] The client retains an unacknowledged outbox item and retries it with the same message ID after reconnection.

## Operations and delivery

- [ ] `/health` is an unauthenticated success endpoint suitable for monitoring.
- [ ] The service listens on `PORT` and `0.0.0.0`, uses environment-based database/JWT settings, and includes Docker and Cloud Build configuration for Cloud Run/Cloud SQL.
- [ ] The repository contains a README with local setup, schema initialization, demo flow, GCP deployment values, and the documented Redis/multi-instance future path.
- [ ] The app runs without a configured database only in explicit development memory mode, so Preview can demonstrate the UI without weakening the PostgreSQL production path.
