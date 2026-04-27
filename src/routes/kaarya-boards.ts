import { Router } from 'express'
import { execSP, execSPMulti, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'

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
