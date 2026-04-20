import axios from 'axios'
import { query, withTransaction } from '../db'
import type { PoolClient } from 'pg'

const COMPANY_DOMAIN  = process.env.COMPANY_DOMAIN ?? 'valuecart.com'
const SYNC_WINDOW_DAYS = 90
const GRAPH_BASE       = 'https://graph.microsoft.com/v1.0'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserTokenRow {
  id:                      string
  email:                   string
  microsoft_access_token:  string
  microsoft_refresh_token: string
  microsoft_token_expiry:  Date | null
}

interface GraphEvent {
  id:       string
  subject:  string | null
  bodyPreview: string | null
  start:    { dateTime: string; timeZone: string }
  end:      { dateTime: string; timeZone: string }
  organizer?: { emailAddress: { address: string; name: string } }
  attendees?: {
    emailAddress: { address: string; name: string }
    status: { response: string }
  }[]
}

// ─── Token refresh helper ─────────────────────────────────────────────────────

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID!,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    scope:         'openid profile email offline_access Calendars.Read',
  })

  const { data } = await axios.post(
    `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  )

  await query(
    `UPDATE users
     SET microsoft_access_token = $1,
         microsoft_token_expiry = $2
     WHERE id = $3`,
    [
      data.access_token,
      data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
      userId,
    ],
  )

  return data.access_token
}

// ─── Fetch all calendar events from Graph API ─────────────────────────────────

async function fetchGraphEvents(accessToken: string): Promise<GraphEvent[]> {
  const now     = new Date()
  const end     = new Date(now.getTime() + SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const events: GraphEvent[] = []
  let url: string | null =
    `${GRAPH_BASE}/me/calendarView` +
    `?startDateTime=${now.toISOString()}` +
    `&endDateTime=${end.toISOString()}` +
    `&$select=id,subject,bodyPreview,start,end,organizer,attendees` +
    `&$top=100`

  while (url) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    events.push(...(data.value ?? []))
    url = data['@odata.nextLink'] ?? null
  }

  return events
}

// ─── DB upsert helpers ────────────────────────────────────────────────────────

async function upsertOutlookEvent(
  client: PoolClient,
  ev: GraphEvent,
  organizerEmail: string,
  isExternal: boolean,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO events
       (outlook_event_id, title, description, start_time, end_time,
        organizer_email, is_external)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (outlook_event_id) DO UPDATE SET
       title           = EXCLUDED.title,
       description     = EXCLUDED.description,
       start_time      = EXCLUDED.start_time,
       end_time        = EXCLUDED.end_time,
       is_external     = EXCLUDED.is_external
     RETURNING id`,
    [
      ev.id,
      ev.subject ?? '(No title)',
      ev.bodyPreview ?? null,
      ev.start.dateTime,
      ev.end.dateTime,
      organizerEmail,
      isExternal,
    ],
  )
  return rows[0].id
}

async function upsertAttendees(
  client: PoolClient,
  eventId: string,
  attendees: GraphEvent['attendees'],
): Promise<void> {
  if (!attendees?.length) return

  const emails = attendees.map((a) => a.emailAddress.address).filter(Boolean)
  const { rows: userRows } = await client.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = ANY($1::text[])`,
    [emails],
  )
  const emailToUserId = new Map(userRows.map((r) => [r.email, r.id]))

  for (const attendee of attendees) {
    const email = attendee.emailAddress.address
    if (!email) continue
    const responseStatus = mapResponseStatus(attendee.status?.response)
    await client.query(
      `INSERT INTO event_attendees (event_id, user_id, email, response_status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, email) DO UPDATE SET
         user_id         = COALESCE(EXCLUDED.user_id, event_attendees.user_id),
         response_status = EXCLUDED.response_status`,
      [eventId, emailToUserId.get(email) ?? null, email, responseStatus],
    )
  }
}

function mapResponseStatus(response?: string): string {
  switch (response) {
    case 'accepted':  return 'accepted'
    case 'declined':  return 'declined'
    case 'tentativelyAccepted': return 'tentative'
    default: return 'needsAction'
  }
}

// ─── Main sync function ───────────────────────────────────────────────────────

export async function fetchOutlookEvents(userId: string): Promise<number> {
  const { rows } = await query<UserTokenRow>(
    `SELECT id, email, microsoft_access_token, microsoft_refresh_token, microsoft_token_expiry
     FROM users
     WHERE id = $1
       AND microsoft_access_token  IS NOT NULL
       AND microsoft_refresh_token IS NOT NULL`,
    [userId],
  )

  const user = rows[0]
  if (!user) {
    console.log(`[outlook] User ${userId} has no Microsoft tokens — skipping`)
    return 0
  }

  // Refresh token if expired or about to expire
  let accessToken = user.microsoft_access_token
  const expiry = user.microsoft_token_expiry
  if (!expiry || expiry.getTime() - Date.now() < 5 * 60 * 1000) {
    try {
      accessToken = await refreshAccessToken(userId, user.microsoft_refresh_token)
    } catch (err) {
      console.error(`[outlook] Token refresh failed for user ${userId}:`, (err as Error).message)
      return 0
    }
  }

  const graphEvents = await fetchGraphEvents(accessToken)
  if (graphEvents.length === 0) return 0

  let syncCount = 0

  for (const ev of graphEvents) {
    if (!ev.id || !ev.start) continue

    const organizerEmail = ev.organizer?.emailAddress?.address ?? user.email
    const attendees      = ev.attendees ?? []
    const isExternal     = attendees.some(
      (a) => a.emailAddress.address && !a.emailAddress.address.endsWith(`@${COMPANY_DOMAIN}`),
    )

    try {
      await withTransaction(async (client) => {
        const eventId = await upsertOutlookEvent(client, ev, organizerEmail, isExternal)
        await upsertAttendees(client, eventId, attendees)
      })
      syncCount++
    } catch (err) {
      console.error(
        `[outlook] Failed to upsert event ${ev.id} for user ${userId}:`,
        (err as Error).message,
      )
    }
  }

  console.log(`[outlook] Synced ${syncCount}/${graphEvents.length} events for user ${userId}`)
  return syncCount
}
