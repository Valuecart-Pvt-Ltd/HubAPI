import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import passport from '../config/passport'
import '../config/passportMicrosoft'
import { query } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { rowToUser } from '../config/passport'
import { CLIENT_URL } from '../config/urls'
import type { User, AuthTokenPayload } from '../types/shared'

export const authRouter = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signToken(user: User): string {
  const payload: AuthTokenPayload = {
    userId:    user.id,
    email:     user.email,
    name:      user.name,
    avatarUrl: user.avatarUrl,
  }
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' })
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

authRouter.get('/google', (req, res, next) => {
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    session:    false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessType: 'offline',
    prompt:     'consent',
  } as any)(req, res, next)
})

authRouter.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err: any, user: User | false) => {
    if (err) {
      console.error('[oauth/google/callback] TokenError details:', {
        name:       err?.name,
        message:    err?.message,
        code:       err?.code,
        status:     err?.status,
        oauthError: err?.oauthError,
        data:       err?.data,
        body:       err?.body,
      })
      return next(err)
    }
    if (!user) return res.redirect(`${CLIENT_URL}/login?error=oauth_failed`)
    const token = signToken(user)
    res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
  })(req, res, next)
})

// ─── Link Google Calendar to existing email/password account ─────────────────
//
// The client passes its JWT as ?token=... and we store it in the OAuth state.
// After Google redirects back, we use the state to identify which user to update.

authRouter.get('/google/link', requireAuth, (req: AuthRequest, res, next) => {
  const userToken = (req.query.token as string) ?? ''
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    session:    false,
    state:      userToken,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accessType: 'offline',
    prompt:     'consent',
  } as any)(req, res, next)
})

authRouter.get(
  '/google/link/callback',
  passport.authenticate('google', {
    session:         false,
    failureRedirect: `${CLIENT_URL}/?error=link_failed`,
  }),
  async (req: AuthRequest, res, next) => {
    try {
      const state     = (req.query.state as string) ?? ''
      const googleUser = req.user as User & {
        googleAccessToken?:  string
        googleRefreshToken?: string
        googleId?:           string
        avatarUrl?:          string
      }

      // Decode the original user's JWT from state
      let originalUserId: string | null = null
      try {
        const payload = jwt.verify(state, process.env.JWT_SECRET!) as AuthTokenPayload
        originalUserId = payload.userId
      } catch {
        // Invalid state — fall back to returning the Google user's token
        const token = signToken(googleUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // Fetch the Google user's tokens from DB (passport already upserted them)
      const { rows: googleRows } = await query<Record<string, unknown>>(
        `SELECT google_id, google_access_token, google_refresh_token, avatar_url
         FROM users WHERE id = $1`,
        [googleUser.id],
      )
      const gRow = googleRows[0]
      if (!gRow) {
        const token = signToken(googleUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // Copy Google tokens onto the original user account
      await query(
        `UPDATE users
         SET google_id            = $1,
             google_access_token  = $2,
             google_refresh_token = $3,
             avatar_url           = COALESCE($4, avatar_url)
         WHERE id = $5`,
        [
          gRow.google_id,
          gRow.google_access_token,
          gRow.google_refresh_token,
          gRow.avatar_url,
          originalUserId,
        ],
      )

      // Delete the temporary Google user if it's different from the original
      if (googleUser.id !== originalUserId) {
        await query(`DELETE FROM users WHERE id = $1`, [googleUser.id])
      }

      // Return a fresh token for the original user
      const { rows: updatedRows } = await query<Record<string, unknown>>(
        `SELECT * FROM users WHERE id = $1`,
        [originalUserId],
      )
      const token = signToken(rowToUser(updatedRows[0]))
      res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
    } catch (err) {
      next(err)
    }
  },
)

// ─── Local auth (email + password) ───────────────────────────────────────────

authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body as {
      email: string
      password: string
      name: string
    }

    if (!email || !password || !name) {
      res.status(400).json({
        success: false,
        error:   'email, password and name are required',
        code:    'missing_fields',
        statusCode: 400,
      })
      return
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email])
    if (existing.rows.length > 0) {
      res.status(409).json({
        success: false,
        error:   'Email already registered',
        code:    'email_taken',
        statusCode: 409,
      })
      return
    }

    const hash   = await bcrypt.hash(password, 12)
    const result = await query<Record<string, unknown>>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [email, name, hash],
    )

    const user  = rowToUser(result.rows[0])
    const token = signToken(user)
    res.status(201).json({ success: true, data: { token, user } })
  } catch (err) {
    next(err)
  }
})

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body as { email: string; password: string }

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error:   'email and password are required',
        code:    'missing_fields',
        statusCode: 400,
      })
      return
    }

    const result = await query<Record<string, unknown>>(
      'SELECT * FROM users WHERE email = $1',
      [email],
    )
    const row = result.rows[0]

    if (!row || !row.password_hash) {
      res.status(401).json({
        success: false,
        error:   'Invalid credentials',
        code:    'invalid_credentials',
        statusCode: 401,
      })
      return
    }

    const valid = await bcrypt.compare(password, row.password_hash as string)
    if (!valid) {
      res.status(401).json({
        success: false,
        error:   'Invalid credentials',
        code:    'invalid_credentials',
        statusCode: 401,
      })
      return
    }

    const user  = rowToUser(row)
    const token = signToken(user)
    res.json({ success: true, data: { token, user } })
  } catch (err) {
    next(err)
  }
})

