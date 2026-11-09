# ChatBridge

ChatBridge is a deliberately small CSC-423 real-time messaging application, not an AI chatbot. It demonstrates the core path from a browser to a central WebSocket server: users register and log in, open a persistent socket, send one-to-one text messages, and receive delivery/read status updates. The service stores durable data in PostgreSQL and serves the plain HTML/CSS/JavaScript client, REST API, and WebSocket endpoint from one Node.js process. See [TRANSPORT_LAYER_REPORT.md](TRANSPORT_LAYER_REPORT.md) for the TCP/WebSocket and TCP-vs-UDP analysis.

## What is included

The first implementation includes unique username/email registration, bcrypt-compatible password hashing, two-hour JWT login, protected REST routes, a `/ws?token=<JWT>` upgrade endpoint, an in-memory user-to-socket registry for a single Cloud Run instance, automatic reconnect with 1/2/4/8/16/30-second backoff, a 25-second heartbeat, duplicate-safe client message IDs, offline delivery, and Sent/Delivered/Read status ticks. The UI is intentionally framework-free and contains login, register, dashboard, and conversation views.

Redis, group chats, calls, file sharing, push notifications, end-to-end encryption, multi-region deployment, and multi-instance routing are future improvements rather than hidden requirements. If the project grows beyond one Cloud Run instance, add Redis Pub/Sub for cross-instance delivery and presence.

## Run locally

Requirements: Node.js 22.13+ and pnpm 11+.

```bash
pnpm install
cp .env.example .env
pnpm check
pnpm test
pnpm start
```

Open `http://localhost:3000`. With no PostgreSQL variables, the application reports `memory-development` at `/health`, which is useful for a quick UI or WebSocket demonstration and is reset when the process stops. For durable local data, set `DATABASE_URL` to a PostgreSQL database before starting; the server applies `schema.sql` on startup. An invalid or partial database configuration is rejected, and production never falls back to memory mode. The managed Preview's injected non-PostgreSQL development DSN is intentionally ignored so the requested PostgreSQL path remains explicit.

The automated suite starts the HTTP server on an ephemeral port and verifies health, account creation, duplicate protection, authorization, two-client online delivery, offline replay after reconnect, history persistence, and invalid WebSocket tokens. It uses the same memory adapter as a no-database Preview, so it does not modify a shared PostgreSQL environment.

The main development endpoints are:

- `GET /health` — unauthenticated readiness check.
- `POST /api/register` and `POST /api/login` — account access.
- `GET /api/users` — list other users.
- `POST /api/conversations` — create or fetch a private conversation.
- `GET /api/conversations/:id/messages?limit=50` — participant-only history.
- `wss://<host>/ws?token=<JWT>` — authenticated WebSocket event channel.

## PostgreSQL and Cloud Run

Create a PostgreSQL database, apply `schema.sql`, and provide either `CHATBRIDGE_DATABASE_URL`, `DATABASE_URL`, or the Cloud SQL variables shown in `.env.example`. The managed hosting path uses the project-scoped `CHATBRIDGE_DATABASE_URL` override because its reserved `DATABASE_URL` may refer to a different database engine. For Cloud SQL through the Unix socket, set `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SOCKET_DIR=/cloudsql`, and `INSTANCE_CONNECTION_NAME=PROJECT:REGION:INSTANCE`. Store database credentials and `JWT_SECRET` in protected environment configuration; do not commit them.

The included `Dockerfile` listens on the runtime `PORT` and the included `cloudbuild.yaml` shows a small Cloud Build → Artifact Registry → Cloud Run flow. A typical production deployment keeps `--max-instances=1`, sets `--timeout=3600`, attaches Cloud SQL, injects the database/JWT secrets, and sets `ALLOWED_ORIGIN` to the service's HTTPS URL. When `ALLOWED_ORIGIN` is omitted, the WebSocket layer securely derives the same-origin HTTPS host from the deployment request; cross-origin requests are still rejected. Production startup requires a JWT secret of at least 32 characters and PostgreSQL configuration, and refuses to start when either is missing. Cloud Run supplies HTTPS, so the browser automatically uses `wss://` for the same origin.

Example setup commands, after selecting a GCP project and region:

```bash
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

gcloud artifacts repositories create chat-repo \
  --repository-format=docker --location=us-central1
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD),\
_INSTANCE_CONNECTION_NAME=PROJECT_ID:us-central1:chat-db,\
_ALLOWED_ORIGIN=https://YOUR-SERVICE-URL
```

Create the Cloud SQL instance and Secret Manager values using the current `gcloud` help for your account. The PRD's deployment guide documents the smallest demo-oriented tier, Cloud SQL Client role, Secret Manager accessor role, and the service update needed after the first URL is known.

## Demo script

Open the app in two or three browsers. Register distinct users, log in, and confirm the header moves through Connecting to Connected. From the dashboard, open a user, send a text message, and observe the sender acknowledgement, recipient delivery, and blue read ticks. Stop one browser or log it out, send another message, then reconnect that user and observe the pending message replay. Reload the conversation to confirm history comes from the API.

## Architecture note

`server.js` starts Express and the HTTP upgrade listener. `src/auth.js` owns password/JWT helpers, `src/db.js` isolates PostgreSQL and development-memory operations, `src/routes.js` owns REST and authorization checks, and `src/ws.js` owns the authenticated registry, message protocol, heartbeat, and status transitions. `public/app.js` keeps an unacknowledged local outbox and retries the same message ID after a connection drop, making the database primary key the duplicate-prevention boundary.
