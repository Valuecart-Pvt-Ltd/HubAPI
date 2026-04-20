/**
 * migrate.ts — run schema.sql against the configured DATABASE_URL.
 *
 * Usage:
 *   npx ts-node src/db/migrate.ts
 *   # or after build:
 *   node dist/db/migrate.js
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'

async function migrate(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL is not set in environment.')
    process.exit(1)
  }

  const schemaPath = path.resolve(__dirname, 'schema.sql')

  if (!fs.existsSync(schemaPath)) {
    console.error(`Error: schema file not found at ${schemaPath}`)
    process.exit(1)
  }

  const sql = fs.readFileSync(schemaPath, 'utf8')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  console.log('Connecting to database…')

  const client = await pool.connect()
  try {
    console.log('Running migrations…')
    await client.query(sql)
    console.log('Migration completed successfully.')
  } catch (err) {
    console.error('Migration failed:', (err as Error).message)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()
