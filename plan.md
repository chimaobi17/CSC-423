# ChatBridge implementation plan

## Scope

ChatBridge is a deliberately small undergraduate demonstration of one-to-one real-time messaging. It uses one Node.js process to serve the browser client, REST API, and WebSocket endpoint. PostgreSQL is the durable source of truth in deployed environments; a clearly labeled in-memory adapter is available only when no database environment is present so the UI can be previewed without provisioning Cloud SQL.

The first milestone covers registration, login, JWT authorization, user discovery, private conversation creation, history loading, persistent WebSocket connections, message acknowledgements, delivery/read status updates, offline message replay, automatic reconnect, and a responsive browser UI. Redis, group chat, media, calls, push notifications, and multi-instance routing remain outside this build.

## Implementation approach

- **Runtime:** Node.js 20, Express, `ws`, `pg`, `bcryptjs`, and `jsonwebtoken`. The service listens on `PORT`/`0.0.0.0` and serves `public/`.
- **Data layer:** `src/db.js` exposes a small repository API. PostgreSQL uses parameterized SQL and the PRD schema; no-`DATABASE_URL` development uses the same API against memory only. The memory mode is never selected when a database URL is configured.
- **Authentication:** `src/auth.js` hashes passwords with bcrypt-compatible `bcryptjs`, signs two-hour JWTs, and provides the protected-route middleware. The WebSocket upgrade verifies the same token before registering the socket.
- **REST:** `src/routes.js` handles account, user, conversation, history, and health endpoints. Rate limiting protects registration and login. Authorization checks conversation participation before history access.
- **WebSocket:** `src/ws.js` maintains a single-instance `Map<userId, socket>`, validates JSON event payloads, persists messages before acknowledging, forwards online messages, replays pending messages after reconnect, and runs a 25-second heartbeat. Client-generated UUIDs make retries idempotent.
- **Browser client:** `public/index.html`, `public/app.js`, and `public/styles.css` implement four hash-addressable views—register, login, dashboard, and conversation—without a frontend framework. The client stores only the JWT and a small outbox in local storage, reconnects at 1/2/4/8/16/30-second intervals, and uses `textContent` for message rendering.
- **Deployment:** `Dockerfile`, `cloudbuild.yaml`, `schema.sql`, and README instructions prepare the same service for Cloud Run with Cloud SQL, Secret Manager variables, one instance, and a 3600-second request timeout.

## Project structure

```text
chatbridge/
├── server.js                 # Express + HTTP server + WebSocket bootstrap
├── src/
│   ├── auth.js               # JWT and password helpers
│   ├── db.js                 # PostgreSQL/memory repository and schema setup
│   ├── routes.js             # REST API routes and validation
│   └── ws.js                 # Upgrade auth, registry, events, heartbeat
├── public/
│   ├── index.html            # Single shell for four compact views
│   ├── app.js                # Hash routing, REST client, WebSocket client
│   └── styles.css            # Responsive Signal Desk visual system
├── schema.sql                # PostgreSQL DDL matching the PRD
├── Dockerfile                # Cloud Run container contract
├── cloudbuild.yaml           # Build and deploy example
├── manus-routes.json         # Webdev route manifest
├── app.config.ts             # Project logo metadata
├── package.json              # Runtime scripts and dependencies
└── README.md                 # Local run, demo, and GCP deployment notes
```

## Design direction

### Three possible movements

- **Signal Desk — 0.07:** a dark, instrument-panel workspace with a bright lime signal color and editorial hierarchy.
- **Campus Ledger — 0.05:** a warm paper-like academic notebook with ink-blue controls and red annotation accents.
- **Quiet Relay — 0.03:** an airy monochrome messenger with a single electric-blue status pulse.

### Selected style: Signal Desk

- **Design movement:** modern observability console meets a focused messaging workspace.
- **Core principles:** make connection state visible; keep the active conversation dominant; prefer compact, scannable surfaces; use color only for state and action.
- **Color philosophy:** charcoal and slate reduce visual noise for a technical demo, while signal lime marks active connectivity and electric blue reserves attention for read state. Warm paper text prevents the UI from feeling sterile.
- **Layout paradigm:** an asymmetric split workspace: a narrow identity/navigation rail, a flexible conversation panel, and a right-side context column on wide screens; stacked views on small screens.
- **Signature elements:** a thin lime “live line” under the brand mark, pill-shaped connection states, and message bubbles with tiny instrument-style tick marks.
- **Interaction philosophy:** actions should feel immediate and inspectable. Every send produces a visible state transition; offline/reconnecting states stay explicit instead of being hidden.
- **Animation:** use short 160–220ms fades and slide-ins for view changes and message arrival; pulse only the live connection dot; never animate continuously when disconnected.
- **Typography system:** use system sans for readable controls and a monospace eyebrow for event labels, timestamps, and statuses. Oversized headlines are compact and left-aligned.
- **Brand essence:** a small, dependable relay for student-to-student messages; direct, legible, teachable.
- **Brand voice:** headlines say what is happening, e.g. “Open a private channel” and “Connection restored.” Microcopy is calm and concrete, e.g. “Messages are saved before delivery.”
- **Wordmark & logo:** “CHAT//BRIDGE” paired with a two-node bridge glyph built from a continuous line.
- **Signature brand color:** signal lime `#c7f36b`.

## Build workflow

1. Install the pinned Node dependencies and run the syntax checks.
2. Start the service on port 3000 for Preview; verify `/health` and `/manus-routes.json`.
3. Run the app in memory mode for UI smoke checks, and use PostgreSQL mode in deployment or when `DATABASE_URL` is supplied.
4. Prepare the Cloud Run declaration with the existing server capability and `/health` health path.
5. Copy the completed source into the requested GitHub checkout, commit the milestone, and push it to `main` without force-pushing.
