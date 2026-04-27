# Karya / Kaarya — Operations Runbook

Single entry point for everything an operator needs. The product ships as
**two repos** that are deployed together onto a single Windows server fronted
by IIS:

| Repo                                         | Role                                  |
|----------------------------------------------|---------------------------------------|
| [`Hub`](https://github.com/Valuecart-Pvt-Ltd/Hub)       | React + Vite SPA. Karya meeting/MOM UI **and** Kaarya task-board UI live in the same bundle (Kaarya pages are code-split). |
| [`HubAPI`](https://github.com/Valuecart-Pvt-Ltd/HubAPI) | Node.js + Express + TypeScript. Serves both apps: `/api/*` (Karya + Kaarya REST) and `/socket.io/*` (live updates). MSSQL database in the same instance. |

> Detailed step-by-step instructions live in each repo's [`DEPLOY.md`](./DEPLOY.md) — the
> [Hub deploy guide](https://github.com/Valuecart-Pvt-Ltd/Hub/blob/main/DEPLOY.md) is the
> companion. This runbook is the index that ties them together.

## Architecture at a glance

```
                       ┌──────────────────────────────────────┐
                       │  IIS site:  hub.example.com:443      │
                       │                                      │
                       │   /              → Hub  dist (static)│  URL Rewrite SPA fallback
                       │   /api/*         → HubAPI  iisnode   │  rate-limited /auth, helmet CSP
                       │   /socket.io/*   → HubAPI  iisnode   │  WebSockets — Karya + Kaarya rooms
                       └──────────────────────────────────────┘
                                          │
                                          ▼
                       ┌──────────────────────────────────────┐
                       │  MSSQL (same server)                  │
                       │  database: karya_prod                 │
                       │   · Karya:  events, mom_*, users      │
                       │   · Kaarya: kaarya_*  (workspaces,    │
                       │             boards, cards, lists,     │
                       │             labels, members, …)       │
                       └──────────────────────────────────────┘
```

A single login covers both apps — JWT HS256, same `JWT_SECRET` on both sides.
A user can move between `/` (Karya) and `/kaarya` (Kaarya boards) in the same
tab, and MOM action items can be configured to auto-create Kaarya cards.

## Phase merge order

PRs were intentionally stacked so each builds on the previous. **Merge in this
order** (or squash-merge each one on its own; the diffs don't conflict):

| Order | HubAPI branch | Hub branch | What it delivers |
|---|---|---|---|
| 1 | `phase-0-mssql`              | `phase-0-mssql`              | Postgres → MSSQL migration · Trello removal · IIS web.config · socket.io scaffold |
| 2 | `phase-1-kaarya`             | `phase-1-kaarya`             | Kaarya integrated (workspaces, boards, lists, cards, kanban, live updates) |
| 3 | `phase-3-mom-sync`           | `phase-3-mom-sync`           | Karya MOM ↔ Kaarya card sync (event→board mapping, auto-sync) |
| 4 | `phase-4-polish`             | `phase-4-polish`             | Synced badge · search/sort/filters · dark mode · code-split |
| 5 | `phase-4b-polish`            | `phase-4b-polish`            | Card detail modal · recurring tasks · analytics dashboard |
| 6 | `phase-4c-4d-board-polish`   | `phase-4c-4d-board-polish`   | Card drag-and-drop · members + labels editing |
| 7 | `phase-5-deploy`             | `phase-5-deploy`             | helmet · rate-limit · Neon → MSSQL import · DEPLOY runbook |
| 8 | `phase-6-followups`          | `phase-6-followups`          | Invitations · list DnD · realtime fan-out · CSP enabled · AppInsights · backup automation |

After all 8 are merged to `main`, the branches can be deleted.

## First-time deploy — rough timeline

| Step | Where | Time | Reference |
|---|---|---|---|
| Server prerequisites (Node, iisnode, URL Rewrite, ARR, WebSocket Protocol, SQL Server) | Server, elevated PS | 30–45 min | [HubAPI DEPLOY § One-time server setup](./DEPLOY.md#one-time-server-setup) |
| Database first-time setup (TCP/IP, mixed-mode, CREATE DATABASE, app login) | Server | 5 min | [HubAPI DEPLOY § Database first-time setup](./DEPLOY.md#database-first-time-setup) |
| HubAPI clone + `npm ci --omit=dev` + `npm run build` | Server | 5 min | [HubAPI DEPLOY § App deployment — first time](./DEPLOY.md#app-deployment--first-time) |
| HubAPI `npm run migrate` (applies all 8 SQL files) | Server | < 1 min | same |
| _Optional:_ cutover from Neon — `export:neon` then `import:mssql` | any → server | 5–60 min depending on size | [HubAPI DEPLOY § Cutover from Neon Postgres](./DEPLOY.md#cutover-from-neon-postgres-only-if-migrating-live-data) |
| Hub clone + `npm ci` + `npm run build` | Build host | 3 min | [Hub DEPLOY § Deploy](https://github.com/Valuecart-Pvt-Ltd/Hub/blob/main/DEPLOY.md#deploy) |
| IIS site setup (binding, app pool, `/api` virtual app for the Layout-A topology) | Server | 10 min | [Hub DEPLOY § Initial site setup](https://github.com/Valuecart-Pvt-Ltd/Hub/blob/main/DEPLOY.md#initial-site-setup-one-time) |
| Set env vars via App Pool → Advanced Settings (DB_*, JWT_SECRET, Google OAuth, SMTP_*) | Server, IIS Manager | 5 min | [HubAPI DEPLOY § Setting environment variables securely](./DEPLOY.md#setting-environment-variables-securely) |
| Configure Google OAuth callback URL in Cloud Console | Browser | 2 min | [HubAPI DEPLOY § OAuth provider configuration](./DEPLOY.md#oauth-provider-configuration) |
| Verify (`/api/health`, login flow, sockets, deep-link) | Browser/curl | 5 min | [HubAPI DEPLOY § Verifying the deploy](./DEPLOY.md#verifying-the-deploy) |
| Backups: `setup-backup.ps1` registers the nightly Scheduled Task | Server, elevated PS | 2 min | [HubAPI DEPLOY § Backup automation](./DEPLOY.md#backup-automation) |
| _Optional:_ AppInsights — set `APPLICATIONINSIGHTS_CONNECTION_STRING` env var | Server | 1 min | [HubAPI DEPLOY § Application Insights](./DEPLOY.md#application-insights-opt-in) |

**Total: ~75–90 minutes for a clean install.**

## Updates / re-deploys

```powershell
# HubAPI
cd C:\inetpub\HubAPI
git pull
npm ci --omit=dev
npm run build
npm run migrate                 # idempotent — safe on every deploy
iisreset /restart               # or restart the HubAPI app pool only

# Hub
# (on the build host)
git pull
npm ci
npm run build

# (on the server)
Stop-WebSite  -Name 'hub.example.com'
robocopy .\dist C:\inetpub\Hub\dist /MIR
copy web.config C:\inetpub\Hub\web.config
Start-WebSite -Name 'hub.example.com'
```

Migrations are `CREATE OR ALTER` for SPs and `IF NOT EXISTS` for tables —
`npm run migrate` on every HubAPI deploy is safe and fast. Hashed asset
filenames in the Hub bundle change per build, so old browser tabs keep
working until they reload.

## Operations cheatsheet

| Action | Command |
|---|---|
| Health check | `Invoke-RestMethod https://hub.example.com/api/health` |
| List active node processes | `Get-Process node` |
| Restart only HubAPI | `Restart-WebAppPool -Name 'HubAPI'` |
| Tail iisnode logs | `Get-Content C:\inetpub\HubAPI\iisnode\*.txt -Tail 50 -Wait` |
| Force a backup now | `Start-ScheduledTask -TaskName 'Karya nightly backup'` |
| List recent backups | `Get-ChildItem C:\backups\karya\*.bak \| Sort LastWriteTime -Descending \| Select -First 5` |
| Run a one-off SQL query | `sqlcmd -S localhost -d karya_prod -U karya_app -P '<pwd>' -Q "SELECT COUNT(*) FROM events"` |
| List unapplied schema diffs | `npm run migrate` (it's idempotent — no-ops if everything is current) |

## Where to look when things break

| Symptom | First place to look | Then |
|---|---|---|
| 500 on `/api/health` | iisnode log (`C:\inetpub\HubAPI\iisnode\*`) | App pool environment variables (DB_PASSWORD, JWT_SECRET) |
| Login redirects fail with `invalid_grant` | Google Cloud Console → OAuth client → authorised redirect URIs | `SERVER_URL` env var on the API matches what Google calls |
| `/kaarya/boards/anything` returns 404 | URL Rewrite installed in IIS | `web.config` present in `C:\inetpub\Hub\` |
| Sockets fail to upgrade | "WebSocket Protocol" IIS feature installed | `webSocket enabled="true"` in HubAPI's `web.config` |
| `/api/auth/login` returns 429 | rate-limit hit (20 / 15 min / IP) | wait or whitelist the IP |
| Migration fails on first run | TCP/IP or mixed-mode auth not enabled | re-run the elevated SQL Server reconfig snippet |
| MOM items not showing up as Kaarya cards | the event has no Kaarya board mapped | open the event detail → Kaarya panel → pick a board |
| Pending invitation never delivered | SMTP env vars not set OR `SMTP_USER` doesn't have send permission | check `[email] SMTP not configured` warnings in iisnode log |

## Security baseline (already in place)

Reference: [HubAPI DEPLOY § Hardening in place](./DEPLOY.md#hardening-in-place).

- Helmet baseline + CSP (`script-src 'self'`, no inline JS allowed)
- HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy via web.config
- `express-rate-limit` on `/api/auth/login` and `/api/auth/register`
- Body size capped at 1 MB (Express) / 2 MB (IIS)
- TLS to MSSQL (`Encrypt=true`)
- Server fingerprint (`Server`, `X-Powered-By`) stripped from responses
- JWT HS256 with shared secret; sockets verify on handshake

## What's still TODO post-launch

- Stricter CSP (remove `'unsafe-inline'` for styles by hashing or nonce-ing
  React's inline style attributes)
- Split DB roles: dedicated `karya_migrate` (DDL) + `karya_app` (DML only)
- Subresource Integrity (SRI) for the bundle
- Offsite backup copy (current script writes to local disk only)
- Real APM dashboard wiring once an Application Insights instance is
  provisioned

## Contact & runbook ownership

Whoever holds this server's keys. If you're reading this for the first time,
start at [`HubAPI/DEPLOY.md`](./DEPLOY.md), then jump to
[`Hub/DEPLOY.md`](https://github.com/Valuecart-Pvt-Ltd/Hub/blob/main/DEPLOY.md).
