import { Router } from 'express'
import { db } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'

export const cartRouter = Router()
cartRouter.use(requireAuth)

cartRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const result = await db.query(
      `SELECT ci.id, ci.quantity, ci.added_at,
              p.id AS product_id, p.name, p.price, p.image_url, p.category
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = $1`,
      [req.user!.userId],
    )
    res.json({ success: true, data: result.rows })
  } catch (err) {
    next(err)
  }
})

cartRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { productId, quantity = 1 } = req.body as { productId: string; quantity?: number }
    const result = await db.query(
      `INSERT INTO cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
       RETURNING *`,
      [req.user!.userId, productId, quantity],
    )
    res.status(201).json({ success: true, data: result.rows[0] })
  } catch (err) {
    next(err)
  }
})

cartRouter.patch('/:itemId', async (req: AuthRequest, res, next) => {
  try {
    const { quantity } = req.body as { quantity: number }
    if (quantity < 1) {
      res.status(400).json({ success: false, error: 'Quantity must be >= 1', statusCode: 400 })
      return
    }
    const result = await db.query(
      'UPDATE cart_items SET quantity = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [quantity, req.params.itemId, req.user!.userId],
    )
    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: 'Cart item not found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: result.rows[0] })
  } catch (err) {
    next(err)
  }
})

cartRouter.delete('/:itemId', async (req: AuthRequest, res, next) => {
  try {
    await db.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [
      req.params.itemId,
      req.user!.userId,
    ])
    res.status(204).send()
  } catch (err) {
    next(err)
  }
})
