// Re-export from the canonical db module so existing route imports keep working.
export { pool, pool as db, query, getClient, withTransaction } from './db/index'
