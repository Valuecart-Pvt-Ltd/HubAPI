import { Router } from 'express'
import { execSP, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'

export const workspacesRouter = Router()

interface WorkspaceRow {
  id:          string
  name:        string
  color:       string
  created_by:  string
  created_at:  Date
  updated_at:  Date
  role:        string
  board_count: number
}

function shape(row: WorkspaceRow) {
  return {
    id:         row.id,
    name:       row.name,
    color:      row.color,
    createdBy:  row.created_by,
    createdAt:  row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt:  row.updated_at?.toISOString?.() ?? row.updated_at,
    role:       row.role,
    boardCount: row.board_count,
  }
}

// GET /api/workspaces  — list workspaces the current user is a member of
workspacesRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP<WorkspaceRow>('usp_KGetWorkspaces', {
      UserId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows.map(shape) })
  } catch (err) { next(err) }
})

// POST /api/workspaces  — create a new workspace, current user becomes owner
workspacesRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { name, color } = req.body as { name?: string, color?: string }
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'name is required', code: 'missing_name', statusCode: 400 })
      return
    }
    const rows = await execSP<WorkspaceRow>('usp_KCreateWorkspace', {
      Name:      { type: sql.NVarChar(255),    value: name.trim() },
      Color:     { type: sql.NVarChar(20),     value: color ?? '#F0841C' },
      CreatedBy: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.status(201).json({ success: true, data: shape(rows[0]) })
  } catch (err) { next(err) }
})
