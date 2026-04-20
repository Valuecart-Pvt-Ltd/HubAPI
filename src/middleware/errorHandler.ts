import { Request, Response, NextFunction } from 'express'

export interface AppError extends Error {
  statusCode?: number
  code?: string
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const statusCode = err.statusCode ?? 500
  const code       = err.code ?? 'internal_error'
  console.error(`[${statusCode}] ${req.method} ${req.originalUrl} — ${code}: ${err.message}`)
  if (statusCode >= 500 && err.stack) console.error(err.stack)
  res.status(statusCode).json({
    success: false,
    error:   err.message ?? 'Internal Server Error',
    code,
    statusCode,
  })
}
