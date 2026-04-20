const { query } = require('../../config/db')

/**
 * GET /api/products
 * Paginated product list, optional ?category filter.
 */
async function list(req, res, next) {
  try {
    const page     = Number(req.query.page) || 1
    const pageSize = Number(req.query.pageSize) || 20
    const category = req.query.category
    const offset   = (page - 1) * pageSize

    // MSSQL paging uses OFFSET / FETCH NEXT (vs PG's LIMIT/OFFSET)
    const listParams  = [pageSize, offset]
    let   whereClause = ''
    if (category) {
      whereClause = 'WHERE category = $3'
      listParams.push(category)
    }

    const listSql = `
      SELECT *
      FROM products
      ${whereClause}
      ORDER BY created_at DESC
      OFFSET $2 ROWS FETCH NEXT $1 ROWS ONLY
    `

    const countSql = `SELECT COUNT(*) AS count FROM products ${whereClause}`
    const countParams = category ? [category] : []

    const [rowsRes, countRes] = await Promise.all([
      query(listSql, listParams),
      query(countSql, countParams),
    ])

    const total = Number(countRes.rows[0]?.count ?? 0)

    res.json({
      success: true,
      data: {
        items:      rowsRes.rows,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /api/products/:id
 */
async function getById(req, res, next) {
  try {
    const result = await query('SELECT * FROM products WHERE id = $1', [req.params.id])
    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: 'Product not found', statusCode: 404 })
      return
    }
    res.json({ success: true, data: result.rows[0] })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, getById }
