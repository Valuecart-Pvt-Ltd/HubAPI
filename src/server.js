require('dotenv').config()

const express  = require('express')
const cors     = require('cors')

// Passport config must load before any route that uses it
require('./config/passport')
require('./config/passportMicrosoft')
const passport = require('passport')

const authRoutes     = require('./modules/auth/auth.routes')
const productsRoutes = require('./modules/products/products.routes')
const cartRoutes     = require('./modules/cart/cart.routes')
const ordersRoutes   = require('./modules/orders/orders.routes')
const eventsRoutes   = require('./modules/events/events.routes')
const momRoutes      = require('./modules/mom/mom.routes')
const trelloRoutes   = require('./modules/trello/trello.routes')
const webhooksRoutes = require('./modules/webhooks/webhooks.routes')

const errorHandler             = require('./middleware/errorHandler')
const { startCalendarSyncCron } = require('./services/calendarService')

const app  = express()
const PORT = process.env.PORT || 4000

// ─── Global middleware ────────────────────────────────────────────────────────

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }))
app.use(express.json({ limit: '2mb' }))
app.use(passport.initialize())

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth',     authRoutes)
app.use('/api/products', productsRoutes)
app.use('/api/cart',     cartRoutes)
app.use('/api/orders',   ordersRoutes)
app.use('/api/events',   eventsRoutes)
app.use('/api/mom',      momRoutes)
app.use('/api/trello',   trelloRoutes)
app.use('/api/webhooks', webhooksRoutes)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler (must be last) ─────────────────────────────────────────────

app.use(errorHandler)

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
  try {
    startCalendarSyncCron()
  } catch (err) {
    console.warn('[server] calendar sync cron failed to start:', err.message)
  }
})

module.exports = app
