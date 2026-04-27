import { Router } from 'express'
import { execSP, execSPMulti, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { ioRef } from '../io'

export const cardsRouter = Router()

// POST /api/lists/:listId/cards  — create a card in a list
cardsRouter.post('/lists/:listId/cards', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { title, description, priority, dueDate, karyaEventId, karyaMomItemId } = req.body as {
      title?:           string
      description?:     string
      priority?:        string
      dueDate?:         string
      karyaEventId?:    string
      karyaMomItemId?:  string
    }
    if (!title || !title.trim()) {
      res.status(400).json({ success: false, error: 'title is required', code: 'missing_title', statusCode: 400 })
      return
    }

    const rows = await execSP('usp_KCreateCard', {
      ListId:         { type: sql.UniqueIdentifier, value: req.params.listId },
      Title:          { type: sql.NVarChar(500),    value: title.trim() },
      Description:    { type: sql.NVarChar(sql.MAX), value: description ?? null },
      Priority:       { type: sql.NVarChar(20),     value: priority ?? null },
      DueDate:        { type: sql.DateTime2,        value: dueDate ? new Date(dueDate) : null },
      CreatedBy:      { type: sql.UniqueIdentifier, value: req.user!.userId },
      KaryaEventId:   { type: sql.UniqueIdentifier, value: karyaEventId ?? null },
      KaryaMomItemId: { type: sql.UniqueIdentifier, value: karyaMomItemId ?? null },
    })

    const card = rows[0]
    if (card?.board_id) {
      ioRef.io?.to(`board:${card.board_id}`).emit('card:created', card)
    }
    res.status(201).json({ success: true, data: card })
  } catch (err) { next(err) }
})

// PATCH /api/cards/:cardId  — update title/description/priority/due
cardsRouter.patch('/cards/:cardId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const b = req.body as {
      title?:        string
      description?:  string
      priority?:     string | null
      status?:       string | null
      dueDate?:      string | null
    }
    const clearDueDate = b.dueDate === null
    const rows = await execSP('usp_KUpdateCard', {
      CardId:        { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId:       { type: sql.UniqueIdentifier, value: req.user!.userId },
      Title:         { type: sql.NVarChar(500),    value: b.title ?? null },
      Description:   { type: sql.NVarChar(sql.MAX), value: b.description ?? null },
      Priority:      { type: sql.NVarChar(20),     value: b.priority ?? null },
      Status:        { type: sql.NVarChar(50),     value: b.status ?? null },
      DueDate:       { type: sql.DateTime2,        value: b.dueDate ? new Date(b.dueDate) : null },
      ClearDueDate:  { type: sql.Bit,              value: clearDueDate ? 1 : 0 },
    })

    const card = rows[0]
    if (card?.board_id) {
      ioRef.io?.to(`board:${card.board_id}`).emit('card:updated', card)
    }
    res.json({ success: true, data: card })
  } catch (err) { next(err) }
})

// POST /api/cards/:cardId/move  — move to another list / re-order
cardsRouter.post('/cards/:cardId/move', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { targetListId, position } = req.body as { targetListId?: string, position?: number }
    if (!targetListId || typeof position !== 'number') {
      res.status(400).json({ success: false, error: 'targetListId and position are required', code: 'missing_fields', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KMoveCard', {
      CardId:       { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId:      { type: sql.UniqueIdentifier, value: req.user!.userId },
      TargetListId: { type: sql.UniqueIdentifier, value: targetListId },
      Position:     { type: sql.Decimal(20, 10),  value: position },
    })
    const card = rows[0]
    if (card?.board_id) {
      ioRef.io?.to(`board:${card.board_id}`).emit('card:moved', card)
    }
    res.json({ success: true, data: card })
  } catch (err) { next(err) }
})

// POST /api/cards/:cardId/complete  — mark done / undone
cardsRouter.post('/cards/:cardId/complete', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { done } = req.body as { done?: boolean }
    const rows = await execSP('usp_KCompleteCard', {
      CardId:  { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
      Done:    { type: sql.Bit,              value: done ? 1 : 0 },
    })
    const card = rows[0]
    if (card?.board_id) {
      ioRef.io?.to(`board:${card.board_id}`).emit('card:completed', card)
    }
    res.json({ success: true, data: card })
  } catch (err) { next(err) }
})

// DELETE /api/cards/:cardId
cardsRouter.delete('/cards/:cardId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP('usp_KDeleteCard', {
      CardId:  { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows[0] ?? { deleted_card_id: req.params.cardId } })
  } catch (err) { next(err) }
})

