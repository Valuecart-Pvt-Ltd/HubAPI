const { query } = require('../../config/db')

async function list(req, res, next) {
  try {
    const result = await query(
      `SELECT ci.id, ci.quantity, ci.added_at,
              p.id AS product_id, p.name, p.price, p.image_url, p.category
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.user_id = $1`,
      [req.user.userId],
    )
    res.json({ success: true, data: result.rows })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/cart  — add item or increment qty if already in cart.
 * Postgres `ON CONFLICT DO UPDATE` → MSSQL `MERGE` with OUTPUT INSERTED.*.
 */
async function addItem(req, res, next) {
  try {
    const { productId, quantity = 1 } = req.body
    const result = await query(
      `MERGE cart_items AS tgt
         USING (VALUES ($1, $2, $3)) AS src (user_id, product_id, quantity)
         ON tgt.user_id = src.user_id AND tgt.product_id = src.product_id
         WHEN MATCHED THEN UPDATE SET quantity = tgt.quantity + src.quantity
         WHEN NOT MATCHED THEN
           INSERT (user_id, product_id, quantity)
           VALUES (src.user_id, src.product_id, src.quantity)
         OUTPUT INSERTED.*;`,
      [req.user.userId, productId, quantity],
    )
    res.status(201).json({ success: true, data: result.rows[0] })
  } catch (err) {
    next(err)
  }
}

async function updateQuantity(req, res, next) {
  try {
    const { quantity } = req.body
    if (quantity < 1) {
      res.status(400).json({ success: false, error: 'Quantity must be >= 1', statusCode: 400 })
      return
    }
    // `RETURNING *` → `OUTPUT INSERTED.*`
    const result = await query(
      `UPDATE cart_items
          SET quantity = $1
         OUTPUT INSERTED.*
        WHERE id = $2 AND user_id = $3`,
      [quantity, req.params.itemId, req.user.userId],
    )
    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: 'Cart item not found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: result.rows[0] })
  } catch (err) {
    next(err)
  }
}

async function deleteItem(req, res, next) {
  try {
    await query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [
      req.params.itemId,
      req.user.userId,
    ])
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

module.exports = { list, addItem, updateQuantity, deleteItem }
