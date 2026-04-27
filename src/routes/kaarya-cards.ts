import { Router } from 'express'
import { execSP, sql } from '../db'
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
