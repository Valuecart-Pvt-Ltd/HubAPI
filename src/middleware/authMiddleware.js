const jwt = require('jsonwebtoken')
const { TokenExpiredError, JsonWebTokenError } = jwt

function extractToken(req) {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) return header.slice(7)
  return null
}

/**
 * Require a valid JWT. Attaches the decoded payload to `req.user`.
 * Returns 401 on missing/invalid/expired tokens.
 */
function requireAuth(req, res, next) {
  const token = extractToken(req)

  if (!token) {
    res.status(401).json({ success: false, error: 'No token provided', statusCode: 401 })
    return
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.user = payload
    next()
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      res.status(401).json({ success: false, error: 'Token expired', code: 'token_expired', statusCode: 401 })
      return
    }
    if (err instanceof JsonWebTokenError) {
      res.status(401).json({ success: false, error: 'Invalid token', code: 'invalid_token', statusCode: 401 })
      return
    }
    next(err)
  }
}

/**
 * Like requireAuth but does not reject when no token is present.
 */
function optionalAuth(req, _res, next) {
  const token = extractToken(req)
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET)
    } catch {
      // silently ignore — treat as unauthenticated
    }
  }
  next()
}

module.exports = { requireAuth, optionalAuth }
