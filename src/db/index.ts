import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set')
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 20_000,
})

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message)
})

/**
 * Run a single parameterised query from the pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now()
  const result = await pool.query<T>(text, params)
  const duration = Date.now() - start
  if (duration > 1000) {
    console.warn(`[db] Slow query (${duration}ms):`, text.slice(0, 120))
  }
  return result
}

/**
 * Acquire a client for multi-statement transactions.
 *
 * @example
 * const client = await getClient()
 * try {
 *   await client.query('BEGIN')
 *   // ... your queries ...
 *   await client.query('COMMIT')
 * } catch (err) {
 *   await client.query('ROLLBACK')
 *   throw err
 * } finally {
 *   client.release()
 * }
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect()
}

/**
 * Convenience wrapper: run a callback inside a transaction.
 * Automatically commits on success and rolls back on error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
