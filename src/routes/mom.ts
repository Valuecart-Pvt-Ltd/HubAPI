import { Router } from 'express'
import { execSP, execSPMulti, query, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { sendMomFinalizedEmail } from '../services/emailService'
import { ioRef } from '../io'

export const momRouter = Router()
momRouter.use(requireAuth)

// ─── Kaarya sync helpers (Phase 3) ────────────────────────────────────────────
// MOM saves and item edits propagate to Kaarya cards on the event's mapped
// board. All sync calls are best-effort — never block the request on them.

function syncMomToKaarya(eventId: string, actorId: string): void {
  void execSP('usp_KSyncEventMom', {
    EventId: { type: sql.UniqueIdentifier, value: eventId },
    ActorId: { type: sql.UniqueIdentifier, value: actorId },
  })
    .then(rows => {
      // Notify any board-room listeners that cards on those boards changed.
      const io = ioRef.io
      if (!io || rows.length === 0) return
      const boardIds = new Set<string>()
      for (const r of rows) {
        const bid = (r as { board_id?: string }).board_id
        if (bid) boardIds.add(bid)
      }
      for (const bid of boardIds) io.to(`board:${bid}`).emit('card:synced', { eventId })
    })
    .catch(err => {
      // NO_LIST_AVAILABLE / FORBIDDEN here are real warnings; everything else
      // is logged for postmortem but never bubbled.
      console.warn(`[kaarya-sync] event=${eventId} skipped:`, (err as Error).message)
    })
}

function unsyncMomItemFromKaarya(itemId: string, actorId: string): void {
  void execSP('usp_KUnsyncMomItem', {
    MomItemId: { type: sql.UniqueIdentifier, value: itemId },
    ActorId:   { type: sql.UniqueIdentifier, value: actorId },
  }).catch(err => {
    console.warn(`[kaarya-sync] unsync item=${itemId} skipped:`, (err as Error).message)
  })
}

async function syncMomBySessionId(sessionId: string, actorId: string): Promise<void> {
  // usp_UpdateMOMItem returns mom_session_id; resolve event_id, then bulk sync.
  try {
    const rows = await query<{ event_id: string }>(
      'SELECT event_id FROM mom_sessions WHERE id = @id',
      { id: { type: sql.UniqueIdentifier, value: sessionId } },
    )
    if (rows[0]) syncMomToKaarya(rows[0].event_id, actorId)
  } catch (err) {
    console.warn(`[kaarya-sync] resolve session=${sessionId} skipped:`, (err as Error).message)
  }
}

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
  kaarya_card_id:  string | null
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
    kaaryaCardId:   r.kaarya_card_id,
  }
}

// ─── Activity log helper ──────────────────────────────────────────────────────

