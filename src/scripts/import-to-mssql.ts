/**
 * Companion to export-from-neon.ts. Loads the JSON dump into the new MSSQL
 * database. Idempotent on primary keys — safe to run multiple times during a
 * cutover dress-rehearsal.
 *
 * Usage:
 *   npm run migrate                      # ensure schema exists first
 *   ts-node src/scripts/import-to-mssql.ts neon-export-1729870000000.json
 *
 * Tables are loaded in FK-dependency order. Each row is upserted via MERGE
 * so re-running won't duplicate. Trello-related rows from the legacy export
 * are intentionally skipped — Phase 0 removed Trello.
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import sql from 'mssql'

interface ExportFile {
  exportedAt: string
  source:     string
  tables:     Record<string, Record<string, unknown>[]>
}

// FK-dependency order. Comment out tables that aren't in your dump.
const ORDER: { name: string, key: string }[] = [
  { name: 'departments',        key: 'id'    },
  { name: 'users',              key: 'id'    },
  { name: 'conference_rooms',   key: 'email' },
  { name: 'events',             key: 'id'    },
  { name: 'event_attendees',    key: 'id'    },
  { name: 'mom_sessions',       key: 'id'    },
  { name: 'mom_items',          key: 'id'    },
  { name: 'mom_item_comments',  key: 'id'    },
  { name: 'mom_activity',       key: 'id'    },
  { name: 'webhook_settings',   key: 'id'    },
]

function isoToDate(v: unknown): unknown {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v)
  return v
}

async function importTable(
  pool:  sql.ConnectionPool,
  table: string,
  key:   string,
  rows:  Record<string, unknown>[],
): Promise<{ inserted: number, updated: number, skipped: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 }

  // Discover the column names from the first row + intersect with existing
  // table columns so we silently skip Trello-era columns the new schema dropped.
  const sample = rows[0]
  const cols = Object.keys(sample)
    .filter(c => !c.startsWith('trello_'))           // schema dropped these
    .filter(c => sample[c] !== undefined)

  // Verify all `cols` exist in the destination — drop any that don't.
  const meta = await pool.request().query<{ name: string }>(
    `SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t)`)
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  meta  // ts-warn shim; we re-issue per-table below

  const dest = await pool.request()
    .input('t', sql.NVarChar, table)
    .query<{ name: string }>(
      'SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t)')
  const destCols = new Set(dest.recordset.map(r => r.name))
  const validCols = cols.filter(c => destCols.has(c))

  let inserted = 0, updated = 0, skipped = 0

  for (const row of rows) {
    if (row[key] == null) { skipped++; continue }

    // Build a parameterised MERGE on the @key column.
    const setClause   = validCols
      .filter(c => c !== key)
      .map(c => `${c} = src.${c}`)
      .join(', ')
    const insertCols  = validCols.join(', ')
    const insertVals  = validCols.map(c => `src.${c}`).join(', ')
    const usingValues = validCols.map(c => `@${c}`).join(', ')

    const merge = `
      MERGE ${table} AS target
      USING (SELECT ${usingValues}) AS src (${insertCols})
        ON target.${key} = src.${key}
      WHEN MATCHED THEN UPDATE SET ${setClause}
      WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})
      OUTPUT $action AS act;`

    const req = pool.request()
    for (const c of validCols) {
      req.input(c, isoToDate(row[c]))
    }
    try {
      const r = await req.query<{ act: 'INSERT' | 'UPDATE' }>(merge)
      const act = r.recordset[0]?.act
      if (act === 'INSERT')      inserted++
      else if (act === 'UPDATE') updated++
    } catch (err) {
      console.warn(`  [${table}] row ${row[key]}: ${(err as Error).message}`)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: ts-node src/scripts/import-to-mssql.ts <export-file>.json')
    process.exit(1)
  }
  const full = path.resolve(file)
  if (!fs.existsSync(full)) {
    console.error(`Export file not found: ${full}`)
    process.exit(1)
  }

  const dump = JSON.parse(fs.readFileSync(full, 'utf8')) as ExportFile
  console.log(`Loading ${full}`)
  console.log(`  exported ${dump.exportedAt} from ${dump.source}`)
  console.log(`  tables: ${Object.keys(dump.tables).join(', ')}`)

  const required = (k: string): string => {
    const v = process.env[k]
    if (!v) { console.error(`Missing env: ${k}`); process.exit(1) }
    return v
  }

  const pool = await new sql.ConnectionPool({
    server:   required('DB_SERVER'),
    port:     parseInt(process.env.DB_PORT ?? '1433', 10),
    user:     required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    options: {
      encrypt:                process.env.DB_ENCRYPT    !== 'false',
      trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
    },
    connectionTimeout: 30_000,
    requestTimeout:    60_000,
  }).connect()

  let totalIns = 0, totalUpd = 0, totalSkp = 0
  for (const { name, key } of ORDER) {
    const rows = dump.tables[name]
    if (!rows) {
      console.log(`  ${name.padEnd(22)} (no rows in dump)`)
      continue
    }
    const r = await importTable(pool, name, key, rows)
    console.log(`  ${name.padEnd(22)} ${rows.length} rows → ${r.inserted} inserted, ${r.updated} updated, ${r.skipped} skipped`)
    totalIns += r.inserted; totalUpd += r.updated; totalSkp += r.skipped
  }

  await pool.close()
  console.log(`\nDone. ${totalIns} inserted, ${totalUpd} updated, ${totalSkp} skipped.`)
}

main().catch(err => {
  console.error('import failed:', (err as Error).message)
  process.exit(1)
})
