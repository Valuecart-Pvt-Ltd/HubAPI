import { Router } from 'express'

export const cartRouter = Router()
cartRouter.use((_req, res) => res.status(410).json({
  success: false,
  error: 'This endpoint has been removed',
  code: 'gone',
  statusCode: 410,
}))
