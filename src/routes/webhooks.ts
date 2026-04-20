import { Router, Request, Response }         from 'express'
import { pool }                               from '../db'
import { requireAuth, AuthRequest }           from '../middleware/auth'
import { captureRawBody, webhookSignatureMiddleware } from '../middleware/webhookAuth'
import { parseReadAI, parseFireflies, normalizeItems } from '../services/transcriptParserService'
import { syncMOMToTrello }                    from '../services/trelloService'
import type { ReadAIWebhookPayload, FirefliesWebhookPayload } from '../types/webhooks'

export const webhookRouter = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up the user who owns this webhook_key.
 * Returns the user row or null.
 */
async function resolveWebhookUser(webhookKey: string) {
  const { rows } = await pool.query<{ user_id: string; provider: string; enabled: boolean }>(
    `SELECT user_id, provider, enabled FROM webhook_settings WHERE webhook_key = $1`,
    [webhookKey],
  )
  return rows[0] ?? null
}

/**
 * Find an event for this user whose date matches the meeting start time
 * and whose title is similar.
 * Returns the event_id or null.
 */
async function matchEvent(
  userId: string,
  title:  string,
  startTime: string,
): Promise<string | null> {
  // Search events within ±1 day of the meeting start time and fuzzy-match title
  const { rows } = await pool.query<{ id: string }>(
    `SELECT e.id
       FROM events e
       JOIN event_attendees ea ON ea.event_id = e.id
       JOIN users u ON u.id = ea.user_id
      WHERE u.id = $1
        AND e.start_time::date BETWEEN ($2::timestamptz - INTERVAL '1 day')::date
                                   AND ($2::timestamptz + INTERVAL '1 day')::date
        AND e.title ILIKE $3
      ORDER BY ABS(EXTRACT(EPOCH FROM (e.start_time - $2::timestamptz)))
      LIMIT 1`,
    [userId, startTime, `%${title.replace(/%/g, '\\%')}%`],
  )
  return rows[0]?.id ?? null
}

/**
 * Create (or replace) a draft MOM session for the given event, then return
 * the new session ID.
 */
async function upsertDraftMOM(
  eventId: string,
  userId:  string,
  items:   ReturnType<typeof normalizeItems>,
): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Upsert mom_sessions — keep existing final sessions untouched
    const { rows: sessionRows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM mom_sessions WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [eventId],
    )

    let sessionId: string

    if (sessionRows[0]?.status === 'final') {
      // Already finalised — do not overwrite; just return existing ID
      await client.query('ROLLBACK')
      return sessionRows[0].id
    }

    if (sessionRows[0]) {
      sessionId = sessionRows[0].id
      // Delete existing draft items to replace them
      await client.query(`DELETE FROM mom_items WHERE mom_session_id = $1`, [sessionId])
      await client.query(
        `UPDATE mom_sessions SET updated_at = NOW() WHERE id = $1`,
        [sessionId],
      )
    } else {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO mom_sessions (event_id, status, created_by)
              VALUES ($1, 'draft', $2) RETURNING id`,
        [eventId, userId],
      )
      sessionId = rows[0].id
    }

    // Insert items
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      await client.query(
        `INSERT INTO mom_items
           (mom_session_id, serial_number, category, action_item, owner_email, eta, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          i + 1,
          item.category,
          item.action_item,
          item.owner_email,
          item.eta,
          item.status,
        ],
      )
    }

    await client.query('COMMIT')
    return sessionId
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ─── POST /api/webhooks/readai/:webhookKey ────────────────────────────────────

webhookRouter.post(
  '/readai/:webhookKey',
  captureRawBody,
  webhookSignatureMiddleware('READAI_WEBHOOK_SECRET', 'x-readai-signature'),
  async (req: Request, res: Response) => {
    const { webhookKey } = req.params

    const setting = await resolveWebhookUser(webhookKey)
    if (!setting || !setting.enabled) {
      res.status(404).json({ error: 'Webhook key not found or disabled' })
      return
    }

    try {
      const payload = req.body as ReadAIWebhookPayload
      const parsed  = parseReadAI(payload)
      const items   = normalizeItems(parsed.items)

      const eventId = await matchEvent(setting.user_id, parsed.title, parsed.startTime)
      if (!eventId) {
        // No matching event — acknowledge but do nothing
        res.json({ received: true, matched: false })
        return
      }

      const sessionId = await upsertDraftMOM(eventId, setting.user_id, items)

      // Fire-and-forget Trello sync
      syncMOMToTrello(sessionId).catch((err) =>
        console.error('[webhook/readai] Trello sync error:', err),
      )

      res.json({ received: true, matched: true, eventId, sessionId, itemCount: items.length })
    } catch (err) {
      console.error('[webhook/readai]', err)
      res.status(500).json({ error: 'Webhook processing failed' })
    }
  },
)

