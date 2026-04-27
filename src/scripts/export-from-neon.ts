/**
 * One-time data export from the legacy Neon Postgres database to a JSON dump.
 * The companion import is `import-to-mssql.ts` (write when ready to cut over).
 *
 * Usage:
 *   NEON_DATABASE_URL=postgresql://user:pwd@host/db npm run export:neon
 *
 * Output: ./neon-export-<timestamp>.json
 *   {
 *     exportedAt: ISO8601,
 *     source:     'neon',
 *     tables:     { users: [...], events: [...], event_attendees: [...], ... }
 *   }
 *
 * The script intentionally has no other repo dependencies — `pg` is required
 * dynamically so it does not need to live in package.json after Phase 0.
 * Install once with `npm install --no-save pg @types/pg` before running.
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'

interface PgPool {
  query<T = unknown>(text: string): Promise<{ rows: T[] }>
  end(): Promise<void>
}

// Tables to copy out of Neon. Order is informational; the import phase will
// re-order based on FK dependencies.
const TABLES = [
  'departments',
  'users',
  'events',
  'event_attendees',
  'mom_sessions',
  'mom_items',
  'mom_item_comments',
  'mom_activity',
  'webhook_settings',
  'conference_rooms',
  // Trello tables intentionally excluded — Karya is decoupled from Trello in Phase 0.
] as const

async function main(): Promise<void> {
  const url = process.env.NEON_DATABASE_URL
  if (!url) {
    console.error('Set NEON_DATABASE_URL to the source Postgres connection string.')
    process.exit(1)
  }

  let Pool: new (cfg: { connectionString: string }) => PgPool
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    Pool = (require('pg') as any).Pool
  } catch {
    console.error('`pg` is not installed. Run: npm install --no-save pg @types/pg')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: url })
  const out: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    source:     'neon',
    tables:     {},
  }
  const tables = out.tables as Record<string, unknown[]>

  for (const t of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${t}`)
      tables[t] = rows
      console.log(`  ${t.padEnd(22)} ${rows.length} rows`)
    } catch (err) {
      console.warn(`  ${t.padEnd(22)} skipped (${(err as Error).message})`)
    }
  }
  await pool.end()

  const outPath = path.resolve(process.cwd(), `neon-export-${Date.now()}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')
  console.log(`\nWrote ${outPath}`)
  console.log('Next step: write import-to-mssql.ts to load this dump into the new MSSQL DB.')
}

main().catch(err => {
  console.error('export failed:', (err as Error).message)
  process.exit(1)
})