async function logActivity(
  sessionId:  string,
  actorEmail: string,
  eventType:  'mom_created' | 'mom_finalized' | 'status_changed' | 'trello_synced' | 'item_edited' | 'item_deleted',
  details?:   Record<string, unknown>,
): Promise<void> {
  await execSP('usp_LogMOMActivity', {
    SessionId:  { type: sql.UniqueIdentifier, value: sessionId },
    ActorEmail: { type: sql.NVarChar(255),    value: actorEmail },
    EventType:  { type: sql.NVarChar(50),     value: eventType },
    Details:    { type: sql.NVarChar(sql.MAX), value: details ? JSON.stringify(details) : null },
  }).catch((err) => {
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
  const rows = await execSP<{ is_organizer: number; is_attendee: number }>(
    'usp_CheckEventAccess',
    {
      EventId:   { type: sql.UniqueIdentifier, value: eventId },
      UserEmail: { type: sql.NVarChar(255),    value: userEmail },
    },
  )

  if (!rows[0]) return null

  const isOrganizer = rows[0].is_organizer === 1
  const isAttendee  = rows[0].is_attendee  === 1

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

    const rows = await execSP<
      MomItemRow & {
        mom_session_id: string
        session_status: 'draft' | 'final'
        event_id:       string
        event_title:    string
        event_start:    Date
      }
    >('usp_SearchMOM', {
      UserEmail: { type: sql.NVarChar(255), value: userEmail },
      Query:     { type: sql.NVarChar(255), value: q },
    })

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

    let updated: (MomItemRow & {
      mom_session_id:      string
      old_status:          'pending' | 'in-progress' | 'completed'
      old_action_item:     string
      trello_card_id_hint: string | null
    })[]
    try {
      updated = await execSP<MomItemRow & {
        mom_session_id:      string
        old_status:          'pending' | 'in-progress' | 'completed'
        old_action_item:     string
        trello_card_id_hint: string | null
      }>('usp_UpdateMOMItem', {
        ItemId:       { type: sql.UniqueIdentifier, value: itemId },
        UserEmail:    { type: sql.NVarChar(255),    value: userEmail },
        Status:       { type: sql.NVarChar(20),     value: status     ?? null },
        Category:     { type: sql.NVarChar(255),    value: category   ?? null },
        ActionItem:   { type: sql.NVarChar(sql.MAX), value: actionItem ?? null },
        OwnerEmail:   { type: sql.NVarChar(255),    value: ownerEmail ?? null },
        SetOwnerNull: { type: sql.Bit,               value: ownerEmail === null },
        Eta:          { type: sql.NVarChar(20),     value: eta ?? null },
        SetEtaNull:   { type: sql.Bit,               value: eta === null },
      })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('NOT_FOUND')) {
        res.status(404).json({
          success: false,
          error:   'MOM item not found',
          code:    'item_not_found',
          statusCode: 404,
        })
        return
      }
      if (msg.includes('FORBIDDEN')) {
        res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
        return
      }
      throw err
    }

    if (!updated[0]) {
      res.status(404).json({ success: false, error: 'MOM item not found', code: 'item_not_found', statusCode: 404 })
      return
    }

    const item          = updated[0]
    const oldStatus     = item.old_status
    const oldActionItem = item.old_action_item

    // ── Kaarya sync — push the item-level edit through if event has a board mapped ──
    const statusChanged = status !== undefined && status !== oldStatus
    const titleChanged  = actionItem !== undefined && actionItem.trim() !== oldActionItem
    if (statusChanged || titleChanged) {
      void syncMomBySessionId(item.mom_session_id, req.user!.userId)
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

    res.json({ success: true, data: formatItem(item) })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/mom/item/:itemId ─────────────────────────────────────────────

momRouter.delete('/item/:itemId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail  = req.user!.email
    const { itemId } = req.params

    let resultRows: { id: string; mom_session_id: string; trello_card_id: string | null; action_item: string }[]
    try {
      resultRows = await execSP<{
        id:              string
        mom_session_id:  string
        trello_card_id:  string | null
        action_item:     string
      }>('usp_DeleteMOMItem', {
        ItemId:    { type: sql.UniqueIdentifier, value: itemId },
        UserEmail: { type: sql.NVarChar(255),    value: userEmail },
      })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('NOT_FOUND')) {
        res.status(404).json({
          success: false,
          error:   'MOM item not found',
          code:    'item_not_found',
          statusCode: 404,
        })
        return
      }
      if (msg.includes('FORBIDDEN')) {
        res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
        return
      }
      throw err
    }

    const ctx = resultRows[0]
    if (!ctx) {
      res.status(404).json({ success: false, error: 'MOM item not found', code: 'item_not_found', statusCode: 404 })
      return
    }

    // Kaarya: drop the corresponding card too (no-op if event has no board mapped).
    unsyncMomItemFromKaarya(itemId, req.user!.userId)

    // Activity log (non-fatal)
    logActivity(ctx.mom_session_id, userEmail, 'item_deleted', {
      itemId,
      actionItem: ctx.action_item,
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
      const ev = await query<{ id: string }>(
        'SELECT id FROM events WHERE id = @id',
        { id: { type: sql.UniqueIdentifier, value: eventId } },
      )
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

    // Build items JSON for the SP
    const itemsJson = JSON.stringify(rawItems.map((it) => ({
      category:       it.category      ?? '',
      actionItem:     it.actionItem    ?? '',
      ownerEmail:     it.ownerEmail    ?? '',
      eta:            it.eta           ?? '',
      status:         it.status        ?? 'pending',
      trelloBoardId:  it.trelloBoardId ?? '',
    })))

    // usp_SaveMOMSession returns 3 recordsets:
    //   [0] control flags { session_id, is_new, was_already_final }
    //   [1] session row
    //   [2] saved items
    const result = await execSPMulti('usp_SaveMOMSession', {
      EventId:   { type: sql.UniqueIdentifier, value: eventId },
      Status:    { type: sql.NVarChar(10),     value: status },
      UserId:    { type: sql.UniqueIdentifier, value: userId },
      ItemsJson: { type: sql.NVarChar(sql.MAX), value: itemsJson },
    })

    const flags = (result.recordsets?.[0] ?? []) as {
      session_id:        string
      is_new:            number
      was_already_final: number
    }[]
    const sessionRows = (result.recordsets?.[1] ?? []) as {
      id:         string
      event_id:   string
      status:     'draft' | 'final'
      created_at: Date
      updated_at: Date
    }[]
    const itemRows = (result.recordsets?.[2] ?? []) as MomItemRow[]

    const sessionId       = flags[0].session_id
    const isNew           = flags[0].is_new === 1
    const wasAlreadyFinal = flags[0].was_already_final === 1

    // ── Kaarya sync — push every save through (idempotent: existing cards just refresh) ──
    syncMomToKaarya(eventId, userId)

    // ── Email attendees on draft→final ──────────────────────────────────────
    if (status === 'final' && !wasAlreadyFinal) {

      // ── Email all attendees ─────────────────────────────────────────────────
      ;(async () => {
        try {
          const evRows = await query<{
            title:           string
            start_time:      Date
            end_time:        Date
            organizer_email: string
          }>(
            `SELECT title, start_time, end_time, organizer_email FROM events WHERE id = @id`,
            { id: { type: sql.UniqueIdentifier, value: eventId } },
          )

          const attendeeRows = await query<{ email: string }>(
            `SELECT email FROM event_attendees WHERE event_id = @id`,
            { id: { type: sql.UniqueIdentifier, value: eventId } },
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

momRouter.get('/previous/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const { eventId } = req.params

    const access = await checkEventAccess(eventId, userEmail)
    if (!access) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    let result
    try {
      result = await execSPMulti('usp_GetPreviousMOM', {
        EventId:   { type: sql.UniqueIdentifier, value: eventId },
        UserEmail: { type: sql.NVarChar(255),    value: userEmail },
      })
    } catch (err) {
      if ((err as Error).message?.includes('NOT_FOUND')) {
        res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
        return
      }
      throw err
    }

    // SP returns either:
    //   [0] = [{ session_id: null }]                 (no previous MOM)
    //   [0] = [{ session_id, event_id, event_start }], [1] = items
    const headerRows = (result.recordsets?.[0] ?? []) as {
      session_id:  string | null
      event_id?:   string
      event_start?: Date
    }[]

    if (!headerRows[0] || headerRows[0].session_id === null) {
      res.json({ success: true, data: null })
      return
    }

    const items = (result.recordsets?.[1] ?? []) as MomItemRow[]

    res.json({
      success: true,
      data: {
        eventId:    headerRows[0].event_id,
        eventStart: headerRows[0].event_start,
        items:      items.map(formatItem),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/mom/:eventId/activity ──────────────────────────────────────────

momRouter.get('/:eventId/activity', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const { eventId } = req.params

    const access = await checkEventAccess(eventId, userEmail)
    if (!access) {
      const ev = await query<{ id: string }>(
        'SELECT id FROM events WHERE id = @id',
        { id: { type: sql.UniqueIdentifier, value: eventId } },
      )
      const code = ev[0] ? 403 : 404
      res.status(code).json({
        success: false,
        error:   code === 404 ? 'Event not found' : 'Forbidden',
        code:    code === 404 ? 'event_not_found' : 'forbidden',
        statusCode: code,
      })
      return
    }

    // usp_GetMOMActivity returns: [0] access flags (from usp_CheckEventAccess), [1] activity rows
    const result = await execSPMulti('usp_GetMOMActivity', {
      EventId:   { type: sql.UniqueIdentifier, value: eventId },
      UserEmail: { type: sql.NVarChar(255),    value: userEmail },
    })

    const rows = (result.recordsets?.[1] ?? []) as {
      id:          string
      actor_email: string
      event_type:  string
      details:     string | null
      created_at:  Date
    }[]

    res.json({
      success: true,
      data: rows.map((r) => ({
        id:         r.id,
        actorEmail: r.actor_email,
        eventType:  r.event_type,
        details:    r.details ? safeJsonParse(r.details) : null,
        createdAt:  r.created_at,
      })),
    })
  } catch (err) {
    next(err)
  }
})

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

// ─── GET /api/mom/item/:itemId/comments ──────────────────────────────────────

momRouter.get('/item/:itemId/comments', async (req: AuthRequest, res, next) => {
  try {
    const userEmail  = req.user!.email
    const { itemId } = req.params

    let rows: {
      id:           string
      author_email: string
      author_name:  string
      comment:      string
      created_at:   Date
    }[]
    try {
      rows = await execSP<{
        id:           string
        author_email: string
        author_name:  string
        comment:      string
        created_at:   Date
      }>('usp_GetItemComments', {
        ItemId:    { type: sql.UniqueIdentifier, value: itemId },
        UserEmail: { type: sql.NVarChar(255),    value: userEmail },
      })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('FORBIDDEN')) {
        // The SP doesn't distinguish 404 from 403 — replicate the original
        // semantics by checking whether the item exists.
        const exists = await query<{ id: string }>(
          'SELECT id FROM mom_items WHERE id = @id',
          { id: { type: sql.UniqueIdentifier, value: itemId } },
        )
        if (!exists[0]) {
          res.status(404).json({ success: false, error: 'Item not found', code: 'item_not_found', statusCode: 404 })
        } else {
          res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
        }
        return
      }
      throw err
    }

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

    let rows: {
      id:           string
      author_email: string
      author_name:  string
      comment:      string
      created_at:   Date
    }[]
    try {
      rows = await execSP<{
        id:           string
        author_email: string
        author_name:  string
        comment:      string
        created_at:   Date
      }>('usp_AddItemComment', {
        ItemId:    { type: sql.UniqueIdentifier, value: itemId },
        UserEmail: { type: sql.NVarChar(255),    value: userEmail },
        Comment:   { type: sql.NVarChar(sql.MAX), value: comment },
      })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('NOT_FOUND')) {
        res.status(404).json({ success: false, error: 'Item not found', code: 'item_not_found', statusCode: 404 })
        return
      }
      if (msg.includes('FORBIDDEN')) {
        res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
        return
      }
      throw err
    }

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
      const ev = await query<{ id: string }>(
        'SELECT id FROM events WHERE id = @id',
        { id: { type: sql.UniqueIdentifier, value: eventId } },
      )
      const code = ev[0] ? 403 : 404
      res.status(code).json({
        success: false,
        error:   code === 404 ? 'Event not found' : 'Forbidden',
        code:    code === 404 ? 'event_not_found' : 'forbidden',
        statusCode: code,
      })
      return
    }

    // usp_GetMOMSession returns: [0] access flags, [1] session, [2] items
    const result = await execSPMulti('usp_GetMOMSession', {
      EventId:   { type: sql.UniqueIdentifier, value: eventId },
      UserEmail: { type: sql.NVarChar(255),    value: userEmail },
    })

    const sessions = (result.recordsets?.[1] ?? []) as {
      id:         string
      event_id:   string
      status:     'draft' | 'final'
      created_at: Date
      updated_at: Date
    }[]

    if (!sessions[0]) {
      res.json({ success: true, data: null })
      return
    }

    const session = sessions[0]
    const items   = (result.recordsets?.[2] ?? []) as MomItemRow[]

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
