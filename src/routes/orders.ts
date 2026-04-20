import { Router } from 'express'
import { db } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'

export const ordersRouter = Router()
ordersRouter.use(requireAuth)

ordersRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const orders = await db.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user!.userId],
    )
    res.json({ success: true, data: orders.rows })
  } catch (err) {
    next(err)
  }
})

ordersRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const [order, items] = await Promise.all([
      db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [
        req.params.id,
        req.user!.userId,
      ]),
      db.query(
        `SELECT oi.*, p.name, p.image_url FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1`,
        [req.params.id],
      ),
    ])
    if (!order.rows[0]) {
      res.status(404).json({ success: false, error: 'Order not found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: { ...order.rows[0], items: items.rows } })
  } catch (err) {
    next(err)
  }
})

// Checkout: convert cart to an order
ordersRouter.post('/checkout', async (req: AuthRequest, res, next) => {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const cartItems = await client.query(
      `SELECT ci.quantity, p.id AS product_id, p.price
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = $1`,
      [req.user!.userId],
    )

    if (cartItems.rows.length === 0) {
      res.status(400).json({ success: false, error: 'Cart is empty', statusCode: 400 })
      return
    }

    const total = cartItems.rows.reduce(
      (sum: number, r: { quantity: number; price: number }) => sum + r.quantity * r.price,
      0,
    )

    const order = await client.query(
      "INSERT INTO orders (user_id, status, total_amount) VALUES ($1, 'pending', $2) RETURNING *",
      [req.user!.userId, total],
    )

    await Promise.all(
      cartItems.rows.map((item: { product_id: string; quantity: number; price: number }) =>
        client.query(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [order.rows[0].id, item.product_id, item.quantity, item.price],
        ),
      ),
    )

    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user!.userId])
    await client.query('COMMIT')

    res.status(201).json({ success: true, data: order.rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    next(err)
  } finally {
    client.release()
  }
})
