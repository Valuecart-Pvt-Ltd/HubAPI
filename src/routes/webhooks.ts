import { Router, Request, Response }         from 'express'
import { execSP, query, withTransaction, sql } from '../db'
import { requireAuth, AuthRequest }           from '../middleware/auth'
import { captureRawBody, webhookSignatureMiddleware } from '../middleware/webhookAuth'
import { parseReadAI, parseFireflies, normalizeItems } from '../services/transcriptParserService'
import type { ReadAIWebhookPayload, FirefliesWebhookPayload } from '../types/webhooks'

export const webhookRouter = Router()

// ─── Trello compatibility shim ────────────────────────────────────────────────
// Trello has been removed from this project. The webhook handlers used to
// fire-and-forget syncMOMToTrello; replace each call with a no-op log.

function trelloRemoved(op: string): void {
  console.log(`[trello-removed] ${op} — this op is now handled by Kaarya integration in Phase 3`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up the user who owns this webhook_key.
 * Returns the user row or null.
 */
async function resolveWebhookUser(webhookKey: string) {
  const rows = await execSP<{ id: string; user_id: string; provider: string; enabled: boolean; webhook_key: string; user_email: string }>(
    'usp_GetWebhookByKey',
    { WebhookKey: { type: sql.UniqueIdentifier, value: webhookKey } },
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
  // Search events within ±1 day of the meeting start time and fuzzy-match title.
  // Postgres ILIKE → LOWER(...) LIKE LOWER(...) for T-SQL.
  const rows = await query<{ id: string }>(
    `SELECT TOP 1 e.id
       FROM events e
       JOIN event_attendees ea ON ea.event_id = e.id
       JOIN users u ON u.id = ea.user_id
      WHERE u.id = @userId
        AND CAST(e.start_time AS DATE) BETWEEN DATEADD(DAY, -1, CAST(@startTime AS DATETIME2))
                                           AND DATEADD(DAY,  1, CAST(@startTime AS DATETIME2))
        AND LOWER(e.title) LIKE LOWER(@titleLike)
      ORDER BY ABS(DATEDIFF(SECOND, e.start_time, CAST(@startTime AS DATETIME2)))`,
    {
      userId:    { type: sql.UniqueIdentifier, value: userId },
      startTime: { type: sql.NVarChar(50),     value: startTime },
      titleLike: { type: sql.NVarChar(500),    value: `%${title.replace(/%/g, '\\%')}%` },
    },
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
  return withTransaction(async (tx) => {
    const r = new sql.Request(tx)

    // Look up the latest session for this event
    r.input('eventId', sql.UniqueIdentifier, eventId)
    const existingResult = await r.query<{ id: string; status: string }>(
      `SELECT TOP 1 id, status FROM mom_sessions WHERE event_id = @eventId ORDER BY created_at DESC`,
    )
    const existing = existingResult.recordset

    if (existing[0]?.status === 'final') {
      // Already finalised — do not overwrite; just return existing ID
      return existing[0].id
    }

    let sessionId: string
    if (existing[0]) {
      sessionId = existing[0].id
      const r2 = new sql.Request(tx)
      r2.input('sessionId', sql.UniqueIdentifier, sessionId)
      await r2.query(`DELETE FROM mom_items WHERE mom_session_id = @sessionId`)

      const r3 = new sql.Request(tx)
      r3.input('sessionId', sql.UniqueIdentifier, sessionId)
      await r3.query(`UPDATE mom_sessions SET updated_at = SYSUTCDATETIME() WHERE id = @sessionId`)
    } else {
      sessionId = await (async () => {
        const r4 = new sql.Request(tx)
        r4.input('eventId', sql.UniqueIdentifier, eventId)
        r4.input('userId',  sql.UniqueIdentifier, userId)
        const inserted = await r4.query<{ id: string }>(
          `INSERT INTO mom_sessions (id, event_id, status, created_by)
           OUTPUT inserted.id
           VALUES (NEWID(), @eventId, 'draft', @userId)`,
        )
        return inserted.recordset[0].id
      })()
    }

    // Insert items
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const r5 = new sql.Request(tx)
      r5.input('sessionId',    sql.UniqueIdentifier, sessionId)
      r5.input('serial',       sql.Int,               i + 1)
      r5.input('category',     sql.NVarChar(255),    item.category)
      r5.input('actionItem',   sql.NVarChar(sql.MAX), item.action_item)
      r5.input('ownerEmail',   sql.NVarChar(255),    item.owner_email)
      r5.input('eta',          sql.NVarChar(20),     item.eta)
      r5.input('status',       sql.NVarChar(20),     item.status)
      await r5.query(
        `INSERT INTO mom_items
           (id, mom_session_id, serial_number, category, action_item, owner_email, eta, status)
         VALUES (NEWID(), @sessionId, @serial, @category, @actionItem, @ownerEmail,
                 CASE WHEN @eta IS NULL OR @eta = '' THEN NULL ELSE CAST(@eta AS DATE) END,
                 @status)`,
      )
    }

    return sessionId
  })
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

      // Trello sync removed — log no-op
      trelloRemoved('syncMOMToTrello (readai webhook)')

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

      // Trello sync removed — log no-op
      trelloRemoved('syncMOMToTrello (fireflies webhook)')

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

  const rows = await execSP<{
    id:          string
    user_id:     string
    provider:    string
    enabled:     boolean
    webhook_key: string
    created_at:  Date
    updated_at:  Date
  }>(
    'usp_GetWebhookSettings',
    { UserId: { type: sql.UniqueIdentifier, value: userId } },
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

    const rows = await execSP<{ provider: string; enabled: boolean; webhook_key: string }>(
      'usp_UpsertWebhookSetting',
      {
        UserId:   { type: sql.UniqueIdentifier, value: userId },
        Provider: { type: sql.NVarChar(50),      value: provider },
        Enabled:  { type: sql.Bit,                value: enabled },
      },
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

    // Inline T-SQL — no SP exists for "rotate webhook key". Insert if missing,
    // otherwise rotate the key and bump updated_at.
    const rows = await query<{ webhook_key: string }>(
      `MERGE webhook_settings AS target
       USING (SELECT @userId AS user_id, @provider AS provider) AS src
         ON target.user_id = src.user_id AND target.provider = src.provider
       WHEN MATCHED THEN
         UPDATE SET webhook_key = NEWID(), updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (id, user_id, provider, enabled, webhook_key)
         VALUES (NEWID(), @userId, @provider, 0, NEWID())
       OUTPUT inserted.webhook_key;`,
      {
        userId:   { type: sql.UniqueIdentifier, value: userId },
        provider: { type: sql.NVarChar(50),      value: provider },
      },
    )

    res.json({ webhookKey: rows[0].webhook_key })
  },
)