// GET /api/cards/:cardId/comments
cardsRouter.get('/cards/:cardId/comments', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP('usp_KGetCardComments', {
      CardId: { type: sql.UniqueIdentifier, value: req.params.cardId },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

// POST /api/cards/:cardId/comments
cardsRouter.post('/cards/:cardId/comments', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { body } = req.body as { body?: string }
    if (!body || !body.trim()) {
      res.status(400).json({ success: false, error: 'body is required', code: 'missing_body', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KAddCardComment', {
      CardId:   { type: sql.UniqueIdentifier, value: req.params.cardId },
      AuthorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
      Body:     { type: sql.NVarChar(sql.MAX), value: body.trim() },
    })
    res.status(201).json({ success: true, data: rows[0] })
  } catch (err) { next(err) }
})

// ─── Phase 4b — full card detail (one round-trip for the modal) ──────────────

cardsRouter.get('/cards/:cardId/detail', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const result = await execSPMulti('usp_KGetCardDetail', {
      CardId: { type: sql.UniqueIdentifier, value: req.params.cardId },
      UserId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    const recordsets = result.recordsets as unknown as Record<string, unknown>[][]
    const [cardRows, comments, tasks, members, labels] = recordsets

    if (!cardRows || cardRows.length === 0) {
      res.status(404).json({ success: false, error: 'Card not found', code: 'not_found', statusCode: 404 })
      return
    }

    const c = cardRows[0]
    const recurrence = c.recurrence_frequency
      ? {
          frequency:       c.recurrence_frequency,
          intervalCount:   c.recurrence_interval,
          nextDueAt:       c.recurrence_next_due_at,
          lastCompletedAt: c.recurrence_last_completed_at,
          completionCount: c.recurrence_completion_count,
        }
      : null

    res.json({
      success: true,
      data: {
        card:       c,
        comments:   comments ?? [],
        tasks:      tasks    ?? [],
        members:    members  ?? [],
        labels:     labels   ?? [],
        recurrence,
      },
    })
  } catch (err) { next(err) }
})

// ─── Phase 4b — recurrence (set / clear) ─────────────────────────────────────

cardsRouter.put('/cards/:cardId/recurrence', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { frequency, intervalCount, nextDueAt } = req.body as {
      frequency?:     'daily' | 'weekly' | 'monthly'
      intervalCount?: number
      nextDueAt?:     string
    }
    if (!frequency || !['daily', 'weekly', 'monthly'].includes(frequency)) {
      res.status(400).json({ success: false, error: 'frequency must be daily/weekly/monthly', code: 'bad_frequency', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KSetCardRecurrence', {
      CardId:        { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId:       { type: sql.UniqueIdentifier, value: req.user!.userId },
      Frequency:     { type: sql.NVarChar(20),     value: frequency },
      IntervalCount: { type: sql.Int,              value: intervalCount ?? 1 },
      NextDueAt:     { type: sql.DateTime2,        value: nextDueAt ? new Date(nextDueAt) : null },
    })
    res.json({ success: true, data: rows[0] ?? null })
  } catch (err) { next(err) }
})

cardsRouter.delete('/cards/:cardId/recurrence', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await execSP('usp_KClearCardRecurrence', {
      CardId:  { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: null })
  } catch (err) { next(err) }
})

// ─── Phase 4b — subtask CRUD ─────────────────────────────────────────────────

cardsRouter.post('/cards/:cardId/tasks', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { text } = req.body as { text?: string }
    if (!text || !text.trim()) {
      res.status(400).json({ success: false, error: 'text is required', code: 'missing_text', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KAddCardTask', {
      CardId:  { type: sql.UniqueIdentifier, value: req.params.cardId },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
      Text:    { type: sql.NVarChar(1000),   value: text.trim() },
    })
    res.status(201).json({ success: true, data: rows[0] })
  } catch (err) { next(err) }
})

cardsRouter.patch('/tasks/:taskId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { done } = req.body as { done?: boolean }
    const rows = await execSP('usp_KToggleCardTask', {
      TaskId:  { type: sql.UniqueIdentifier, value: req.params.taskId },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
      Done:    { type: sql.Bit,              value: done ? 1 : 0 },
    })
    res.json({ success: true, data: rows[0] })
  } catch (err) { next(err) }
})

cardsRouter.delete('/tasks/:taskId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await execSP('usp_KDeleteCardTask', {
      TaskId: { type: sql.UniqueIdentifier, value: req.params.taskId },
    })
    res.json({ success: true, data: { id: req.params.taskId } })
  } catch (err) { next(err) }
})
