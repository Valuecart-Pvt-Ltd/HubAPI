import { config as loadEnv } from 'dotenv'
import { resolve }           from 'path'
// Load .env from the monorepo root regardless of which directory npm run dev is
// invoked from.  __dirname here is server/src, so two levels up = repo root.
loadEnv({ path: resolve(__dirname, '..', '..', '.env') })

import express from 'express'
import cors from 'cors'

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
import { trelloRouter }   from './routes/trello'
import { webhookRouter }  from './routes/webhooks'
import { errorHandler }   from './middleware/errorHandler'
import { startCalendarSyncCron } from './services/calendarService'

const app  = express()
const PORT = process.env.PORT ?? 4000

// ─── Global middleware ────────────────────────────────────────────────────────

app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }))
app.use(express.json())
app.use(passport.initialize())

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth',     authRouter)
app.use('/api/products', productsRouter)
app.use('/api/cart',     cartRouter)
app.use('/api/orders',   ordersRouter)
app.use('/api/events',   eventsRouter)
app.use('/api/mom',      momRouter)
app.use('/api/trello',    trelloRouter)
app.use('/api/webhooks', webhookRouter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler (must be last) ─────────────────────────────────────────────

app.use(errorHandler)

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
  startCalendarSyncCron()
})

export default app
