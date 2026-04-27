/**
 * migrate.ts — apply MSSQL schema + stored procedures to the configured database.
 *
 * Runs (in order):
 *   1. mssql/01_tables.sql           — idempotent CREATE TABLE / CREATE INDEX
 *   2. mssql/02_stored_procedures.sql — CREATE OR ALTER PROCEDURE definitions
 *
 * Both files use `GO` batch separators (T-SQL convention). The `mssql` Node
 * package does not handle `GO` natively, so we split on `^GO$` lines before
 * executing each batch.
 *
 * Usage:
 *   npm run migrate           # ts-node
 *   npm run migrate:prod      # compiled JS in dist/
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import sql from 'mssql'

const FILES = ['mssql/01_tables.sql', 'mssql/02_stored_procedures.sql']

function splitOnGo(text: string): string[] {
  // Strip BOM, normalise line endings, then split on standalone `GO` (case-insensitive).
  const cleaned = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  return cleaned
    .split(/^\s*GO\s*$/im)
    .map(b => b.trim())
    .filter(Boolean)
}

async function migrate(): Promise<void> {
  const requireEnv = (k: string): string => {
    const v = process.env[k]
    if (!v) { console.error(`Error: ${k} is not set`); process.exit(1) }
    return v
  }

  const config: sql.config = {
    server:   requireEnv('DB_SERVER'),
    port:     parseInt(process.env.DB_PORT ?? '1433', 10),
    user:     requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    options: {
      encrypt:                process.env.DB_ENCRYPT    !== 'false',
      trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
      enableArithAbort:       true,
    },
    connectionTimeout: 30_000,
    requestTimeout:    60_000,
  }

  console.log(`[migrate] connecting to ${config.server}:${config.port}/${config.database} as ${config.user}…`)
  const pool = await new sql.ConnectionPool(config).connect()

  try {
    for (const rel of FILES) {
      const full = path.resolve(__dirname, rel)
      if (!fs.existsSync(full)) {
        console.error(`[migrate] missing file: ${full}`)
        process.exit(1)
      }
      const text    = fs.readFileSync(full, 'utf8')
      const batches = splitOnGo(text)
      console.log(`[migrate] ${rel} — ${batches.length} batches`)

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        try {
          await pool.request().batch(batch)
        } catch (err) {
          console.error(`[migrate] batch ${i + 1}/${batches.length} of ${rel} failed`)
          console.error(`           first 200 chars:\n${batch.slice(0, 200)}`)
          throw err
        }
      }
    }
    console.log('[migrate] OK — schema and stored procedures up to date')
  } finally {
    await pool.close()
  }
}

migrate().catch(err => {
  console.error('[migrate] FAIL:', (err as Error).message)
  process.exit(1)
})
