import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'
// Load .env from the repo root regardless of which directory npm run dev is
// invoked from. __dirname here is src/, so one level up = repo root.
loadEnv({ path: resolve(__dirname, '..', '.env') })

import http from 'http'
import express from 'express'
import cors from 'cors'
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
import { errorHandler }   from './middleware/errorHandler'
import { startCalendarSyncCron } from './services/calendarService'
import type { AuthTokenPayload } from './types/shared'

const app  = express()
const PORT = process.env.PORT ?? 4000

// ─── Global middleware ────────────────────────────────────────────────────────

app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(passport.initialize())

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth',     authRouter)
app.use('/api/products', productsRouter)
app.use('/api/cart',     cartRouter)
app.use('/api/orders',   ordersRouter)
app.use('/api/events',   eventsRouter)
app.use('/api/mom',      momRouter)
app.use('/api/webhooks', webhookRouter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler (must be last) ─────────────────────────────────────────────

app.use(errorHandler)

// ─── HTTP + Socket.IO server ─────────────────────────────────────────────────
//
// Phase 0 scaffolding: the server upgrades to socket.io for live updates.
// Authentication uses the same JWT (HS256) that secures the REST API, so the
// token issued at /api/auth/login or /api/auth/google/callback also unlocks
// the socket. Phase 3 will use this to push card / MOM mutations to clients.

const server = http.createServer(app)

export const io = new SocketServer(server, {
  cors:        { origin: CLIENT_ORIGINS, credentials: true },
  path:        '/socket.io',
  pingTimeout: 30_000,
})

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
  // Each authenticated user joins a personal room — useful for direct pushes.
  if (socket.user) socket.join(`user:${socket.user.userId}`)

  // Clients can subscribe/unsubscribe to event-detail rooms for live MOM updates.
  socket.on('event:join',  (eventId: string) => { if (eventId) socket.join(`event:${eventId}`) })
  socket.on('event:leave', (eventId: string) => { if (eventId) socket.leave(`event:${eventId}`) })
})

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`HubAPI listening on http://localhost:${PORT}  (socket.io enabled)`)
  startCalendarSyncCron()
})

export default app
