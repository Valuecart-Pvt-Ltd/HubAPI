/**
 * Seed script — populates the database with sample data for development.
 *
 * Usage:
 *   npm run seed
 *   # or directly:
 *   npx ts-node src/scripts/seed.ts
 *
 * WARNING: clears all existing data before inserting samples.
 */

import 'dotenv/config'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// ─── Sample data ──────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  { name: 'Engineering',  description: 'Product engineering and platform' },
  { name: 'Marketing',    description: 'Growth, content, and brand'       },
  { name: 'Sales',        description: 'Revenue and partnerships'         },
]

const USERS = [
  { name: 'Alice Chen',     email: 'alice@valuecart.com',   department: 'Engineering', password: 'password123' },
  { name: 'Bob Nguyen',     email: 'bob@valuecart.com',     department: 'Engineering', password: 'password123' },
  { name: 'Carol Smith',    email: 'carol@valuecart.com',   department: 'Marketing',   password: 'password123' },
  { name: 'Dave Patel',     email: 'dave@valuecart.com',    department: 'Marketing',   password: 'password123' },
  { name: 'Eve Johnson',    email: 'eve@valuecart.com',     department: 'Sales',       password: 'password123' },
]

const now = new Date()
const d = (offsetDays: number, hour = 10, minute = 0) => {
  const dt = new Date(now)
  dt.setDate(dt.getDate() + offsetDays)
  dt.setHours(hour, minute, 0, 0)
  return dt.toISOString()
}

const EVENTS = [
  {
    title:          'Q3 Planning — Engineering',
    description:    'Quarterly planning session for the engineering team.',
    start_time:     d(-14, 10, 0),
    end_time:       d(-14, 11, 30),
    organizer:      'alice@valuecart.com',
    attendees:      ['alice@valuecart.com', 'bob@valuecart.com', 'carol@valuecart.com'],
    is_external:    false,
  },
  {
    title:          'Marketing Sync — Weekly',
    description:    'Weekly marketing team standup and review.',
    start_time:     d(-7, 9, 0),
    end_time:       d(-7, 9, 30),
    organizer:      'carol@valuecart.com',
    attendees:      ['carol@valuecart.com', 'dave@valuecart.com', 'alice@valuecart.com'],
    is_external:    false,
  },
  {
    title:          'Partner Review — Acme Corp',
    description:    'Quarterly business review with Acme Corp partnership team.',
    start_time:     d(-3, 14, 0),
    end_time:       d(-3, 15, 0),
    organizer:      'eve@valuecart.com',
    attendees:      ['eve@valuecart.com', 'dave@valuecart.com', 'external.partner@acme.com'],
    is_external:    true,
  },
  {
    title:          'Sprint Retrospective — Sprint 22',
    description:    'End-of-sprint retrospective for the engineering team.',
    start_time:     d(1, 15, 0),
    end_time:       d(1, 16, 0),
    organizer:      'bob@valuecart.com',
    attendees:      ['bob@valuecart.com', 'alice@valuecart.com'],
    is_external:    false,
  },
]

// MOM sessions — for the first 2 events only
const MOMS: Array<{
  eventIndex: number
  status: 'draft' | 'final'
  items: Array<{
    category:    string
    action_item: string
    owner_email: string
    eta:         string
    status:      'pending' | 'in-progress' | 'completed'
  }>
}> = [
  {
    eventIndex: 0,
    status: 'final',
    items: [
      {
        category:    'Decision',
        action_item: 'Adopt TypeScript strict mode for all new services',
        owner_email: 'alice@valuecart.com',
        eta:         offsetDate(-7),
        status:      'completed',
      },
      {
        category:    'Action Item',
        action_item: 'Set up Grafana dashboards for API latency and error rates',
        owner_email: 'bob@valuecart.com',
        eta:         offsetDate(7),
        status:      'in-progress',
      },
      {
        category:    'Action Item',
        action_item: 'Write ADR for choosing between GraphQL and REST for the new catalog service',
        owner_email: 'alice@valuecart.com',
        eta:         offsetDate(14),
        status:      'pending',
      },
      {
        category:    'Follow-up',
        action_item: 'Schedule capacity planning session with infra team for Q3 traffic projections',
        owner_email: 'bob@valuecart.com',
        eta:         offsetDate(3),
        status:      'pending',
      },
    ],
  },
  {
    eventIndex: 1,
    status: 'draft',
    items: [
      {
        category:    'Action Item',
        action_item: 'Create landing page for summer campaign — copy and images due by Friday',
        owner_email: 'carol@valuecart.com',
        eta:         offsetDate(5),
        status:      'in-progress',
      },
      {
        category:    'Decision',
        action_item: 'Pause paid search spending on brand terms until A/B test concludes',
        owner_email: 'dave@valuecart.com',
        eta:         offsetDate(1),
        status:      'completed',
      },
      {
        category:    'Follow-up',
        action_item: 'Share Q2 email performance report with leadership',
        owner_email: 'carol@valuecart.com',
        eta:         offsetDate(10),
        status:      'pending',
      },
    ],
  },
]

