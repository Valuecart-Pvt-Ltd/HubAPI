# HubAPI — IIS Deployment Runbook

End-to-end runbook for deploying HubAPI on a Windows server fronted by IIS.
Pair with `Hub/DEPLOY.md` for the matching frontend deploy — they share a
domain in production.

## Architecture

```
                    ┌─────────────────────────────┐
                    │  IIS site (e.g. hub.example) │
                    │                             │
                    │  /api/*       → HubAPI dist │  ← iisnode
                    │  /socket.io/* → HubAPI dist │  ← iisnode (WebSockets)
                    │  everything else → Hub dist │  ← static (URL Rewrite SPA)
                    └─────────────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────┐
                    │  MSSQL on the same box      │
                    │  database: karya_prod       │
                    └─────────────────────────────┘
```

Karya **and** Kaarya share this single API + database. JWTs are HS256, so the
same `JWT_SECRET` covers both apps.

## One-time server setup

Install the following on the Windows Server (Server 2019+ or Windows 10/11):

| Component                        | Why                                |
|----------------------------------|------------------------------------|
| **Node.js LTS (≥20)**            | Runs the API                       |
| **iisnode**                      | IIS handler that hosts node.js     |
| **URL Rewrite 2.x**              | `/api`/`/socket.io` routing        |
| **Application Request Routing**  | Static SPA fallback                |
| **WebSocket Protocol** (IIS feature) | Server Manager → Add Roles & Features → Web Server (IIS) → Application Development → WebSocket Protocol |
| **SQL Server 2019+** (Developer or Standard) | Database                |
| **SQL Server Management Studio (SSMS)** | Admin queries                |

After installing iisnode, restart IIS (`iisreset`).

## Database first-time setup

Run from an elevated PowerShell on the SQL Server box:

```powershell
# 1. Enable TCP/IP and Mixed-Mode auth (one-time, restarts MSSQLSERVER)
$base = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL15.MSSQLSERVER'   # adjust for your version
Set-ItemProperty -Path "$base\MSSQLServer\SuperSocketNetLib\Tcp" -Name Enabled -Value 1
Set-ItemProperty -Path "$base\MSSQLServer" -Name LoginMode -Value 2
Restart-Service MSSQLSERVER -Force

# 2. Create the prod DB and a least-privilege login
sqlcmd -E -S localhost -Q @"
CREATE DATABASE karya_prod;
GO
USE karya_prod;
CREATE LOGIN karya_app WITH PASSWORD = '<choose_a_strong_one>';
CREATE USER  karya_app FOR LOGIN karya_app;
ALTER ROLE   db_owner ADD MEMBER karya_app;   -- needs DDL during migrate; demote later if you split deploys
"@
```

> Use a **dedicated SQL login per environment**. Don't reuse local-dev passwords.

## App deployment — first time

On the server (or a build host with same OS):

```powershell
# 1. Clone main (after the phase-0 → phase-5 PRs are merged)
git clone https://github.com/Valuecart-Pvt-Ltd/HubAPI.git C:\inetpub\HubAPI
cd C:\inetpub\HubAPI

# 2. Install + build
npm ci --omit=dev          # production deps only
npm run build              # tsc → dist/

# 3. Apply schema + stored procs (run once)
copy .env.example .env
notepad .env               # fill in DB_*, JWT_SECRET, OAuth, SMTP, SERVER_URL, CLIENT_URL
npm run migrate
```

### Cutover from Neon Postgres (only if migrating live data)

```powershell
# On any machine that can still reach Neon:
$env:NEON_DATABASE_URL = '<neon connection string>'
npm install --no-save pg @types/pg
npm run export:neon       # writes neon-export-<ts>.json

# Move the JSON to the new server, then:
npm run import:mssql neon-export-<ts>.json
```

## IIS site configuration

In IIS Manager:

