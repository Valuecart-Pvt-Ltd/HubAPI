import { Router } from 'express'
import { query, withTransaction } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { syncMOMToTrello, updateCardStatus, updateCardName, archiveCard } from '../services/trelloService'
import { sendMomFinalizedEmail } from '../services/emailService'

export const momRouter = Router()
momRouter.use(requireAuth)

// ─── Shared types ─────────────────────────────────────────────────────────────

interface MomItemRow {
  id:              string
  serial_number:   number
  category:        string
  action_item:     string
  owner_email:     string | null
  eta:             Date   | null
  status:          'pending' | 'in-progress' | 'completed'
  trello_card_id:  string | null
  trello_board_id: string | null
}

interface RawItemInput {
  category:      string
  actionItem:    string
  ownerEmail:    string | null
  eta:           string | null
  status:        'pending' | 'in-progress' | 'completed'
  trelloBoardId: string | null
}

function formatItem(r: MomItemRow) {
  return {
    id:             r.id,
    serialNumber:   r.serial_number,
    category:       r.category,
    actionItem:     r.action_item,
    ownerEmail:     r.owner_email,
    eta:            r.eta ? new Date(r.eta).toISOString().split('T')[0] : null,
    status:         r.status,
    trelloCardId:   r.trello_card_id,
    trelloBoardId:  r.trello_board_id,
  }
}

// ─── Activity log helper ──────────────────────────────────────────────────────

async function logActivity(
  sessionId:  string,
  actorEmail: string,
  eventType:  'mom_created' | 'mom_finalized' | 'status_changed' | 'trello_synced' | 'item_edited' | 'item_deleted',
  details?:   Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO mom_activity_log (session_id, actor_email, event_type, details)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, actorEmail, eventType, details ? JSON.stringify(details) : null],
  ).catch((err) => {
    // Activity logging is non-fatal — never break a request for it
    console.error('[mom] logActivity error:', err)
  })
}

// ─── Helper: verify the requesting user can access this event ─────────────────

interface AccessInfo {
  isOrganizer: boolean
  eventExists: boolean
}

async function checkEventAccess(
  eventId:   string,
  userEmail: string,
): Promise<AccessInfo | null> {
  const { rows } = await query<{
    organizer_email:  string
    is_attendee:      boolean
  }>(
    `SELECT e.organizer_email,
       EXISTS(
         SELECT 1 FROM event_attendees ea
         WHERE ea.event_id = e.id AND ea.email = $2
       ) AS is_attendee
     FROM events e
     WHERE e.id = $1`,
    [eventId, userEmail],
  )

  if (!rows[0]) return null

  const isOrganizer = rows[0].organizer_email === userEmail
  const isAttendee  = rows[0].is_attendee

  if (!isOrganizer && !isAttendee) return null

  return { isOrganizer, eventExists: true }
}

// ─── Route order: /search, /item/:itemId, /, /:eventId/activity, /:eventId ────

// ─── GET /api/mom/search?q=keyword ───────────────────────────────────────────

