const crypto = require('crypto')
const { query, withTransaction } = require('../../config/db')
const { parseReadAI, parseFireflies, normalizeItems } = require('../../services/transcriptParserService')
const { syncMOMToTrello } = require('../../services/trelloService')

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveWebhookUser(webhookKey) {
  const { rows } = await query(
    'SELECT user_id, provider, enabled FROM webhook_settings WHERE webhook_key = $1',
    [webhookKey],
  )
  return rows[0] || null
}

/**
 * Match an event by attendee (userId) within ±1 day of startTime with fuzzy title.
 * Postgres `ILIKE` → `LIKE` (SQL Server default collations are case-insensitive).
 * Postgres interval math → DATEADD().
 */
async function matchEvent(userId, title, startTime) {
  const { rows } = await query(
    `SELECT TOP 1 e.id
       FROM events e
       JOIN event_attendees ea ON ea.event_id = e.id
       JOIN users u ON u.id = ea.user_id
      WHERE u.id = $1
        AND CAST(e.start_time AS DATE) BETWEEN CAST(DATEADD(day, -1, $2) AS DATE)
                                           AND CAST(DATEADD(day,  1, $2) AS DATE)
        AND e.title LIKE $3
      ORDER BY ABS(DATEDIFF(second, e.start_time, $2))`,
    [userId, startTime, `%${title.replace(/%/g, '[%]')}%`],
  )
  return rows[0]?.id ?? null
}

/**
 * Upsert a draft MOM session for this event and replace its items.
 * Existing FINAL sessions are preserved and their id is returned unchanged.
 */
async function upsertDraftMOM(eventId, userId, items) {
  return withTransaction(async (tx) => {
    const { rows: sessionRows } = await tx(
      `SELECT TOP 1 id, status
         FROM mom_sessions
        WHERE event_id = $1
        ORDER BY created_at DESC`,
      [eventId],
    )

    let sessionId

    if (sessionRows[0]?.status === 'final') {
      // Already finalised — don't touch it
      return sessionRows[0].id
    }

    if (sessionRows[0]) {
      sessionId = sessionRows[0].id
      await tx('DELETE FROM mom_items WHERE mom_session_id = $1', [sessionId])
      await tx('UPDATE mom_sessions SET updated_at = SYSUTCDATETIME() WHERE id = $1', [sessionId])
    } else {
      const { rows } = await tx(
        `INSERT INTO mom_sessions (event_id, status, created_by)
           OUTPUT INSERTED.id
           VALUES ($1, 'draft', $2)`,
        [eventId, userId],
      )
      sessionId = rows[0].id
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      await tx(
        `INSERT INTO mom_items
           (mom_session_id, serial_number, category, action_item, owner_email, eta, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, i + 1, item.category, item.action_item, item.owner_email, item.eta, item.status],
      )
    }

    return sessionId
  })
}

// ─── POST /api/webhooks/readai/:webhookKey ────────────────────────────────────

async function readaiInbound(req, res) {
  const { webhookKey } = req.params

  const setting = await resolveWebhookUser(webhookKey)
  if (!setting || !setting.enabled) {
    res.status(404).json({ error: 'Webhook key not found or disabled' })
    return
  }

  try {
    const parsed  = parseReadAI(req.body)
    const items   = normalizeItems(parsed.items)

    const eventId = await matchEvent(setting.user_id, parsed.title, parsed.startTime)
    if (!eventId) {
      res.json({ received: true, matched: false })
      return
    }

    const sessionId = await upsertDraftMOM(eventId, setting.user_id, items)

    syncMOMToTrello(sessionId).catch((err) =>
      console.error('[webhook/readai] Trello sync error:', err),
    )

    res.json({ received: true, matched: true, eventId, sessionId, itemCount: items.length })
  } catch (err) {
    console.error('[webhook/readai]', err)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}

// ─── POST /api/webhooks/fireflies/:webhookKey ────────────────────────────────

async function firefliesInbound(req, res) {
  const { webhookKey } = req.params

  const setting = await resolveWebhookUser(webhookKey)
  if (!setting || !setting.enabled) {
    res.status(404).json({ error: 'Webhook key not found or disabled' })
    return
  }

  try {
    const parsed  = parseFireflies(req.body)
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
}

// ─── GET /api/webhooks/settings ──────────────────────────────────────────────

async function getSettings(req, res) {
  const userId = req.user.userId

  const { rows } = await query(
    `SELECT provider, enabled, webhook_key
       FROM webhook_settings
      WHERE user_id = $1
      ORDER BY provider`,
    [userId],
  )

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
}

// ─── PATCH /api/webhooks/settings/:provider ──────────────────────────────────

async function updateSetting(req, res) {
  const userId   = req.user.userId
  const provider = req.params.provider

  if (!['readai', 'fireflies'].includes(provider)) {
    res.status(400).json({ error: 'Unknown provider' })
    return
  }

  const { enabled } = req.body || {}
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: '"enabled" must be a boolean' })
    return
  }

  // Upsert via MERGE. The webhook_key default is set by the table DEFAULT
  // (NEWID()) when inserting — on update we leave it alone.
  const { rows } = await query(
    `MERGE webhook_settings AS tgt
       USING (VALUES ($1, $2, $3)) AS src (user_id, provider, enabled)
       ON tgt.user_id = src.user_id AND tgt.provider = src.provider
       WHEN MATCHED THEN UPDATE SET enabled = src.enabled, updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (user_id, provider, enabled)
         VALUES (src.user_id, src.provider, src.enabled)
       OUTPUT INSERTED.provider, INSERTED.enabled, INSERTED.webhook_key;`,
    [userId, provider, enabled],
  )

  res.json({
    provider:   rows[0].provider,
    enabled:    rows[0].enabled,
    webhookKey: rows[0].webhook_key,
  })
}

// ─── POST /api/webhooks/settings/:provider/regenerate ────────────────────────

async function regenerateKey(req, res) {
  const userId   = req.user.userId
  const provider = req.params.provider

  if (!['readai', 'fireflies'].includes(provider)) {
    res.status(400).json({ error: 'Unknown provider' })
    return
  }

  const newKey = crypto.randomUUID()

  const { rows } = await query(
    `MERGE webhook_settings AS tgt
       USING (VALUES ($1, $2, $3)) AS src (user_id, provider, webhook_key)
       ON tgt.user_id = src.user_id AND tgt.provider = src.provider
       WHEN MATCHED THEN UPDATE SET webhook_key = src.webhook_key, updated_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (user_id, provider, enabled, webhook_key)
         VALUES (src.user_id, src.provider, 0, src.webhook_key)
       OUTPUT INSERTED.webhook_key;`,
    [userId, provider, newKey],
  )

  res.json({ webhookKey: rows[0].webhook_key })
}

module.exports = {
  readaiInbound,
  firefliesInbound,
  getSettings,
  updateSetting,
  regenerateKey,
}
