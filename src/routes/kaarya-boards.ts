import { Router } from 'express'
import { execSP, execSPMulti, query, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { ioRef } from '../io'

export const boardsRouter = Router()

// GET /api/workspaces/:workspaceId/boards  — list boards in a workspace
boardsRouter.get('/workspaces/:workspaceId/boards', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP('usp_KGetBoards', {
      WorkspaceId: { type: sql.UniqueIdentifier, value: req.params.workspaceId },
      UserId:      { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

// POST /api/workspaces/:workspaceId/boards  — create a new board
boardsRouter.post('/workspaces/:workspaceId/boards', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { name, description, color } = req.body as { name?: string, description?: string, color?: string }
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'name is required', code: 'missing_name', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KCreateBoard', {
      WorkspaceId: { type: sql.UniqueIdentifier, value: req.params.workspaceId },
      Name:        { type: sql.NVarChar(255),    value: name.trim() },
      Description: { type: sql.NVarChar(sql.MAX), value: description ?? null },
      Color:       { type: sql.NVarChar(20),     value: color ?? '#1F2937' },
      UserId:      { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.status(201).json({ success: true, data: rows[0] })
  } catch (err) { next(err) }
})

// GET /api/boards/:boardId  — full board detail (lists, cards, labels)
boardsRouter.get('/boards/:boardId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const result = await execSPMulti('usp_KGetBoardDetail', {
      BoardId: { type: sql.UniqueIdentifier, value: req.params.boardId },
      UserId:  { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    const recordsets = result.recordsets as unknown as Record<string, unknown>[][]
    const [boardRows, listsRows, cardsRows, labelsRows] = recordsets

    if (!boardRows || boardRows.length === 0) {
      res.status(404).json({ success: false, error: 'Board not found', code: 'not_found', statusCode: 404 })
      return
    }

    res.json({
      success: true,
      data: {
        board:  boardRows[0],
        lists:  listsRows ?? [],
        cards:  (cardsRows ?? []).map(c => ({
          ...c,
          members: c.members_json ? JSON.parse(c.members_json as string) : [],
          labels:  c.labels_json  ? JSON.parse(c.labels_json  as string) : [],
        })),
        labels: labelsRows ?? [],
      },
    })
  } catch (err) { next(err) }
})

// POST /api/boards/:boardId/lists  — add a column to a board
boardsRouter.post('/boards/:boardId/lists', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { name, color } = req.body as { name?: string, color?: string }
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'name is required', code: 'missing_name', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KCreateList', {
      BoardId: { type: sql.UniqueIdentifier, value: req.params.boardId },
      Name:    { type: sql.NVarChar(255),    value: name.trim() },
      Color:   { type: sql.NVarChar(20),     value: color ?? '#6B7280' },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.status(201).json({ success: true, data: rows[0] })
  } catch (err) { next(err) }
})

// GET /api/boards/:boardId/activity  — recent activity feed
boardsRouter.get('/boards/:boardId/activity', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
    const rows = await execSP('usp_KGetBoardActivity', {
      BoardId: { type: sql.UniqueIdentifier, value: req.params.boardId },
      Limit:   { type: sql.Int,              value: limit },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

// ─── Phase 6 — list reorder ──────────────────────────────────────────────────

boardsRouter.post('/lists/:listId/move', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { position } = req.body as { position?: number }
    if (typeof position !== 'number') {
      res.status(400).json({ success: false, error: 'position is required', code: 'missing_position', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KMoveList', {
      ListId:   { type: sql.UniqueIdentifier, value: req.params.listId },
      Position: { type: sql.Int,              value: position },
      ActorId:  { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    const list = rows[0] as { board_id?: string } | undefined
    if (list?.board_id) {
      ioRef.io?.to(`board:${list.board_id}`).emit('list:moved', list)
    }
    res.json({ success: true, data: list ?? null })
  } catch (err) { next(err) }
})

// ─── Phase 4d — Board labels catalog ─────────────────────────────────────────

boardsRouter.get('/boards/:boardId/labels', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP('usp_KGetBoardLabels', {
      BoardId: { type: sql.UniqueIdentifier, value: req.params.boardId },
      UserId:  { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

boardsRouter.post('/boards/:boardId/labels', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { name, color } = req.body as { name?: string, color?: string }
    if (!name || !name.trim() || !color) {
      res.status(400).json({ success: false, error: 'name and color are required', code: 'missing_fields', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KCreateLabel', {
      BoardId: { type: sql.UniqueIdentifier, value: req.params.boardId },
      Name:    { type: sql.NVarChar(100),    value: name.trim() },
      Color:   { type: sql.NVarChar(20),     value: color },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    ioRef.io?.to(`board:${req.params.boardId}`).emit('labels:changed', rows[0])
    res.status(201).json({ success: true, data: rows[0] })
  } catch (err) { next(err) }
})

boardsRouter.delete('/labels/:labelId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    // Look up the board_id BEFORE delete so we can emit on the right room.
    const lookup = await query<{ board_id: string }>(
      'SELECT board_id FROM kaarya_labels WHERE id = @id',
      { id: { type: sql.UniqueIdentifier, value: req.params.labelId } },
    )
    const boardId = lookup[0]?.board_id

    await execSP('usp_KDeleteLabel', {
      LabelId: { type: sql.UniqueIdentifier, value: req.params.labelId },
      ActorId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    if (boardId) ioRef.io?.to(`board:${boardId}`).emit('labels:changed', { deletedId: req.params.labelId })
    res.json({ success: true, data: null })
  } catch (err) { next(err) }
})

// ─── Phase 4b — board analytics (5 recordsets in one round-trip) ─────────────

boardsRouter.get('/boards/:boardId/analytics', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const result = await execSPMulti('usp_KGetBoardAnalytics', {
      BoardId: { type: sql.UniqueIdentifier, value: req.params.boardId },
      UserId:  { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    const recordsets = result.recordsets as unknown as Record<string, unknown>[][]
    const [headlineRows, byPriority, byList, topAssignees, completionTimeline] = recordsets

    res.json({
      success: true,
      data: {
        headline:           headlineRows?.[0] ?? null,
        byPriority:         byPriority         ?? [],
        byList:             byList             ?? [],
        topAssignees:       topAssignees       ?? [],
        completionTimeline: completionTimeline ?? [],
      },
    })
  } catch (err) { next(err) }
})
