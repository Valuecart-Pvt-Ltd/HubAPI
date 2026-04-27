# HubAPI

Node.js + Express + TypeScript backend for the Valuecart Hub application.
Serves both **Karya** (meetings + minutes) and **Kaarya** (task boards) from
a single API and a shared MSSQL database.

> **Operators:** start at [`RUNBOOK.md`](./RUNBOOK.md) for the production
> story, or [`DEPLOY.md`](./DEPLOY.md) for the step-by-step IIS install.

## Stack

- Node.js 20, Express 4, TypeScript
- MSSQL via the `mssql` package (TLS, connection pool)
- Passport (Google + Microsoft OAuth)
- Socket.IO for live MOM and card updates (JWT HS256 handshake)
- googleapis for Calendar integration
- node-cron for scheduled sync jobs

## Setup

```bash
cp .env.example .env      # fill in secrets
npm install
npm run migrate           # run DB migrations against DATABASE_URL
npm run dev               # http://localhost:4000
```

## Scripts

| Command          | Purpose                          |
|------------------|----------------------------------|
| `npm run dev`    | nodemon + ts-node, port 4000     |
| `npm run build`  | `tsc` → `dist/`                  |
| `npm run start`  | run compiled `dist/index.js`     |
| `npm run migrate`| apply pending SQL migrations     |
| `npm run seed`   | seed dev data                    |

## Shared types

Types consumed by the frontend live in `src/types/shared.ts`. Keep this file
in sync with the corresponding copy in the Hub repo when either changes.

## Deploy

See `Dockerfile` for a two-stage build that produces a runtime image listening
on port 4000.
