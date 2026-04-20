const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const passport = require('../../config/passport')
require('../../config/passportMicrosoft')  // registers the 'microsoft' strategy

const { query } = require('../../config/db')
const { rowToUser } = require('../../config/passport')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signToken(user) {
  const payload = {
    userId:    user.id,
    email:     user.email,
    name:      user.name,
    avatarUrl: user.avatarUrl,
  }
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' })
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

function startGoogleOAuth(req, res, next) {
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    session:    false,
    accessType: 'offline',
    prompt:     'consent',
  })(req, res, next)
}

function googleCallback(req, res) {
  const user  = req.user
  const token = signToken(user)
  res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
}

// ── Google "link" flow: attach Google creds to an existing email/password user ─

function startGoogleLink(req, res, next) {
  const userToken = (req.query.token) || ''
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    session:    false,
    state:      userToken,
    accessType: 'offline',
    prompt:     'consent',
  })(req, res, next)
}

async function googleLinkCallback(req, res, next) {
  try {
    const state      = (req.query.state) || ''
    const googleUser = req.user

    let originalUserId = null
    try {
      const payload = jwt.verify(state, process.env.JWT_SECRET)
      originalUserId = payload.userId
    } catch {
      const token = signToken(googleUser)
      return res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
    }

    const { rows: googleRows } = await query(
      `SELECT google_id, google_access_token, google_refresh_token, avatar_url
         FROM users WHERE id = $1`,
      [googleUser.id],
    )
    const gRow = googleRows[0]
    if (!gRow) {
      const token = signToken(googleUser)
      return res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
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

    if (googleUser.id !== originalUserId) {
      await query('DELETE FROM users WHERE id = $1', [googleUser.id])
    }

    const { rows: updatedRows } = await query('SELECT * FROM users WHERE id = $1', [originalUserId])
    const token = signToken(rowToUser(updatedRows[0]))
    res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
  } catch (err) {
    next(err)
  }
}

// ─── Microsoft OAuth ──────────────────────────────────────────────────────────

function startMicrosoftOAuth(req, res, next) {
  passport.authenticate('microsoft', {
    session: false,
    prompt:  'select_account',
  })(req, res, next)
}

function microsoftCallback(req, res) {
  const user  = req.user
  const token = signToken(user)
  res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
}

function startMicrosoftLink(req, res, next) {
  const userToken = (req.query.token) || ''
  passport.authenticate('microsoft', {
    session: false,
    state:   userToken,
    prompt:  'select_account',
  })(req, res, next)
}

async function microsoftLinkCallback(req, res, next) {
  try {
    const state  = (req.query.state) || ''
    const msUser = req.user

    let originalUserId = null
    try {
      const payload = jwt.verify(state, process.env.JWT_SECRET)
      originalUserId = payload.userId
    } catch {
      const token = signToken(msUser)
      return res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
    }

    const { rows: msRows } = await query(
      `SELECT microsoft_id, microsoft_access_token, microsoft_refresh_token, avatar_url
         FROM users WHERE id = $1`,
      [msUser.id],
    )
    const mRow = msRows[0]
    if (!mRow) {
      const token = signToken(msUser)
      return res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
    }

    await query(
      `UPDATE users
          SET microsoft_id            = $1,
              microsoft_access_token  = $2,
              microsoft_refresh_token = $3,
              avatar_url              = COALESCE($4, avatar_url)
        WHERE id = $5`,
      [mRow.microsoft_id, mRow.microsoft_access_token, mRow.microsoft_refresh_token, mRow.avatar_url, originalUserId],
    )

    if (msUser.id !== originalUserId) {
      await query('DELETE FROM users WHERE id = $1', [msUser.id])
    }

    const { rows: updatedRows } = await query('SELECT * FROM users WHERE id = $1', [originalUserId])
    const token = signToken(rowToUser(updatedRows[0]))
    res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`)
  } catch (err) {
    next(err)
  }
}

// ─── Local auth ───────────────────────────────────────────────────────────────

async function register(req, res, next) {
  try {
    const { email, password, name } = req.body || {}

    if (!email || !password || !name) {
      res.status(400).json({
        success: false, error: 'email, password and name are required',
        code: 'missing_fields', statusCode: 400,
      })
      return
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email])
    if (existing.rows.length > 0) {
      res.status(409).json({
        success: false, error: 'Email already registered',
        code: 'email_taken', statusCode: 409,
      })
      return
    }

    const hash = await bcrypt.hash(password, 12)
    const result = await query(
      `INSERT INTO users (email, name, password_hash)
         OUTPUT INSERTED.*
         VALUES ($1, $2, $3)`,
      [email, name, hash],
    )

    const user  = rowToUser(result.rows[0])
    const token = signToken(user)
    res.status(201).json({ success: true, data: { token, user } })
  } catch (err) {
    next(err)
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body || {}

    if (!email || !password) {
      res.status(400).json({
        success: false, error: 'email and password are required',
        code: 'missing_fields', statusCode: 400,
      })
      return
    }

    const result = await query('SELECT * FROM users WHERE email = $1', [email])
    const row = result.rows[0]

    if (!row || !row.password_hash) {
      res.status(401).json({
        success: false, error: 'Invalid credentials',
        code: 'invalid_credentials', statusCode: 401,
      })
      return
    }

    const valid = await bcrypt.compare(password, row.password_hash)
    if (!valid) {
      res.status(401).json({
        success: false, error: 'Invalid credentials',
        code: 'invalid_credentials', statusCode: 401,
      })
      return
    }

    const user  = rowToUser(row)
    const token = signToken(user)
    res.json({ success: true, data: { token, user } })
  } catch (err) {
    next(err)
  }
}

function logout(_req, res) {
  res.json({ success: true, data: null })
}

// ─── Profile update ───────────────────────────────────────────────────────────

async function updateProfile(req, res, next) {
  try {
    const userId = req.user.userId
    const { name, currentPassword, newPassword } = req.body || {}

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId])
    const row = rows[0]
    if (!row) {
      res.status(404).json({ success: false, error: 'User not found', code: 'user_not_found', statusCode: 404 })
      return
    }

    const setClauses = []
    const params     = []
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
      const valid = await bcrypt.compare(currentPassword, row.password_hash)
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
    const { rows: updated } = await query(
      `UPDATE users
          SET ${setClauses.join(', ')}
          OUTPUT INSERTED.*
        WHERE id = $${idx}`,
      params,
    )

    res.json({ success: true, data: rowToUser(updated[0]) })
  } catch (err) {
    next(err)
  }
}

async function uploadAvatar(req, res, next) {
  try {
    const userId = req.user.userId
    const { avatarDataUrl } = req.body || {}

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

    const { rows } = await query(
      `UPDATE users
          SET avatar_url = $1
          OUTPUT INSERTED.*
        WHERE id = $2`,
      [avatarDataUrl, userId],
    )

    res.json({ success: true, data: rowToUser(rows[0]) })
  } catch (err) {
    next(err)
  }
}

async function getMe(req, res, next) {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [req.user.userId])
    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: 'User not found', code: 'user_not_found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: rowToUser(result.rows[0]) })
  } catch (err) {
    next(err)
  }
}

module.exports = {
  startGoogleOAuth,
  googleCallback,
  startGoogleLink,
  googleLinkCallback,
  startMicrosoftOAuth,
  microsoftCallback,
  startMicrosoftLink,
  microsoftLinkCallback,
  register,
  login,
  logout,
  updateProfile,
  uploadAvatar,
  getMe,
}
