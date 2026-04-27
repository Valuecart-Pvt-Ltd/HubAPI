// MSSQL connection pool + helper API.
//
// Exposes a thin layer over the `mssql` package so callers can either:
//   - call a stored procedure   →  execSP('usp_GetUserByEmail', { Email: { type: sql.NVarChar, value: 'a@b' } })
//   - run a parameterised query →  query('SELECT * FROM users WHERE id = @id', { id: { type: sql.UniqueIdentifier, value: id } })
//   - run a transaction         →  withTransaction(async tx => { ... })
//
// Connection settings come from these env vars (all required):
//   DB_SERVER, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
// Optional:
//   DB_ENCRYPT (default 'true'), DB_TRUST_CERT (default 'true'), DB_POOL_MAX (default 20)

import sql, { ConnectionPool, IResult, Transaction, ISqlType } from 'mssql'

const requireEnv = (k: string): string => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} environment variable is not set`)
  return v
}

const config: sql.config = {
  server:   requireEnv('DB_SERVER'),
  port:     parseInt(process.env.DB_PORT ?? '1433', 10),
  user:     requireEnv('DB_USER'),
  password: requireEnv('DB_PASSWORD'),
  database: requireEnv('DB_NAME'),
  options: {
    encrypt:                process.env.DB_ENCRYPT     !== 'false',
    trustServerCertificate: process.env.DB_TRUST_CERT  !== 'false',
    enableArithAbort:       true,
  },
  pool: {
    max:               parseInt(process.env.DB_POOL_MAX ?? '20', 10),
    min:               0,
    idleTimeoutMillis: 30_000,
  },
  connectionTimeout: 20_000,
  requestTimeout:    20_000,
}

// Lazy singleton: connection happens on first request, then cached.
let pool: ConnectionPool | null = null
let connecting: Promise<ConnectionPool> | null = null

export function getPool(): Promise<ConnectionPool> {
  if (pool && pool.connected) return Promise.resolve(pool)
  if (connecting) return connecting
  const p = new sql.ConnectionPool(config)
  p.on('error', err => console.error('[db] pool error:', err.message))
  connecting = p.connect()
    .then(connected => { pool = connected; return connected })
    .catch(err => { connecting = null; throw err })
  return connecting
}

// Param shape used by execSP/query: either a plain value, or {type, value} pair.
export type ParamValue =
  | { type?: (() => ISqlType) | ISqlType, value: unknown }
  | unknown

function bindParams(req: sql.Request, params: Record<string, ParamValue>) {
  for (const [k, raw] of Object.entries(params)) {
    if (raw && typeof raw === 'object' && 'value' in (raw as object)) {
      const tv = raw as { type?: (() => ISqlType) | ISqlType, value: unknown }
      if (tv.type) req.input(k, tv.type as ISqlType, tv.value)
      else         req.input(k, tv.value)
    } else {
      req.input(k, raw)
    }
  }
}

/**
 * Call a stored procedure by name. Returns the first recordset.
 * For SPs with multiple recordsets, use execSPMulti.
 */
export async function execSP<T = Record<string, unknown>>(
  name:   string,
  params: Record<string, ParamValue> = {},
): Promise<T[]> {
  const p   = await getPool()
  const req = p.request()
  bindParams(req, params)
  const start = Date.now()
  const result = await req.execute<T>(name)
  const dur = Date.now() - start
  if (dur > 1000) console.warn(`[db] Slow SP ${name} (${dur}ms)`)
  return result.recordset ?? []
}

/**
 * Call a stored procedure that returns multiple recordsets.
 */
export async function execSPMulti<T = unknown>(
  name:   string,
  params: Record<string, ParamValue> = {},
): Promise<IResult<T>> {
  const p   = await getPool()
  const req = p.request()
  bindParams(req, params)
  return req.execute<T>(name)
}

/**
 * Run a parameterised T-SQL query. Use named placeholders (`@id`) — never string-concatenate values.
 */
export async function query<T = Record<string, unknown>>(
  text:   string,
  params: Record<string, ParamValue> = {},
): Promise<T[]> {
  const p   = await getPool()
  const req = p.request()
  bindParams(req, params)
  const start = Date.now()
  const result = await req.query<T>(text)
  const dur = Date.now() - start
  if (dur > 1000) console.warn(`[db] Slow query (${dur}ms):`, text.slice(0, 120))
  return result.recordset ?? []
}

/**
 * Run a callback inside a transaction. Auto-commits on success, rolls back on throw.
 *
 * @example
 * await withTransaction(async tx => {
 *   await new sql.Request(tx).input('id', sql.UniqueIdentifier, id).query('UPDATE users SET ...')
 * })
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const p  = await getPool()
  const tx = new sql.Transaction(p)
  await tx.begin()
  try {
    const result = await fn(tx)
    await tx.commit()
    return result
  } catch (err) {
    try { await tx.rollback() } catch { /* swallow */ }
    throw err
  }
}

// Re-export the sql namespace so callers can use `sql.NVarChar`, `sql.UniqueIdentifier`, etc.
export { sql }
