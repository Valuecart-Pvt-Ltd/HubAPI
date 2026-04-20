const { query, withTransaction } = require('../../config/db')

async function list(req, res, next) {
  try {
    const orders = await query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId],
    )
    res.json({ success: true, data: orders.rows })
  } catch (err) {
    next(err)
  }
}

async function getById(req, res, next) {
  try {
    const [order, items] = await Promise.all([
      query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId]),
      query(
        `SELECT oi.*, p.name, p.image_url
           FROM order_items oi
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
}

/**
 * POST /api/orders/checkout — convert cart → order atomically.
 */
async function checkout(req, res, next) {
  try {
    const userId = req.user.userId

    const result = await withTransaction(async (tx) => {
      const cart = await tx(
        `SELECT ci.quantity, p.id AS product_id, p.price
           FROM cart_items ci
           JOIN products p ON p.id = ci.product_id
          WHERE ci.user_id = $1`,
        [userId],
      )

      if (cart.rows.length === 0) {
        const err = new Error('Cart is empty')
        err.statusCode = 400
        throw err
      }

      const total = cart.rows.reduce((sum, r) => sum + Number(r.quantity) * Number(r.price), 0)

      const orderRes = await tx(
        `INSERT INTO orders (user_id, status, total_amount)
           OUTPUT INSERTED.*
           VALUES ($1, 'pending', $2)`,
        [userId, total],
      )
      const order = orderRes.rows[0]

      // Sequential inserts in a transaction — simpler than Promise.all for MSSQL
      for (const item of cart.rows) {
        await tx(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
             VALUES ($1, $2, $3, $4)`,
          [order.id, item.product_id, item.quantity, item.price],
        )
      }

      await tx('DELETE FROM cart_items WHERE user_id = $1', [userId])

      return order
    })

    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, getById, checkout }
