/**
 * MSSQL database pool + query helper.
 *
 * The rest of the server was originally written against PostgreSQL (`pg`)
 * with `$1, $2, ...` positional placeholders and `query(text, params)`
 * returning `{ rows }`. This wrapper:
 *
 *   1. Builds a singleton `mssql.ConnectionPool`.
 *   2. Exposes a `query(text, params)` function that accepts the SAME
 *      Postgres-style SQL (`$1, $2, ...`) and returns `{ rows, rowCount }`
 *      shaped like `pg` did — so module code barely changes.
 *   3. Mechanically converts `$N` placeholders to `@pN` and binds params
 *      by ordinal position.
 *   4. Provides `withTransaction(cb)` for multi-statement transactions.
 *
 * IMPORTANT: Callers must still rewrite Postgres-specific features that
 * this wrapper CANNOT translate:
 *   - `RETURNING ...`      → use `OUTPUT INSERTED.*` / `OUTPUT DELETED.*`
 *   - `ON CONFLICT ...`    → use `MERGE` or `IF EXISTS` pattern
 *   - `ILIKE`              → `LIKE` (SQL Server is case-insensitive by default collation)
 *   - `gen_random_uuid()`  → `NEWID()` in SQL, or `crypto.randomUUID()` in Node
 *   - JSONB ops (`->`)     → `JSON_VALUE()` / `JSON_QUERY()`
 *
 * See the individual module files for the converted queries.
 */
const sql = require('mssql')

const config = {
  server:   process.env.MSSQL_SERVER   || 'localhost',
  port:     parseInt(process.env.MSSQL_PORT || '1433', 10),
  database: process.env.MSSQL_DATABASE || 'valuecart_mom',
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt:                process.env.MSSQL_ENCRYPT    !== 'false',
    trustServerCertificate: process.env.MSSQL_TRUST_CERT === 'true',
    enableArithAbort:       true,
  },
  pool: {
    max:               20,
    min:               0,
    idleTimeoutMillis: 30_000,
  },
  connectionTimeout: 15_000,
  requestTimeout:    30_000,
}

let poolPromise = null

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .catch((err) => {
        // Reset so the next call tries again
        poolPromise = null
        throw err
      })
    poolPromise.then((p) => {
      p.on('error', (err) => console.error('[db] pool error:', err.message))
    })
  }
  return poolPromise
}

/**
 * Convert Postgres positional placeholders ($1, $2) to MSSQL named parameters (@p1, @p2).
 * Avoids replacing inside string literals by scanning for `'…'`.
 */
function convertPlaceholders(text) {
  let out = ''
  let i   = 0
  let inStr = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      inStr = !inStr
      out += ch
      i++
      continue
    }
    if (!inStr && ch === '$' && /\d/.test(text[i + 1])) {
      let n = ''
      i++
      while (i < text.length && /\d/.test(text[i])) {
        n += text[i++]
      }
      out += '@p' + n
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Bind a JS value to an mssql Request using a best-guess type.
 * Most columns work with the automatic mapping, but we force some common ones
 * to avoid `mssql` picking NVarChar for integers etc.
 */
function bindParam(request, name, value) {
  if (value === null || value === undefined) {
    request.input(name, sql.NVarChar, null)
    return
  }
  if (value instanceof Date) {
    request.input(name, sql.DateTime2, value)
    return
  }
  if (typeof value === 'boolean') {
    request.input(name, sql.Bit, value ? 1 : 0)
    return
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      request.input(name, sql.Int, value)
    } else {
      request.input(name, sql.Float, value)
    }
    return
  }
  if (Array.isArray(value) || typeof value === 'object') {
    // Caller should JSON.stringify before passing; fallback here for safety
    request.input(name, sql.NVarChar, JSON.stringify(value))
    return
  }
  // Default: treat as NVarChar
  request.input(name, sql.NVarChar, String(value))
}

/**
 * Run a parameterised query. Accepts `$1, $2, ...` Postgres-style placeholders.
 * Returns `{ rows, rowCount }`.
 */
async function query(text, params = []) {
  const pool       = await getPool()
  const request    = pool.request()
  const converted  = convertPlaceholders(text)

  params.forEach((value, i) => bindParam(request, `p${i + 1}`, value))

  const start = Date.now()
  const result = await request.query(converted)
  const duration = Date.now() - start
  if (duration > 1000) {
    console.warn(`[db] slow query (${duration}ms):`, converted.slice(0, 140))
  }

  return {
    rows:     result.recordset || [],
    rowCount: result.rowsAffected?.[0] ?? (result.recordset?.length ?? 0),
  }
}

/**
 * Returns an mssql Request (pre-connected) for advanced use cases
 * where the wrapper isn't enough.
 */
async function getRequest() {
  const pool = await getPool()
  return pool.request()
}

/**
 * Run a callback inside a transaction. The callback gets a `txQuery(text, params)`
 * function that behaves like `query` but uses the open transaction.
 */
async function withTransaction(fn) {
  const pool = await getPool()
  const tx   = new sql.Transaction(pool)
  await tx.begin()
  try {
    const txQuery = async (text, params = []) => {
      const request   = new sql.Request(tx)
      const converted = convertPlaceholders(text)
      params.forEach((value, i) => bindParam(request, `p${i + 1}`, value))
      const result = await request.query(converted)
      return {
        rows:     result.recordset || [],
        rowCount: result.rowsAffected?.[0] ?? (result.recordset?.length ?? 0),
      }
    }

    const out = await fn(txQuery)
    await tx.commit()
    return out
  } catch (err) {
    try { await tx.rollback() } catch { /* ignore rollback errors */ }
    throw err
  }
}

module.exports = {
  sql,
  getPool,
  query,
  getRequest,
  withTransaction,
}
