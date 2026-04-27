import { Router } from 'express'
import crypto from 'node:crypto'
import { execSP, query, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { sendWorkspaceInvitationEmail } from '../services/emailService'
import { CLIENT_URL } from '../config/urls'

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

// GET /api/workspaces/:wsId/users  — for the card-member assignment picker
workspacesRouter.get('/:wsId/users', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP('usp_KGetWorkspaceUsers', {
      WorkspaceId: { type: sql.UniqueIdentifier, value: req.params.wsId },
      UserId:      { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

// ─── Phase 6 — workspace invitations ─────────────────────────────────────────

// GET /api/workspaces/:wsId/invitations — for the share dialog (members + pending)
workspacesRouter.get('/:wsId/invitations', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rows = await execSP('usp_KListInvitations', {
      WorkspaceId: { type: sql.UniqueIdentifier, value: req.params.wsId },
      ActorId:     { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

// POST /api/workspaces/:wsId/invitations  body: { email, role? }
workspacesRouter.post('/:wsId/invitations', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { email, role } = req.body as { email?: string, role?: 'member' | 'admin' }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      res.status(400).json({ success: false, error: 'Valid email required', code: 'bad_email', statusCode: 400 })
      return
    }

    const token     = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    let rows: Record<string, unknown>[]
    try {
      rows = await execSP('usp_KCreateInvitation', {
        WorkspaceId: { type: sql.UniqueIdentifier, value: req.params.wsId },
        Email:       { type: sql.NVarChar(255),    value: email.toLowerCase() },
        Role:        { type: sql.NVarChar(20),     value: role ?? 'member' },
        Token:       { type: sql.NVarChar(100),    value: token },
        ExpiresAt:   { type: sql.DateTime2,        value: expiresAt },
        ActorId:     { type: sql.UniqueIdentifier, value: req.user!.userId },
      })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('ALREADY_MEMBER')) {
        res.status(409).json({ success: false, error: 'Already a workspace member', code: 'already_member', statusCode: 409 })
        return
      }
      throw err
    }

    // Send the invite email asynchronously — don't block the API response
    ;(async () => {
      try {
        const wsRows = await query<{ name: string }>(
          'SELECT name FROM kaarya_workspaces WHERE id = @id',
          { id: { type: sql.UniqueIdentifier, value: req.params.wsId } },
        )
        await sendWorkspaceInvitationEmail({
          to:            email,
          workspaceName: wsRows[0]?.name ?? 'Kaarya workspace',
          inviterName:   req.user!.name,
          acceptUrl:     `${CLIENT_URL}/kaarya/invite/accept?token=${encodeURIComponent(token)}`,
          expiresAt,
        })
      } catch (err) {
        console.error('[invite] email send failed (non-fatal):', (err as Error).message)
      }
    })()

    res.status(201).json({ success: true, data: rows[0] ?? null })
  } catch (err) { next(err) }
})

// DELETE /api/workspaces/invitations/:invitationId — revoke
workspacesRouter.delete('/invitations/:invitationId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await execSP('usp_KRevokeInvitation', {
      InvitationId: { type: sql.UniqueIdentifier, value: req.params.invitationId },
      ActorId:      { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: null })
  } catch (err) { next(err) }
})

// POST /api/workspaces/invitations/accept  body: { token }
// The accepter must be authenticated; their JWT email is matched against the
// invitation email by usp_KAcceptInvitation.
workspacesRouter.post('/invitations/accept', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { token } = req.body as { token?: string }
    if (!token) {
      res.status(400).json({ success: false, error: 'token is required', code: 'missing_token', statusCode: 400 })
      return
    }
    const rows = await execSP('usp_KAcceptInvitation', {
      Token:  { type: sql.NVarChar(100),    value: token },
      UserId: { type: sql.UniqueIdentifier, value: req.user!.userId },
    })
    res.json({ success: true, data: rows[0] ?? null })
  } catch (err) { next(err) }
})
