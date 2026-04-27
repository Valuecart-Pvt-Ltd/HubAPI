import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import passport from '../config/passport'
import '../config/passportMicrosoft'
import { execSP, query, sql } from '../db'
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

async function getUserById(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await execSP<Record<string, unknown>>('usp_GetUserById', {
    UserId: { type: sql.UniqueIdentifier, value: userId },
  })
  return rows[0] ?? null
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
      const state      = (req.query.state as string) ?? ''
      const googleUser = req.user as User

      let originalUserId: string | null = null
      try {
        const payload = jwt.verify(state, process.env.JWT_SECRET!) as AuthTokenPayload
        originalUserId = payload.userId
      } catch {
        const token = signToken(googleUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // Read the temporary Google user's tokens (passport upserted them in googleVerify)
      const gRow = await getUserById(googleUser.id)
      if (!gRow) {
        const token = signToken(googleUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // Link tokens onto the original account (SP also clears google_id from any
      // other row that matches — keeps the unique constraint clean).
      const linked = await execSP<Record<string, unknown>>('usp_LinkGoogleToUser', {
        OriginalUserId: { type: sql.UniqueIdentifier,   value: originalUserId },
        GoogleId:       { type: sql.NVarChar(255),      value: gRow.google_id },
        AvatarUrl:      { type: sql.NVarChar(sql.MAX),  value: gRow.avatar_url },
        AccessToken:    { type: sql.NVarChar(sql.MAX),  value: gRow.google_access_token },
        RefreshToken:   { type: sql.NVarChar(sql.MAX),  value: gRow.google_refresh_token },
        TokenExpiry:    { type: sql.DateTime2,          value: gRow.google_token_expiry ?? null },
      })

      // Delete the temporary Google user if it's a different row
      if (googleUser.id !== originalUserId) {
        await query('DELETE FROM users WHERE id = @id', {
          id: { type: sql.UniqueIdentifier, value: googleUser.id },
        })
      }

      const token = signToken(rowToUser(linked[0] ?? gRow))
      res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
    } catch (err) {
      next(err)
    }
  },
)

// ─── Local auth (email + password) ───────────────────────────────────────────

authRouter.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body as { email: string; password: string; name: string }

    if (!email || !password || !name) {
      res.status(400).json({
        success: false,
        error:   'email, password and name are required',
        code:    'missing_fields',
        statusCode: 400,
      })
      return
    }

    const hash = await bcrypt.hash(password, 12)
    let rows: Record<string, unknown>[]
    try {
      rows = await execSP<Record<string, unknown>>('usp_RegisterUser', {
        Email:        { type: sql.NVarChar(255),     value: email },
        Name:         { type: sql.NVarChar(255),     value: name },
        PasswordHash: { type: sql.NVarChar(sql.MAX), value: hash },
      })
    } catch (err) {
      // SP raises 'EMAIL_TAKEN' for duplicate emails
      if (err instanceof Error && err.message.includes('EMAIL_TAKEN')) {
        res.status(409).json({
          success: false,
          error:   'Email already registered',
          code:    'email_taken',
          statusCode: 409,
        })
        return
      }
      throw err
    }

    const user  = rowToUser(rows[0])
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

    const rows = await execSP<Record<string, unknown>>('usp_GetUserByEmail', {
      Email: { type: sql.NVarChar(255), value: email },
    })
    const row = rows[0]

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
      const state  = (req.query.state as string) ?? ''
      const msUser = req.user as User

      let originalUserId: string | null = null
      try {
        const payload = jwt.verify(state, process.env.JWT_SECRET!) as AuthTokenPayload
        originalUserId = payload.userId
      } catch {
        const token = signToken(msUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      const mRow = await getUserById(msUser.id)
      if (!mRow) {
        const token = signToken(msUser)
        return res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`)
      }

      // No SP for Microsoft link — inline T-SQL
      await query(
        `UPDATE users
         SET microsoft_id            = @microsoftId,
             microsoft_access_token  = @accessToken,
             microsoft_refresh_token = @refreshToken,
             avatar_url              = ISNULL(@avatarUrl, avatar_url)
         WHERE id = @userId`,
        {
          microsoftId:  { type: sql.NVarChar(255),     value: mRow.microsoft_id },
          accessToken:  { type: sql.NVarChar(sql.MAX), value: mRow.microsoft_access_token },
          refreshToken: { type: sql.NVarChar(sql.MAX), value: mRow.microsoft_refresh_token },
          avatarUrl:    { type: sql.NVarChar(sql.MAX), value: mRow.avatar_url },
          userId:       { type: sql.UniqueIdentifier,  value: originalUserId },
        },
      )

      if (msUser.id !== originalUserId) {
        await query('DELETE FROM users WHERE id = @id', {
          id: { type: sql.UniqueIdentifier, value: msUser.id },
        })
      }

      const updated = await getUserById(originalUserId)
      const token = signToken(rowToUser(updated ?? mRow))
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

    const row = await getUserById(userId)
    if (!row) {
      res.status(404).json({ success: false, error: 'User not found', code: 'user_not_found', statusCode: 404 })
      return
    }

    if (name !== undefined && !name.trim()) {
      res.status(400).json({ success: false, error: 'Name cannot be empty', code: 'invalid_name', statusCode: 400 })
      return
    }

    let newPasswordHash: string | null = null
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
      newPasswordHash = await bcrypt.hash(newPassword, 12)
    }

    if (name === undefined && newPasswordHash === null) {
      res.status(400).json({ success: false, error: 'Nothing to update', code: 'nothing_to_update', statusCode: 400 })
      return
    }

    // Update name via SP; update password_hash inline (SP doesn't cover it)
    if (name !== undefined) {
      await execSP('usp_UpdateUserProfile', {
        UserId: { type: sql.UniqueIdentifier,  value: userId },
        Name:   { type: sql.NVarChar(255),     value: name.trim() },
      })
    }
    if (newPasswordHash !== null) {
      await query('UPDATE users SET password_hash = @hash WHERE id = @id', {
        hash: { type: sql.NVarChar(sql.MAX), value: newPasswordHash },
        id:   { type: sql.UniqueIdentifier,  value: userId },
      })
    }

    const updated = await getUserById(userId)
    if (!updated) {
      res.status(500).json({ success: false, error: 'User vanished after update', statusCode: 500 })
      return
    }
    res.json({ success: true, data: rowToUser(updated) })
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
    if (avatarDataUrl.length > 600_000) {
      res.status(413).json({ success: false, error: 'Image too large (max ~400 KB)', code: 'image_too_large', statusCode: 413 })
      return
    }

    await execSP('usp_UpdateUserProfile', {
      UserId:    { type: sql.UniqueIdentifier, value: userId },
      AvatarUrl: { type: sql.NVarChar(sql.MAX), value: avatarDataUrl },
    })
    const updated = await getUserById(userId)
    if (!updated) {
      res.status(404).json({ success: false, error: 'User not found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: rowToUser(updated) })
  } catch (err) {
    next(err)
  }
})

// ─── Current user ─────────────────────────────────────────────────────────────

authRouter.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const row = await getUserById(req.user!.userId)
    if (!row) {
      res.status(404).json({
        success: false,
        error:   'User not found',
        code:    'user_not_found',
        statusCode: 404,
      })
      return
    }
    res.json({ success: true, data: rowToUser(row) })
  } catch (err) {
    next(err)
  }
})