momRouter.get('/search', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const raw       = (req.query.q ?? '') as string
    const q         = raw.trim()

    if (!q) {
      res.status(400).json({
        success: false,
        error:   'Query parameter "q" is required',
        code:    'missing_query',
        statusCode: 400,
      })
      return
    }

    const { rows } = await query<
      MomItemRow & {
        mom_session_id: string
        session_status: 'draft' | 'final'
        event_id:       string
        event_title:    string
        event_start:    Date
      }
    >(
      `SELECT
         mi.id, mi.serial_number, mi.category, mi.action_item,
         mi.owner_email, mi.eta, mi.status, mi.trello_card_id,
         ms.id            AS mom_session_id,
         ms.status        AS session_status,
         e.id             AS event_id,
         e.title          AS event_title,
         e.start_time     AS event_start
       FROM mom_items mi
       JOIN mom_sessions ms ON ms.id = mi.mom_session_id
       JOIN events e        ON e.id  = ms.event_id
       WHERE
         (
           e.organizer_email = $1
           OR EXISTS (
             SELECT 1 FROM event_attendees ea
             WHERE ea.event_id = e.id AND ea.email = $1
           )
         )
         AND (
           mi.action_item ILIKE $2
           OR mi.category  ILIKE $2
         )
       ORDER BY e.start_time DESC, mi.serial_number ASC
       LIMIT 100`,
      [userEmail, `%${q}%`],
    )

    const data = rows.map((r) => ({
      ...formatItem(r),
      momSessionId:  r.mom_session_id,
      sessionStatus: r.session_status,
      eventId:       r.event_id,
      eventTitle:    r.event_title,
      eventStart:    r.event_start,
    }))

    res.json({ success: true, data })
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/mom/item/:itemId ──────────────────────────────────────────────
//
// Accepts any combination of: status, category, actionItem, ownerEmail, eta.
// Syncs to Trello when status or actionItem changes on a linked card.

momRouter.patch('/item/:itemId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail  = req.user!.email
    const { itemId } = req.params
    const {
      status,
      category,
      actionItem,
      ownerEmail,
      eta,
    } = req.body as {
      status?:     'pending' | 'in-progress' | 'completed'
      category?:   string
      actionItem?: string
      ownerEmail?: string | null
      eta?:        string | null
    }

    const validStatuses = ['pending', 'in-progress', 'completed']
    if (status !== undefined && !validStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        error:   `status must be one of: ${validStatuses.join(', ')}`,
        code:    'invalid_status',
        statusCode: 400,
      })
      return
    }

    if (
      status     === undefined &&
      category   === undefined &&
      actionItem === undefined &&
      ownerEmail === undefined &&
      eta        === undefined
    ) {
      res.status(400).json({
        success: false,
        error:   'At least one field must be provided',
        code:    'no_fields',
        statusCode: 400,
      })
      return
    }

    // Fetch item + access check
    const { rows: itemRows } = await query<
      MomItemRow & {
        event_id:        string
        mom_session_id:  string
        organizer_email: string
        is_attendee:     boolean
      }
    >(
      `SELECT
         mi.id, mi.serial_number, mi.category, mi.action_item,
         mi.owner_email, mi.eta, mi.status, mi.trello_card_id, mi.trello_board_id,
         ms.id            AS mom_session_id,
         e.id             AS event_id,
         e.organizer_email,
         EXISTS (
           SELECT 1 FROM event_attendees ea
           WHERE ea.event_id = e.id AND ea.email = $2
         ) AS is_attendee
       FROM mom_items mi
       JOIN mom_sessions ms ON ms.id = mi.mom_session_id
       JOIN events e        ON e.id  = ms.event_id
       WHERE mi.id = $1`,
      [itemId, userEmail],
    )

    if (!itemRows[0]) {
      res.status(404).json({
        success: false,
        error:   'MOM item not found',
        code:    'item_not_found',
        statusCode: 404,
      })
      return
    }

    const item     = itemRows[0]
    const isMember = item.organizer_email === userEmail || item.is_attendee

    if (!isMember) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    // Build dynamic SET clause — $1 is reserved for itemId in WHERE
    const setClauses: string[] = ['updated_at = NOW()']
    const params: unknown[]    = [itemId]
    let   paramIdx             = 2

    if (status !== undefined) {
      setClauses.push(`status = $${paramIdx++}`)
      params.push(status)
    }
    if (category !== undefined) {
      setClauses.push(`category = $${paramIdx++}`)
      params.push(category)
    }
    if (actionItem !== undefined) {
      setClauses.push(`action_item = $${paramIdx++}`)
      params.push(actionItem.trim())
    }
    if (ownerEmail !== undefined) {
      setClauses.push(`owner_email = $${paramIdx++}`)
      params.push(ownerEmail || null)
    }
    if (eta !== undefined) {
      setClauses.push(`eta = $${paramIdx++}`)
      params.push(eta || null)
    }

    const { rows: updated } = await query<MomItemRow>(
      `UPDATE mom_items SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    )

    const oldStatus     = item.status
    const oldActionItem = item.action_item

    // ── Non-fatal Trello syncs ────────────────────────────────────────────────
    if (item.trello_card_id) {
      // Status changed → move card to Done list + add comment
      if (status !== undefined && status !== oldStatus) {
        updateCardStatus(item.trello_card_id, status).catch((err) => {
          console.warn('[trello] updateCardStatus failed (non-fatal):', err)
        })
      }
      // Action item text changed → rename the Trello card
      if (actionItem !== undefined && actionItem.trim() !== oldActionItem) {
        updateCardName(item.trello_card_id, actionItem.trim()).catch((err) => {
          console.warn('[trello] updateCardName failed (non-fatal):', err)
        })
      }
    }

    // ── Activity logging ──────────────────────────────────────────────────────
    const changedFields: string[] = []
    if (status !== undefined && status !== oldStatus) changedFields.push('status')
    if (category   !== undefined) changedFields.push('category')
    if (actionItem !== undefined) changedFields.push('actionItem')
    if (ownerEmail !== undefined) changedFields.push('ownerEmail')
    if (eta        !== undefined) changedFields.push('eta')

    if (changedFields.length > 0) {
      const isStatusOnlyChange = changedFields.length === 1 && changedFields[0] === 'status'
      logActivity(
        item.mom_session_id,
        userEmail,
        isStatusOnlyChange ? 'status_changed' : 'item_edited',
        {
          itemId,
          changedFields,
          ...(status !== undefined && status !== oldStatus
            ? { oldStatus, newStatus: status }
            : {}),
        },
      )
    }

    res.json({ success: true, data: formatItem(updated[0]) })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/mom/item/:itemId ─────────────────────────────────────────────
//
// Removes a MOM item. Archives the linked Trello card (non-fatal).
// Re-sequences serial numbers on the remaining items.

momRouter.delete('/item/:itemId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail  = req.user!.email
    const { itemId } = req.params

    // Fetch item + access check
    const { rows: itemRows } = await query<
      MomItemRow & {
        event_id:        string
        mom_session_id:  string
        organizer_email: string
        is_attendee:     boolean
      }
    >(
      `SELECT
         mi.id, mi.serial_number, mi.category, mi.action_item,
         mi.owner_email, mi.eta, mi.status, mi.trello_card_id, mi.trello_board_id,
         ms.id            AS mom_session_id,
         e.id             AS event_id,
         e.organizer_email,
         EXISTS (
           SELECT 1 FROM event_attendees ea
           WHERE ea.event_id = e.id AND ea.email = $2
         ) AS is_attendee
       FROM mom_items mi
       JOIN mom_sessions ms ON ms.id = mi.mom_session_id
       JOIN events e        ON e.id  = ms.event_id
       WHERE mi.id = $1`,
      [itemId, userEmail],
    )

    if (!itemRows[0]) {
      res.status(404).json({
        success: false,
        error:   'MOM item not found',
        code:    'item_not_found',
        statusCode: 404,
      })
      return
    }

    const item     = itemRows[0]
    const isMember = item.organizer_email === userEmail || item.is_attendee

    if (!isMember) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    // Delete the item (cascades to mom_item_comments via FK)
    await query(`DELETE FROM mom_items WHERE id = $1`, [itemId])

    // Re-sequence remaining items in the same session
    await query(
      `UPDATE mom_items
       SET serial_number = sub.new_serial
       FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY serial_number ASC) AS new_serial
         FROM mom_items
         WHERE mom_session_id = $1
       ) sub
       WHERE mom_items.id = sub.id`,
      [item.mom_session_id],
    )

    // Non-fatal: archive the Trello card
    if (item.trello_card_id) {
      archiveCard(item.trello_card_id).catch((err) => {
        console.warn('[trello] archiveCard failed (non-fatal):', err)
      })
    }

    // Activity log (non-fatal)
    logActivity(item.mom_session_id, userEmail, 'item_deleted', {
      itemId,
      actionItem: item.action_item,
    })

    res.json({ success: true, data: { id: itemId } })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/mom ────────────────────────────────────────────────────────────

momRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const {
      eventId,
      status,
      items: rawItems,
    } = req.body as {
      eventId: string
      status:  'draft' | 'final'
      items:   RawItemInput[]
    }

    if (!eventId || !['draft', 'final'].includes(status) || !Array.isArray(rawItems)) {
      res.status(400).json({
        success: false,
        error:   'Body must include event_id (string), status ("draft"|"final"), and items (array)',
        code:    'invalid_body',
        statusCode: 400,
      })
      return
    }

    const access = await checkEventAccess(eventId, userEmail)
    if (!access) {
      const { rows: ev } = await query('SELECT id FROM events WHERE id = $1', [eventId])
      const code = ev[0] ? 403 : 404
      res.status(code).json({
        success: false,
        error:   code === 404 ? 'Event not found' : 'Forbidden',
        code:    code === 404 ? 'event_not_found' : 'forbidden',
        statusCode: code,
      })
      return
    }
    const userId = req.user!.userId

    // ── Upsert session + replace all items in a single transaction ────────────
    const { sessionId, isNew, wasAlreadyFinal } = await withTransaction(async (client) => {
      const { rows: existing } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM mom_sessions WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [eventId],
      )

      let sid: string
      let created     = false
      let prevStatus  = 'draft'
      if (existing[0]) {
        sid        = existing[0].id
        prevStatus = existing[0].status
        await client.query(
          `UPDATE mom_sessions SET status = $1, updated_at = NOW() WHERE id = $2`,
          [status, sid],
        )
      } else {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO mom_sessions (event_id, status, created_by) VALUES ($1, $2, $3) RETURNING id`,
          [eventId, status, userId],
        )
        sid     = rows[0].id
        created = true
      }

      await client.query(`DELETE FROM mom_items WHERE mom_session_id = $1`, [sid])

      for (let i = 0; i < rawItems.length; i++) {
        const item   = rawItems[i]
        const serial = i + 1
        await client.query(
          `INSERT INTO mom_items
             (mom_session_id, serial_number, category, action_item, owner_email, eta, status, trello_board_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            sid,
            serial,
            item.category      ?? '',
            item.actionItem    ?? '',
            item.ownerEmail    ?? null,
            item.eta           ?? null,
            item.status        ?? 'pending',
            item.trelloBoardId ?? null,
          ],
        )
      }

      return { sessionId: sid, isNew: created, wasAlreadyFinal: prevStatus === 'final' }
    })

    // ── Trello sync — only on the draft→final transition, not re-saves ──────
    if (status === 'final' && !wasAlreadyFinal) {
      syncMOMToTrello(sessionId).catch((err) => {
        console.error('[trello] syncMOMToTrello top-level error:', err)
      })

      // ── Email all attendees ─────────────────────────────────────────────────
      ;(async () => {
        try {
          const { rows: evRows } = await query<{
            title:           string
            start_time:      Date
            end_time:        Date
            organizer_email: string
          }>(
            `SELECT title, start_time, end_time, organizer_email FROM events WHERE id = $1`,
            [eventId],
          )

          const { rows: attendeeRows } = await query<{ email: string }>(
            `SELECT email FROM event_attendees WHERE event_id = $1`,
            [eventId],
          )

          if (evRows[0]) {
            await sendMomFinalizedEmail({
              eventTitle:     evRows[0].title,
              eventStart:     evRows[0].start_time,
              eventEnd:       evRows[0].end_time,
              organizerEmail: evRows[0].organizer_email,
              attendeeEmails: attendeeRows.map((r) => r.email),
              items:          rawItems.map((it, i) => ({
                serialNumber: i + 1,
                category:     it.category     ?? '',
                actionItem:   it.actionItem   ?? '',
                ownerEmail:   it.ownerEmail   ?? null,
                eta:          it.eta          ?? null,
                status:       it.status       ?? 'pending',
              })),
              finalizedBy: userEmail,
            })
          }
        } catch (err) {
          console.error('[email] Failed to send MOM finalized email:', err)
        }
      })()
    }

    // ── Activity logging ──────────────────────────────────────────────────────
    if (isNew) {
      logActivity(sessionId, userEmail, 'mom_created', { itemCount: rawItems.length })
    } else if (status === 'final') {
      logActivity(sessionId, userEmail, 'mom_finalized', { itemCount: rawItems.length })
    }

    // ── Return saved session ──────────────────────────────────────────────────
    const { rows: sessionRows } = await query<{
      id:         string
      event_id:   string
      status:     'draft' | 'final'
      created_at: Date
      updated_at: Date
    }>(
      `SELECT id, event_id, status, created_at, updated_at FROM mom_sessions WHERE id = $1`,
      [sessionId],
    )

    const { rows: itemRows } = await query<MomItemRow>(
      `SELECT id, serial_number, category, action_item, owner_email, eta, status, trello_card_id, trello_board_id
       FROM mom_items WHERE mom_session_id = $1 ORDER BY serial_number ASC`,
      [sessionId],
    )

    const session = sessionRows[0]
    res.json({
      success: true,
      data: {
        id:        session.id,
        eventId:   session.event_id,
        status:    session.status,
        items:     itemRows.map(formatItem),
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/mom/previous/:eventId ──────────────────────────────────────────
//
// Returns the most recently finalized MOM from a DIFFERENT event that shares
// the same title — used to show the "Previous MOM" section.

momRouter.get('/previous/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const { eventId } = req.params

    const access = await checkEventAccess(eventId, userEmail)
    if (!access) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    // Resolve the current event title
    const { rows: evRows } = await query<{ title: string }>(
      `SELECT title FROM events WHERE id = $1`,
      [eventId],
    )
    if (!evRows[0]) {
      res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      return
    }

    // Find the most recent OTHER event with the same title that has a finalized MOM
    const { rows: prevRows } = await query<{
      session_id:  string
      event_id:    string
      start_time:  Date
    }>(
      `SELECT ms.id AS session_id, e.id AS event_id, e.start_time
       FROM mom_sessions ms
       JOIN events e ON e.id = ms.event_id
       WHERE e.title = $1
         AND e.id   != $2
         AND ms.status = 'final'
       ORDER BY e.start_time DESC
       LIMIT 1`,
      [evRows[0].title, eventId],
    )

    if (!prevRows[0]) {
      res.json({ success: true, data: null })
      return
    }

    const { rows: items } = await query<MomItemRow>(
      `SELECT id, serial_number, category, action_item, owner_email, eta, status,
              trello_card_id, trello_board_id
       FROM mom_items
       WHERE mom_session_id = $1
       ORDER BY serial_number ASC`,
      [prevRows[0].session_id],
    )

    res.json({
      success: true,
      data: {
        eventId:    prevRows[0].event_id,
        eventStart: prevRows[0].start_time,
        items:      items.map(formatItem),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/mom/:eventId/activity ──────────────────────────────────────────
//
// Returns the activity timeline for the latest MOM session of the event.
// Scoped to event members only.

momRouter.get('/:eventId/activity', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const { eventId } = req.params

    const access = await checkEventAccess(eventId, userEmail)
    if (!access) {
      const { rows: ev } = await query('SELECT id FROM events WHERE id = $1', [eventId])
      const code = ev[0] ? 403 : 404
      res.status(code).json({
        success: false,
        error:   code === 404 ? 'Event not found' : 'Forbidden',
        code:    code === 404 ? 'event_not_found' : 'forbidden',
        statusCode: code,
      })
      return
    }

    const { rows } = await query<{
      id:          string
      actor_email: string
      event_type:  string
      details:     Record<string, unknown> | null
      created_at:  Date
    }>(
      `SELECT al.id, al.actor_email, al.event_type, al.details, al.created_at
       FROM mom_activity_log al
       JOIN mom_sessions ms ON ms.id = al.session_id
       WHERE ms.event_id = $1
       ORDER BY al.created_at DESC
       LIMIT 50`,
      [eventId],
    )

    res.json({
      success: true,
      data: rows.map((r) => ({
        id:         r.id,
        actorEmail: r.actor_email,
        eventType:  r.event_type,
        details:    r.details,
        createdAt:  r.created_at,
      })),
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/mom/item/:itemId/comments ──────────────────────────────────────

momRouter.get('/item/:itemId/comments', async (req: AuthRequest, res, next) => {
  try {
    const userEmail  = req.user!.email
    const { itemId } = req.params

    // Verify user has access to the event this item belongs to
    const { rows: accessRows } = await query<{
      event_id:        string
      organizer_email: string
      is_attendee:     boolean
    }>(
      `SELECT e.id AS event_id, e.organizer_email,
         EXISTS (
           SELECT 1 FROM event_attendees ea
           WHERE ea.event_id = e.id AND ea.email = $2
         ) AS is_attendee
       FROM mom_items mi
       JOIN mom_sessions ms ON ms.id = mi.mom_session_id
       JOIN events e        ON e.id  = ms.event_id
       WHERE mi.id = $1`,
      [itemId, userEmail],
    )

    if (!accessRows[0]) {
      res.status(404).json({ success: false, error: 'Item not found', code: 'item_not_found', statusCode: 404 })
      return
    }
    const isMember = accessRows[0].organizer_email === userEmail || accessRows[0].is_attendee
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    const { rows } = await query<{
      id:           string
      author_email: string
      author_name:  string
      comment:      string
      created_at:   Date
    }>(
      `SELECT id, author_email, author_name, comment, created_at
       FROM mom_item_comments
       WHERE mom_item_id = $1
       ORDER BY created_at ASC`,
      [itemId],
    )

    res.json({
      success: true,
      data: rows.map((r) => ({
        id:          r.id,
        authorEmail: r.author_email,
        authorName:  r.author_name,
        comment:     r.comment,
        createdAt:   r.created_at,
      })),
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/mom/item/:itemId/comment ──────────────────────────────────────

momRouter.post('/item/:itemId/comment', async (req: AuthRequest, res, next) => {
  try {
    const userEmail  = req.user!.email
    const { itemId } = req.params
    const { comment } = req.body as { comment: string }

    if (!comment || !comment.trim()) {
      res.status(400).json({ success: false, error: 'comment is required', code: 'missing_comment', statusCode: 400 })
      return
    }

    // Verify access
    const { rows: accessRows } = await query<{
      organizer_email: string
      is_attendee:     boolean
      author_name:     string
    }>(
      `SELECT e.organizer_email,
         EXISTS (
           SELECT 1 FROM event_attendees ea
           WHERE ea.event_id = e.id AND ea.email = $2
         ) AS is_attendee,
         COALESCE(u.name, $2) AS author_name
       FROM mom_items mi
       JOIN mom_sessions ms ON ms.id = mi.mom_session_id
       JOIN events e        ON e.id  = ms.event_id
       LEFT JOIN users u    ON u.email = $2
       WHERE mi.id = $1`,
      [itemId, userEmail],
    )

    if (!accessRows[0]) {
      res.status(404).json({ success: false, error: 'Item not found', code: 'item_not_found', statusCode: 404 })
      return
    }
    const isMember = accessRows[0].organizer_email === userEmail || accessRows[0].is_attendee
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    const { rows } = await query<{
      id:           string
      author_email: string
      author_name:  string
      comment:      string
      created_at:   Date
    }>(
      `INSERT INTO mom_item_comments (mom_item_id, author_email, author_name, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING id, author_email, author_name, comment, created_at`,
      [itemId, userEmail, accessRows[0].author_name, comment.trim()],
    )

    res.status(201).json({
      success: true,
      data: {
        id:          rows[0].id,
        authorEmail: rows[0].author_email,
        authorName:  rows[0].author_name,
        comment:     rows[0].comment,
        createdAt:   rows[0].created_at,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/mom/:eventId ────────────────────────────────────────────────────

momRouter.get('/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const { eventId } = req.params

    const access = await checkEventAccess(eventId, userEmail)
    if (!access) {
      const { rows: ev } = await query('SELECT id FROM events WHERE id = $1', [eventId])
      const code = ev[0] ? 403 : 404
      res.status(code).json({
        success: false,
        error:   code === 404 ? 'Event not found' : 'Forbidden',
        code:    code === 404 ? 'event_not_found' : 'forbidden',
        statusCode: code,
      })
      return
    }

    const { rows: sessions } = await query<{
      id:         string
      event_id:   string
      status:     'draft' | 'final'
      created_at: Date
      updated_at: Date
    }>(
      `SELECT id, event_id, status, created_at, updated_at
       FROM mom_sessions
       WHERE event_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [eventId],
    )

    if (!sessions[0]) {
      res.json({ success: true, data: null })
      return
    }

    const session = sessions[0]
    const { rows: items } = await query<MomItemRow>(
      `SELECT id, serial_number, category, action_item, owner_email, eta, status, trello_card_id, trello_board_id
       FROM mom_items
       WHERE mom_session_id = $1
       ORDER BY serial_number ASC`,
      [session.id],
    )

    res.json({
      success: true,
      data: {
        id:        session.id,
        eventId:   session.event_id,
        status:    session.status,
        items:     items.map(formatItem),
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
    })
  } catch (err) {
    next(err)
  }
})