// ─── Session management ───────────────────────────────────────────────────────

authRouter.post('/logout', (_req, res) => {
  res.json({ success: true, data: null })
})

// ─── Microsoft OAuth ──────────────────────────────────────────────────────────

authRouter.get('/microsoft', (req, res, next) => {
  passport.authenticate('microsoft', {
    session: false,
    prompt:  'select_account',
  } as any)(req, res, next)
})

authRouter.get(
  '/microsoft/callback',
  passport.authenticate('microsoft', {
    session:         false,
    failureRedirect: `${CLIENT_URL}/login?error=oauth_failed`,
  }),
  (req, res) => {
    const user  = req.user as User
    const token = signToken(user)
    res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
  },
)

// ─── Link Microsoft Calendar to existing account ──────────────────────────────

authRouter.get('/microsoft/link', requireAuth, (req: AuthRequest, res, next) => {
  const userToken = (req.query.token as string) ?? ''
  passport.authenticate('microsoft', {
    session: false,
    state:   userToken,
    prompt:  'select_account',
  } as any)(req, res, next)
})

authRouter.get(
  '/microsoft/link/callback',
  passport.authenticate('microsoft', {
    session:         false,
    failureRedirect: `${CLIENT_URL}/?error=link_failed`,
  }),
  async (req: AuthRequest, res, next) => {
    try {
      const state       = (req.query.state as string) ?? ''
      const msUser      = req.user as User

      let originalUserId: string | null = null
      try {
        const payload = jwt.verify(state, process.env.JWT_SECRET!) as AuthTokenPayload
        originalUserId = payload.userId
      } catch {
        const token = signToken(msUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // Fetch Microsoft tokens from the upserted user row
      const { rows: msRows } = await query<Record<string, unknown>>(
        `SELECT microsoft_id, microsoft_access_token, microsoft_refresh_token, avatar_url
         FROM users WHERE id = $1`,
        [msUser.id],
      )
      const mRow = msRows[0]
      if (!mRow) {
        const token = signToken(msUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // Copy Microsoft tokens onto the original user
      await query(
        `UPDATE users
         SET microsoft_id            = $1,
             microsoft_access_token  = $2,
             microsoft_refresh_token = $3,
             avatar_url              = COALESCE($4, avatar_url)
         WHERE id = $5`,
        [mRow.microsoft_id, mRow.microsoft_access_token, mRow.microsoft_refresh_token, mRow.avatar_url, originalUserId],
      )

      // Delete temp Microsoft user if different
      if (msUser.id !== originalUserId) {
        await query(`DELETE FROM users WHERE id = $1`, [msUser.id])
      }

      const { rows: updatedRows } = await query<Record<string, unknown>>(
        `SELECT * FROM users WHERE id = $1`,
        [originalUserId],
      )
      const token = signToken(rowToUser(updatedRows[0]))
      res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
    } catch (err) {
      next(err)
    }
  },
)

// ─── PATCH /api/auth/profile — update name or password ───────────────────────

authRouter.patch('/profile', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId
    const { name, currentPassword, newPassword } = req.body as {
      name?:            string
      currentPassword?: string
      newPassword?:     string
    }

    const { rows } = await query<Record<string, unknown>>(
      'SELECT * FROM users WHERE id = $1', [userId],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ success: false, error: 'User not found', code: 'user_not_found', statusCode: 404 })
      return
    }

    const setClauses: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (name !== undefined) {
      if (!name.trim()) {
        res.status(400).json({ success: false, error: 'Name cannot be empty', code: 'invalid_name', statusCode: 400 })
        return
      }
      setClauses.push(`name = $${idx++}`)
      params.push(name.trim())
    }

    if (newPassword !== undefined) {
      if (!currentPassword) {
        res.status(400).json({ success: false, error: 'Current password is required', code: 'missing_current_password', statusCode: 400 })
        return
      }
      if (!row.password_hash) {
        res.status(400).json({ success: false, error: 'This account uses social login — password change is not available', code: 'no_password', statusCode: 400 })
        return
      }
      const valid = await bcrypt.compare(currentPassword, row.password_hash as string)
      if (!valid) {
        res.status(400).json({ success: false, error: 'Current password is incorrect', code: 'wrong_password', statusCode: 400 })
        return
      }
      if (newPassword.length < 8) {
        res.status(400).json({ success: false, error: 'New password must be at least 8 characters', code: 'weak_password', statusCode: 400 })
        return
      }
      const hash = await bcrypt.hash(newPassword, 12)
      setClauses.push(`password_hash = $${idx++}`)
      params.push(hash)
    }

    if (setClauses.length === 0) {
      res.status(400).json({ success: false, error: 'Nothing to update', code: 'nothing_to_update', statusCode: 400 })
      return
    }

    params.push(userId)
    const { rows: updated } = await query<Record<string, unknown>>(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    )

    res.json({ success: true, data: rowToUser(updated[0]) })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/auth/avatar — upload profile picture (base64 data URL) ─────────

authRouter.post('/avatar', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId
    const { avatarDataUrl } = req.body as { avatarDataUrl: string }

    if (!avatarDataUrl || typeof avatarDataUrl !== 'string') {
      res.status(400).json({ success: false, error: 'avatarDataUrl is required', code: 'missing_avatar', statusCode: 400 })
      return
    }
    if (!avatarDataUrl.startsWith('data:image/')) {
      res.status(400).json({ success: false, error: 'Must be a valid image data URL', code: 'invalid_format', statusCode: 400 })
      return
    }
    // 200×200 JPEG at q=0.7 is ~20-40 KB; 600 000 chars ≈ 450 KB — very generous
    if (avatarDataUrl.length > 600_000) {
      res.status(413).json({ success: false, error: 'Image too large (max ~400 KB)', code: 'image_too_large', statusCode: 413 })
      return
    }

    const { rows } = await query<Record<string, unknown>>(
      `UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING *`,
      [avatarDataUrl, userId],
    )

    res.json({ success: true, data: rowToUser(rows[0]) })
  } catch (err) {
    next(err)
  }
})

// ─── Current user ─────────────────────────────────────────────────────────────

authRouter.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const result = await query<Record<string, unknown>>(
      'SELECT * FROM users WHERE id = $1',
      [req.user!.userId],
    )

    if (!result.rows[0]) {
      res.status(404).json({
        success: false,
        error:   'User not found',
        code:    'user_not_found',
        statusCode: 404,
      })
      return
    }

    res.json({ success: true, data: rowToUser(result.rows[0]) })
  } catch (err) {
    next(err)
  }
})
