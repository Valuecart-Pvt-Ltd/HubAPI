import { Request, Response, NextFunction } from 'express'
import jwt, { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken'
import type { AuthTokenPayload } from '../types/shared'

export interface AuthRequest extends Request {
  user?: AuthTokenPayload
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  return null
}

/**
 * Require a valid JWT. Attaches the decoded payload to `req.user`.
 * Returns 401 on missing/invalid/expired tokens.
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req)

  if (!token) {
    res.status(401).json({ success: false, error: 'No token provided', statusCode: 401 })
    return
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthTokenPayload
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
 * Like requireAuth but does not reject the request when no token is present.
 * Useful for endpoints that have optional auth-aware behaviour.
 */
export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const token = extractToken(req)
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET!) as AuthTokenPayload
    } catch {
      // silently ignore — treat as unauthenticated
    }
  }
  next()
}