// ─── POST /api/webhooks/fireflies/:webhookKey ────────────────────────────────

webhookRouter.post(
  '/fireflies/:webhookKey',
  captureRawBody,
  webhookSignatureMiddleware('FIREFLIES_WEBHOOK_SECRET', 'x-hub-signature-256'),
  async (req: Request, res: Response) => {
    const { webhookKey } = req.params

    const setting = await resolveWebhookUser(webhookKey)
    if (!setting || !setting.enabled) {
      res.status(404).json({ error: 'Webhook key not found or disabled' })
      return
    }

    try {
      const payload = req.body as FirefliesWebhookPayload
      const parsed  = parseFireflies(payload)
      const items   = normalizeItems(parsed.items)

      const eventId = await matchEvent(setting.user_id, parsed.title, parsed.startTime)
      if (!eventId) {
        res.json({ received: true, matched: false })
        return
      }

      const sessionId = await upsertDraftMOM(eventId, setting.user_id, items)

      syncMOMToTrello(sessionId).catch((err) =>
        console.error('[webhook/fireflies] Trello sync error:', err),
      )

      res.json({ received: true, matched: true, eventId, sessionId, itemCount: items.length })
    } catch (err) {
      console.error('[webhook/fireflies]', err)
      res.status(500).json({ error: 'Webhook processing failed' })
    }
  },
)

// ─── GET /api/webhooks/settings ──────────────────────────────────────────────

webhookRouter.get('/settings', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId

  const { rows } = await pool.query<{
    provider: string; enabled: boolean; webhook_key: string
  }>(
    `SELECT provider, enabled, webhook_key
       FROM webhook_settings
      WHERE user_id = $1
      ORDER BY provider`,
    [userId],
  )

  // Return settings for all known providers, inserting defaults for any missing
  const providers = ['readai', 'fireflies']
  const result = providers.map((provider) => {
    const existing = rows.find((r) => r.provider === provider)
    return {
      provider,
      enabled:    existing?.enabled     ?? false,
      webhookKey: existing?.webhook_key ?? null,
    }
  })

  res.json(result)
})

// ─── PATCH /api/webhooks/settings/:provider ──────────────────────────────────

webhookRouter.patch(
  '/settings/:provider',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const userId   = req.user!.userId
    const provider = req.params.provider

    if (!['readai', 'fireflies'].includes(provider)) {
      res.status(400).json({ error: 'Unknown provider' })
      return
    }

    const { enabled } = req.body as { enabled: boolean }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: '"enabled" must be a boolean' })
      return
    }

    const { rows } = await pool.query<{ provider: string; enabled: boolean; webhook_key: string }>(
      `INSERT INTO webhook_settings (user_id, provider, enabled)
            VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING provider, enabled, webhook_key`,
      [userId, provider, enabled],
    )

    res.json({
      provider:   rows[0].provider,
      enabled:    rows[0].enabled,
      webhookKey: rows[0].webhook_key,
    })
  },
)

// ─── POST /api/webhooks/settings/:provider/regenerate ────────────────────────
// Rotate the webhook key (invalidates the old URL)

webhookRouter.post(
  '/settings/:provider/regenerate',
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    const userId   = req.user!.userId
    const provider = req.params.provider

    if (!['readai', 'fireflies'].includes(provider)) {
      res.status(400).json({ error: 'Unknown provider' })
      return
    }

    const { rows } = await pool.query<{ webhook_key: string }>(
      `INSERT INTO webhook_settings (user_id, provider, enabled)
            VALUES ($1, $2, false)
       ON CONFLICT (user_id, provider) DO UPDATE
         SET webhook_key = gen_random_uuid(), updated_at = NOW()
       RETURNING webhook_key`,
      [userId, provider],
    )

    res.json({ webhookKey: rows[0].webhook_key })
  },
)