function offsetDate(days: number): string {
  const dt = new Date()
  dt.setDate(dt.getDate() + days)
  return dt.toISOString().split('T')[0]
}

// ─── Seed runner ──────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect()
  try {
    console.log('Starting seed…')

    await client.query('BEGIN')

    // Clear in dependency order
    await client.query(`
      TRUNCATE
        mom_activity_log,
        mom_items,
        mom_sessions,
        event_attendees,
        events,
        trello_mappings,
        user_departments,
        users,
        departments
      RESTART IDENTITY CASCADE
    `)

    // ── Departments ───────────────────────────────────────────────────────────
    const deptIds = new Map<string, string>()
    for (const dept of DEPARTMENTS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO departments (name, description) VALUES ($1, $2) RETURNING id`,
        [dept.name, dept.description],
      )
      deptIds.set(dept.name, rows[0].id)
      console.log(`  ✓ Department: ${dept.name}`)
    }

    // ── Users ─────────────────────────────────────────────────────────────────
    const userIds = new Map<string, string>()
    for (const user of USERS) {
      const hash = await bcrypt.hash(user.password, 10)
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, department)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.email, user.name, hash, user.department],
      )
      const userId = rows[0].id
      userIds.set(user.email, userId)

      // user_departments M2M
      const deptId = deptIds.get(user.department)
      if (deptId) {
        await client.query(
          `INSERT INTO user_departments (user_id, department_id) VALUES ($1, $2)`,
          [userId, deptId],
        )
      }
      console.log(`  ✓ User: ${user.name} <${user.email}>`)
    }

    // ── Events ────────────────────────────────────────────────────────────────
    const eventIds: string[] = []
    for (const ev of EVENTS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO events (title, description, start_time, end_time, organizer_email, is_external)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ev.title, ev.description, ev.start_time, ev.end_time, ev.organizer, ev.is_external],
      )
      const eventId = rows[0].id
      eventIds.push(eventId)

      for (const email of ev.attendees) {
        const attendeeUserId = userIds.get(email) ?? null
        await client.query(
          `INSERT INTO event_attendees (event_id, user_id, email, response_status)
           VALUES ($1, $2, $3, 'accepted')
           ON CONFLICT (event_id, email) DO NOTHING`,
          [eventId, attendeeUserId, email],
        )
      }
      console.log(`  ✓ Event: ${ev.title}`)
    }

    // ── MOM sessions + items ──────────────────────────────────────────────────
    for (const mom of MOMS) {
      const eventId     = eventIds[mom.eventIndex]
      const organizerEmail = EVENTS[mom.eventIndex].organizer
      const organizerId    = userIds.get(organizerEmail)!

      const { rows: sessionRows } = await client.query<{ id: string }>(
        `INSERT INTO mom_sessions (event_id, status, created_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [eventId, mom.status, organizerId],
      )
      const sessionId = sessionRows[0].id

      for (let i = 0; i < mom.items.length; i++) {
        const item = mom.items[i]
        await client.query(
          `INSERT INTO mom_items
             (mom_session_id, serial_number, category, action_item, owner_email, eta, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sessionId, i + 1, item.category, item.action_item, item.owner_email, item.eta, item.status],
        )
      }

      // Seed activity log
      await client.query(
        `INSERT INTO mom_activity_log (session_id, actor_email, event_type, details)
         VALUES ($1, $2, 'mom_created', $3)`,
        [sessionId, organizerEmail, JSON.stringify({ itemCount: mom.items.length })],
      )
      if (mom.status === 'final') {
        await client.query(
          `INSERT INTO mom_activity_log (session_id, actor_email, event_type, details)
           VALUES ($1, $2, 'mom_finalized', $3)`,
          [sessionId, organizerEmail, JSON.stringify({ itemCount: mom.items.length })],
        )
      }

      console.log(`  ✓ MOM (${mom.status}): ${EVENTS[mom.eventIndex].title} · ${mom.items.length} item(s)`)
    }

    await client.query('COMMIT')
    console.log('\n✅ Seed complete!')
    console.log('\nSample credentials (all share the same password: password123):')
    for (const u of USERS) {
      console.log(`  ${u.email}  (${u.department})`)
    }
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Seed failed:', err)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

seed()