1. **Create or pick a site** with a binding for your domain (e.g. `hub.example.com:443` with TLS cert).
2. **Application Pool**:
   - .NET CLR Version: **No Managed Code**
   - Pipeline Mode: **Integrated**
   - Identity: a service account with read access to the deploy folder
   - Idle Time-out: bump to 0 (don't recycle on idle — sockets matter)
   - Set environment variables via the pool's "Advanced Settings → Environment Variables" if your IIS supports it, OR via web.config `<appSettings>` (see below).
3. **Site root** → `C:\inetpub\HubAPI` (this folder must contain `dist/`, `node_modules/`, `web.config`, `package.json`).
4. **Bindings**: HTTPS only in production. Add HTTP→HTTPS redirect via URL Rewrite if needed.
5. **Enable WebSockets** (Configuration Editor → `system.webServer/webSocket`). The committed `web.config` already requests `<webSocket enabled="true" />`, but the server feature must be installed.

### Setting environment variables securely

Don't put secrets in `web.config`. Two safe options:

- **Option A (recommended): Configuration Editor** → Section: `system.webServer/iisnode` → set `node_env` to `production`. For app secrets, use **Application Pool → Advanced Settings → Environment Variables** (only on Server 2019+ Windows Process Activation Service). Restart the pool.
- **Option B**: encrypt a `.env` file with DPAPI and decrypt at startup. Out of scope for this doc; do A unless you have a regulatory reason.

## Required env vars

Mirror of `.env.example`:

```
DB_SERVER=localhost
DB_PORT=1433
DB_NAME=karya_prod
DB_USER=karya_app
DB_PASSWORD=<from secrets store>
DB_ENCRYPT=true
DB_TRUST_CERT=true
DB_POOL_MAX=20

JWT_SECRET=<32+ random bytes — MUST match Hub if you ever fall back to dev mode>
SESSION_SECRET=<random>

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=          # optional
MICROSOFT_CLIENT_SECRET=      # optional

READAI_WEBHOOK_SECRET=        # optional (Read.ai)
FIREFLIES_WEBHOOK_SECRET=     # optional (Fireflies)

PORT=4000                     # iisnode binds whatever port you set
SERVER_URL=https://hub.example.com
CLIENT_URL=https://hub.example.com   # comma-separated for multiple origins
COMPANY_DOMAIN=valuecart.com

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
```

## OAuth provider configuration

In Google Cloud Console → your OAuth client → **Authorized redirect URIs**:

```
https://hub.example.com/api/auth/google/callback
```

In Microsoft Entra (if used):

```
https://hub.example.com/api/auth/microsoft/callback
```

The `SERVER_URL` env var must equal the public origin used in those callback URLs.

## Verifying the deploy

```powershell
# Health endpoint (no auth):
Invoke-RestMethod https://hub.example.com/api/health
# → { status: 'ok', timestamp: '...' }

# Auth flow:
# 1. Open https://hub.example.com/login in a browser
# 2. Sign in via Google
# 3. /api/auth/google/callback → /auth/callback?token=…
# 4. Browser hands token to /api/auth/me → returns user
# 5. Sockets connect on the same JWT — DevTools Network → WS → /socket.io
```

## Updates / re-deploys

```powershell
cd C:\inetpub\HubAPI
git pull
npm ci --omit=dev
npm run build
npm run migrate                # idempotent — applies any new SP / schema diffs
iisreset /restart              # or just restart the application pool
```

> Migrations are CREATE OR ALTER for SPs and IF NOT EXISTS for tables — running
> `npm run migrate` on every deploy is safe.

## Logs

iisnode writes to `<site root>/iisnode/`. The committed `web.config` enables
this. Rotate / archive externally — iisnode itself does not.

For higher fidelity, redirect stdout/stderr to a date-rotated file by adding a
small `logger.ts` and piping via `pino-rotating-file` — out of scope for now;
console output via iisnode is sufficient for the Phase 5 launch.

## Hardening already in place (Phase 5)

- `helmet()` baseline security headers.
- `app.set('trust proxy', 1)` so `req.ip` reflects the real client behind IIS.
- `express-rate-limit` on `/api/auth/login` and `/api/auth/register` — 20 req
  per 15 min per IP.
- `express.json({ limit: '1mb' })` cap on request bodies.
- `web.config` `requestLimits maxAllowedContentLength=2097152` (2 MB) at the
  IIS layer.
- `mssql` connections use `Encrypt=true` + `TrustServerCertificate=true` so
  TLS is on by default. For prod, install a real CA cert and flip
  `DB_TRUST_CERT=false`.

## Hardening still TODO (post-launch)

- **CSP headers** — currently disabled in `helmet` because the bundle uses
  inline styles via Tailwind. Add a nonce-based CSP in a follow-up.
- **Dedicated migration login** — the deploy uses `db_owner`; for stricter
  prod, split into a `karya_migrate` (DDL) and `karya_app` (DML only).
- **Backup schedule** — set up SQL Server scheduled backups + offsite copy.
- **Application Insights / OpenTelemetry** — wire up real APM.
