import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'
// Load .env from the repo root regardless of which directory npm run dev is
// invoked from. __dirname here is src/, so one level up = repo root.
loadEnv({ path: resolve(__dirname, '..', '.env') })

// ─── Application Insights (opt-in via env var) ───────────────────────────────
// Setting APPLICATIONINSIGHTS_CONNECTION_STRING auto-instruments the Express
// app: incoming HTTP, outgoing HTTP, console logs, exceptions. No data leaves
// the process until the env var is set, so this is safe in dev.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ai = require('applicationinsights') as typeof import('applicationinsights')
  ai.setup()
    .setAutoCollectConsole(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectRequests(true)
    .setAutoCollectDependencies(true)
    .setSendLiveMetrics(false)
    .start()
  console.log('[apm] Application Insights enabled')
}

import http from 'http'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { Server as SocketServer, Socket } from 'socket.io'

// Must be imported before any route that uses passport
import './config/passport'
import passport from 'passport'

import { CLIENT_ORIGINS } from './config/urls'
import { authRouter }     from './routes/auth'
import { productsRouter } from './routes/products'
import { cartRouter }     from './routes/cart'
import { ordersRouter }   from './routes/orders'
import { eventsRouter }   from './routes/events'
import { momRouter }      from './routes/mom'
import { webhookRouter }  from './routes/webhooks'
// Kaarya routers (Phase 1 — task boards live in the same backend as Karya
// and share the JWT, the DB pool, and the socket.io server)
import { workspacesRouter as kaaryaWorkspacesRouter } from './routes/kaarya-workspaces'
import { boardsRouter     as kaaryaBoardsRouter }     from './routes/kaarya-boards'
import { cardsRouter      as kaaryaCardsRouter }      from './routes/kaarya-cards'
import { errorHandler }   from './middleware/errorHandler'
import { startCalendarSyncCron } from './services/calendarService'
import { ioRef }          from './io'
import type { AuthTokenPayload } from './types/shared'

const app  = express()
const PORT = process.env.PORT ?? 4000

// ─── Behind-proxy / IIS configuration ─────────────────────────────────────────
// Under iisnode the request arrives over a Named Pipe. Express needs to be told
// to trust forwarded headers so req.ip + req.protocol reflect the real client.
app.set('trust proxy', 1)

// ─── Global middleware ────────────────────────────────────────────────────────

app.use(helmet({
  // CSP allows inline styles only — required because React props like
  // style={{ background: ... }} produce inline style attributes. Inline
  // scripts remain forbidden, so XSS vectors via injected <script> are
  // still blocked.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      fontSrc:    ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // for socket.io upgrades
  crossOriginEmbedderPolicy: false,
}))
app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(passport.initialize())

// ─── Rate limiting on the auth endpoints ─────────────────────────────────────
// Only /api/auth/login + /api/auth/register get throttled — calendar sync
// and ordinary CRUD aren't worth limiting at this layer.
const authLimiter = rateLimit({
  windowMs:        15 * 60_000,             // 15 min
  limit:           20,                      // per-IP per window
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { success: false, error: 'Too many auth attempts, slow down', code: 'rate_limited', statusCode: 429 },
})
app.use('/api/auth/login',    authLimiter)
app.use('/api/auth/register', authLimiter)

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth',       authRouter)
app.use('/api/products',   productsRouter)
app.use('/api/cart',       cartRouter)
app.use('/api/orders',     ordersRouter)
app.use('/api/events',     eventsRouter)
app.use('/api/mom',        momRouter)
app.use('/api/webhooks',   webhookRouter)

// Kaarya routes — separate URL space from Karya, same JWT auth, same db pool.
// /api/workspaces, /api/boards/:id, /api/lists/:id/cards, /api/cards/:id, etc.
app.use('/api/workspaces', kaaryaWorkspacesRouter)
app.use('/api',            kaaryaBoardsRouter)
app.use('/api',            kaaryaCardsRouter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler (must be last) ─────────────────────────────────────────────

app.use(errorHandler)

// ─── HTTP + Socket.IO server ─────────────────────────────────────────────────
//
// Authentication uses the same JWT (HS256) that secures the REST API, so the
// token issued at /api/auth/login or /api/auth/google/callback unlocks the
// socket for both Karya (event:* rooms) and Kaarya (board:* rooms) updates.

const server = http.createServer(app)

const io = new SocketServer(server, {
  cors:        { origin: CLIENT_ORIGINS, credentials: true },
  path:        '/socket.io',
  pingTimeout: 30_000,
})
ioRef.io = io
export { io }

io.use((socket, next) => {
  const token = (socket.handshake.auth?.token as string)
              ?? (socket.handshake.headers.authorization?.startsWith('Bearer ')
                    ? socket.handshake.headers.authorization.slice(7)
                    : null)
  if (!token) return next(new Error('No token'))
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthTokenPayload
    ;(socket as Socket & { user?: AuthTokenPayload }).user = payload
    next()
  } catch {
    next(new Error('Invalid token'))
  }
})

io.on('connection', (socket: Socket & { user?: AuthTokenPayload }) => {
  if (socket.user) socket.join(`user:${socket.user.userId}`)

  // Karya — event-detail rooms for live MOM updates
  socket.on('event:join',  (eventId: string) => { if (eventId) socket.join(`event:${eventId}`) })
  socket.on('event:leave', (eventId: string) => { if (eventId) socket.leave(`event:${eventId}`) })

  // Kaarya — board rooms for live card-mutation broadcasts
  socket.on('board:join',  (boardId: string) => { if (boardId) socket.join(`board:${boardId}`) })
  socket.on('board:leave', (boardId: string) => { if (boardId) socket.leave(`board:${boardId}`) })
})

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`HubAPI listening on http://localhost:${PORT}  (socket.io enabled — Karya + Kaarya)`)
  startCalendarSyncCron()
})

export default app
