import { Router } from 'express'
import { db } from '../db'

export const productsRouter = Router()

productsRouter.get('/', async (req, res, next) => {
  try {
    const { page = '1', pageSize = '20', category } = req.query
    const offset = (Number(page) - 1) * Number(pageSize)

    const conditions = category ? 'WHERE category = $3' : ''
    const params: unknown[] = [Number(pageSize), offset]
    if (category) params.push(category)

    const [rows, countRow] = await Promise.all([
      db.query(`SELECT * FROM products ${conditions} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params),
      db.query(`SELECT COUNT(*) FROM products ${conditions}`, category ? [category] : []),
    ])

    const total = Number(countRow.rows[0].count)
    res.json({
      success: true,
      data: {
        items: rows.rows,
        total,
        page: Number(page),
        pageSize: Number(pageSize),
        totalPages: Math.ceil(total / Number(pageSize)),
      },
    })
  } catch (err) {
    next(err)
  }
})

productsRouter.get('/:id', async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id])
    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: 'Product not found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: result.rows[0] })
  } catch (err) {
    next(err)
  }
})
