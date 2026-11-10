# ChatBridge Assignment Technical Report

## 1. Introduction
ChatBridge is a deliberately small real‑time messaging application built for the CSC‑423 course. It demonstrates a complete end‑to‑end stack from a browser client to a central WebSocket server, supporting registration, authentication, one‑to‑one messaging, and delivery/read status tracking. The system stores durable data in PostgreSQL and can fall back to an in‑memory store for development or environments without a database.

## 2. System Design
### 2.1 Architecture Overview
- **Client**: Plain HTML/CSS/JavaScript UI served from the same Node.js process.
- **API Layer**: Express REST endpoints for registration, login, user lookup, conversation creation, and message history.
- **WebSocket Layer**: Authenticated `ws` endpoint (`/ws?token=<JWT>`) handling real‑time events, heart‑beats, and status ticks.
- **Persistence**:
  - Primary: PostgreSQL (schema defined in `schema.sql`).
  - Development fallback: In‑memory adapter that mimics the PostgreSQL API.
- **Deployment**: Deployable on Vercel, Cloud Run, or local Docker. Environment variables (`JWT_SECRET`, `CHATBRIDGE_DATABASE_URL`, etc.) control configuration.

### 2.2 Component Diagram
```
graph TD
    Browser[Browser] -->|HTTPS / REST| Express[Express Server]
    Browser -->|WebSocket| WS[WebSocket Server]
    Express -->|SQL Queries| PG[PostgreSQL]
    WS -->|SQL Queries| PG
```
*(Rendered as `app-arch.png` from `app-arch.mmd` – see `app-arch.mmd`)*

## 3. TCP Implementation & Message Protocol
- **Transport**: TCP is used for all HTTP and WebSocket traffic. The Node.js runtime creates a single TCP listener on the port provided by the environment (`process.env.PORT`).
- **WebSocket Framing**: Binary frames carry JSON messages.
- **Message Types**:
  - `MSG_SEND` – client → server, includes a client‑generated UUID `msgId`.
  - `MSG_DELIVERED` – server → recipient, echoes `msgId`.
  - `MSG_READ` – recipient → server to acknowledge read.
  - `HEARTBEAT` – periodic ping/pong to keep the socket alive.
- **Reliability**: The client stores unsent messages locally and retries on reconnection using the same `msgId`, ensuring exactly‑once delivery on the server side.

## 4. TCP vs UDP Analysis (see `TRANSPORT_LAYER_REPORT.md`)
The accompanying `TRANSPORT_LAYER_REPORT.md` evaluates the trade‑offs of TCP vs UDP for real‑time chat, concluding TCP’s guaranteed delivery, ordering, and congestion control outweigh UDP’s lower latency for this use‑case.

## 5. Testing Methodology
- **Unit / Integration Tests** (`npm test`):
  - Health endpoint verification.
  - Registration & login flow, duplicate protection.
  - Two‑client online message delivery.
  - Offline message replay after reconnect.
  - History pagination.
- **Test Log**: Consolidated in `TEST_LOG.md`.
- **Packet Captures**: Captured via `tcpdump` during the test suite; stored as `chatbridge-local.pcap` (see `artifacts/`).
- **Automated Demo**: `demo.js` drives two headless Chromium instances with Puppeteer, performs registration, login, message exchange, and captures screenshots (`demo-*.png`) and a short video (`demo.mp4`).

## 6. Deployment
### 6.1 Local Development
```bash
pnpm install
cp .env.example .env   # set JWT_SECRET and DATABASE_URL or leave empty for in‑memory mode
pnpm check               # lint & type‑check
pnpm test                # run test suite
pnpm start               # start server on $PORT (default 3000)
```
### 6.2 Vercel Deployment
1. Link the GitHub repository to Vercel.
2. Add required environment variables in the Vercel dashboard:
   - `JWT_SECRET` (≥32 characters)
   - `CHATBRIDGE_DATABASE_URL` (PostgreSQL DSN) **or** Cloud‑SQL socket variables (`DB_USER`, `DB_PASSWORD`, `DB_NAME`, `INSTANCE_CONNECTION_NAME`).
3. Deploy – Vercel will install dependencies, build, and expose the app at the generated URL.
4. Verify with `curl https://<your‑app>.vercel.app/health` – should return `{ok:true, service:'chatbridge', database:'postgres'}`.

### 6.3 Cloud Run (optional)
Use the provided `Dockerfile` and `cloudbuild.yaml`. See `README.md` for the `gcloud` commands.

## 7. Limitations & Future Work
- Single‑instance in‑memory fallback does not survive process restarts.
- No group chat, file sharing, push notifications, or end‑to‑end encryption.
- Scaling beyond one instance requires a distributed presence layer (e.g., Redis Pub/Sub).
- UDP‑based media streaming is not supported.

## 8. Deliverables
- Source code (this repository) with updated README.
- `REPORT.md` (this document).
- Architecture diagrams: `app-arch.mmd` → `app-arch.png`, `cloud-arch.mmd` → `cloud-arch.png`.
- Demo artifacts in `artifacts/`:
  - Screenshots `demo-*.png`
  - Demo video `demo.mp4`
  - Packet capture `chatbridge-local.pcap`
- TCP/UDP comparison table `tcp-udp-comparison.md`.
- Test log `TEST_LOG.md`.
- Updated `.gitignore` to exclude generated artefacts.

---
*All artefacts are stored in the repository under `artifacts/` and rendered PNGs are also placed alongside their source `.mmd` files.*