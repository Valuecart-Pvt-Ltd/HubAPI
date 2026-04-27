import { Router } from 'express'

export const ordersRouter = Router()
ordersRouter.use((_req, res) => res.status(410).json({
  success: false,
  error: 'This endpoint has been removed',
  code: 'gone',
  statusCode: 410,
}))
