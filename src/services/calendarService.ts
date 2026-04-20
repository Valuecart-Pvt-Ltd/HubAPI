import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'
import cron from 'node-cron'
import { query, withTransaction } from '../db'
import { getBoardsByEmails } from './trelloService'
import { sendReminderEmail, type ReminderEmailItem } from './emailService'

// ─── Config ───────────────────────────────────────────────────────────────────

const COMPANY_DOMAIN = process.env.COMPANY_DOMAIN ?? 'valuecart.com'
const SYNC_WINDOW_DAYS = 90

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserTokenRow {
  id:                   string
  email:                string
  google_access_token:  string
  google_refresh_token: string
  google_token_expiry:  Date | null
}

// ─── OAuth2 helpers ───────────────────────────────────────────────────────────

function buildOAuthClient(userId: string, accessToken: string, refreshToken: string) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
  )

  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
  })

  // Persist refreshed access tokens so we don't re-auth on every request
  client.on('tokens', (tokens) => {
    if (!tokens.access_token) return
    query(
      `UPDATE users
       SET google_access_token = $1, google_token_expiry = $2
       WHERE id = $3`,
      [
        tokens.access_token,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        userId,
      ],
    ).catch((err) =>
      console.error(`[calendar] Failed to persist refreshed token for ${userId}:`, err.message),
    )
  })

  return client
}

// ─── Calendar fetching ────────────────────────────────────────────────────────

async function fetchAllCalendarEvents(
  calendarClient: calendar_v3.Calendar,
): Promise<calendar_v3.Schema$Event[]> {
  const now          = new Date()
  const windowEnd    = new Date(now.getTime() + SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const allEvents: calendar_v3.Schema$Event[] = []
  let pageToken: string | undefined

  do {
    const { data } = await calendarClient.events.list({
      calendarId:   'primary',
      timeMin:      now.toISOString(),
      timeMax:      windowEnd.toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
      maxResults:   250,
      pageToken,
    })
    allEvents.push(...(data.items ?? []))
    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)

  return allEvents
}

// ─── Main sync function ───────────────────────────────────────────────────────
//
// Performance: entire sync runs in ONE transaction with 4 bulk queries using
// unnest(), regardless of how many events/attendees are fetched.
// Previously: O(n) transactions + O(n×m) queries (n=events, m=attendees/event).
// Now:        1 transaction + 4 queries total.

export async function fetchUserEvents(userId: string): Promise<number> {
  const { rows } = await query<UserTokenRow>(
    `SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
     FROM users
     WHERE id = $1
       AND google_access_token  IS NOT NULL
       AND google_refresh_token IS NOT NULL`,
    [userId],
  )

  const user = rows[0]
  if (!user) {
    console.log(`[calendar] User ${userId} has no calendar tokens — skipping`)
    return 0
  }

  const oauthClient    = buildOAuthClient(userId, user.google_access_token, user.google_refresh_token)
  const calendarClient = google.calendar({ version: 'v3', auth: oauthClient })

  const calEvents = await fetchAllCalendarEvents(calendarClient)
  if (calEvents.length === 0) return 0

  // ── 1. Pre-fetch Trello board mappings (one external call for all organizers) ──
  const organizerEmails = [
    ...new Set(calEvents.map((e) => e.organizer?.email).filter((e): e is string => Boolean(e))),
  ]
  const trelloBoardMap = await getBoardsByEmails(organizerEmails)

  // ── 2. Build flat arrays for bulk upsert ──────────────────────────────────────
  interface EventRow {
    googleEventId:  string
    title:          string
    description:    string | null
    startTime:      string
    endTime:        string
    organizerEmail: string
    isExternal:     boolean
    trelloBoardId:  string | null
    trelloBoardName: string | null
  }

  const eventRows: EventRow[] = []
  for (const e of calEvents) {
    if (!e.id || !e.start) continue
    const organizerEmail = e.organizer?.email ?? user.email
    const board          = trelloBoardMap.get(organizerEmail) ?? null
    eventRows.push({
      googleEventId:  e.id,
      title:          e.summary ?? '(No title)',
      description:    e.description ?? null,
      startTime:      (e.start.dateTime ?? e.start.date)!,
      endTime:        (e.end?.dateTime  ?? e.end?.date)!,
      organizerEmail,
      isExternal:     (e.attendees ?? []).some(
        (a) => a.email && !a.email.endsWith(`@${COMPANY_DOMAIN}`),
      ),
      trelloBoardId:   board?.trelloBoardId   ?? null,
      trelloBoardName: board?.trelloBoardName ?? null,
    })
  }

  if (eventRows.length === 0) return 0

  let syncCount = 0

  await withTransaction(async (client) => {
    // ── Query 1: bulk-upsert all events ──────────────────────────────────────
    const { rows: upserted } = await client.query<{ id: string; google_event_id: string }>(
      `INSERT INTO events
         (google_event_id, title, description, start_time, end_time,
          organizer_email, is_external, trello_board_id, trello_board_name)
       SELECT
         google_event_id, title, description,
         start_time::timestamptz, end_time::timestamptz,
         organizer_email, is_external,
         trello_board_id, trello_board_name
       FROM unnest(
         $1::text[], $2::text[], $3::text[],
         $4::text[], $5::text[],
         $6::text[], $7::bool[],
         $8::text[], $9::text[]
       ) AS t(
         google_event_id, title, description,
         start_time, end_time,
         organizer_email, is_external,
         trello_board_id, trello_board_name
       )
       ON CONFLICT (google_event_id) DO UPDATE SET
         title             = EXCLUDED.title,
         description       = EXCLUDED.description,
         start_time        = EXCLUDED.start_time,
         end_time          = EXCLUDED.end_time,
         is_external       = EXCLUDED.is_external,
         trello_board_id   = COALESCE(EXCLUDED.trello_board_id,   events.trello_board_id),
         trello_board_name = COALESCE(EXCLUDED.trello_board_name, events.trello_board_name)
       RETURNING id, google_event_id`,
      [
        eventRows.map((r) => r.googleEventId),
        eventRows.map((r) => r.title),
        eventRows.map((r) => r.description),
        eventRows.map((r) => r.startTime),
        eventRows.map((r) => r.endTime),
        eventRows.map((r) => r.organizerEmail),
        eventRows.map((r) => r.isExternal),
        eventRows.map((r) => r.trelloBoardId),
        eventRows.map((r) => r.trelloBoardName),
      ],
    )

    syncCount = upserted.length
    const googleIdToDbId = new Map(upserted.map((r) => [r.google_event_id, r.id]))

    // ── Build attendee tuples across ALL events ───────────────────────────────
    const attEventIds:    string[] = []
    const attEmails:      string[] = []
    const attStatuses:    string[] = []

    for (const calEvent of calEvents) {
      if (!calEvent.id) continue
      const dbId = googleIdToDbId.get(calEvent.id)
      if (!dbId) continue
      for (const a of (calEvent.attendees ?? [])) {
        if (!a.email) continue
        attEventIds.push(dbId)
        attEmails.push(a.email)
        attStatuses.push(a.responseStatus ?? 'needsAction')
      }
    }

    if (attEmails.length > 0) {
      // ── Query 2: resolve all unique attendee emails → user IDs in one shot ──
      const uniqueEmails = [...new Set(attEmails)]
      const { rows: userRows } = await client.query<{ id: string; email: string }>(
        `SELECT id, email FROM users WHERE email = ANY($1::text[])`,
        [uniqueEmails],
      )
      const emailToUserId = new Map(userRows.map((r) => [r.email, r.id]))

      // ── Query 3: bulk-upsert all attendees ───────────────────────────────────
      await client.query(
        `INSERT INTO event_attendees (event_id, user_id, email, response_status)
         SELECT event_id::uuid, user_id::uuid, email, response_status
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(
           event_id, user_id, email, response_status
         )
         ON CONFLICT (event_id, email) DO UPDATE SET
           user_id         = COALESCE(EXCLUDED.user_id, event_attendees.user_id),
           response_status = EXCLUDED.response_status`,
        [
          attEventIds,
          attEmails.map((e) => emailToUserId.get(e) ?? null),
          attEmails,
          attStatuses,
        ],
      )
    }
  })

  console.log(`[calendar] Synced ${syncCount}/${calEvents.length} events for user ${userId}`)
  return syncCount
}

// ─── Room resource fetcher ────────────────────────────────────────────────────
//
// Returns Google Calendar resource (room) calendars visible to the user.
// Resource IDs in Google Workspace match *.resource.calendar.google.com,
// or appear in calendarList with a description that mentions "room" / "conference".

export interface RoomResource {
  id:          string   // calendar ID == booking email
  name:        string
  description: string
}

export async function fetchUserRooms(userId: string): Promise<RoomResource[]> {
  // ── 1. Load rooms saved in the DB (primary source) ───────────────────────
  const { rows: dbRooms } = await query<{
    id: string; name: string; email: string; description: string
  }>(
    `SELECT id, name, email, description FROM conference_rooms ORDER BY name`,
  )

  const dbEmails = new Set(dbRooms.map((r) => r.email.toLowerCase()))

  const result: RoomResource[] = dbRooms.map((r) => ({
    id:          r.email,   // calendar ID = booking email
    name:        r.name,
    description: r.description,
  }))

  // ── 2. Supplement with Google Calendar resource calendars the user has ────
  //     subscribed to (rooms the admin shared with them).
  //     These are merged in de-duplicating against DB rows.
  try {
    const { rows } = await query<UserTokenRow>(
      `SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
       FROM users
       WHERE id = $1
         AND google_access_token  IS NOT NULL
         AND google_refresh_token IS NOT NULL`,
      [userId],
    )
    if (rows[0]) {
      const oauthClient    = buildOAuthClient(userId, rows[0].google_access_token, rows[0].google_refresh_token)
      const calendarClient = google.calendar({ version: 'v3', auth: oauthClient })

      const { data } = await calendarClient.calendarList.list({
        minAccessRole: 'freeBusyReader',
        maxResults:    250,
      })

      for (const cal of (data.items ?? [])) {
        const id   = (cal.id   ?? '').toLowerCase()
        const desc = (cal.description ?? '').toLowerCase()
        const name = (cal.summary     ?? '').toLowerCase()

        const isResource =
          id.includes('resource.calendar.google.com') ||
          desc.includes('room')  || desc.includes('conference') ||
          desc.includes('board') || name.includes('room') ||
          name.includes('conference room') || name.includes('boardroom')

        if (isResource && cal.id && !dbEmails.has(cal.id.toLowerCase())) {
          result.push({
            id:          cal.id,
            name:        cal.summary     ?? cal.id,
            description: cal.description ?? '',
          })
        }
      }
    }
  } catch (err) {
    console.warn('[calendar] calendarList rooms fetch failed (non-fatal):', (err as Error).message)
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

// ─── Google Meet link generator ───────────────────────────────────────────────
//
// Creates a minimal event in the user's Google Calendar with conferenceData,
// reads the Meet link from the response, then immediately deletes the temp event.
// The Meet link remains valid after the event is deleted.

export async function generateMeetLink(userId: string): Promise<string | null> {
  const { rows } = await query<UserTokenRow>(
    `SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
     FROM users
     WHERE id = $1
       AND google_access_token  IS NOT NULL
       AND google_refresh_token IS NOT NULL`,
    [userId],
  )
  if (!rows[0]) {
    console.warn('[calendar] generateMeetLink: no Google tokens for user', userId)
    return null
  }

  const oauthClient    = buildOAuthClient(userId, rows[0].google_access_token, rows[0].google_refresh_token)
  const calendarClient = google.calendar({ version: 'v3', auth: oauthClient })

  // Create a minimal temp event purely to obtain a Meet conference link
  const now    = new Date()
  const later  = new Date(now.getTime() + 60 * 60 * 1000)

  const { data: created } = await calendarClient.events.insert({
    calendarId:            'primary',
    conferenceDataVersion: 1,
    requestBody: {
      summary: '__karya_temp_meet__',
      start:   { dateTime: now.toISOString()   },
      end:     { dateTime: later.toISOString() },
      conferenceData: {
        createRequest: {
          requestId:            `karya-meet-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  })

  console.log('[calendar] Meet event created, conferenceData status:',
    created.conferenceData?.createRequest?.status ?? 'no createRequest')

  // Google sometimes returns conferenceData in a "pending" state — poll until ready
  let meetLink: string | null = created.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === 'video',
  )?.uri ?? null

  if (!meetLink && created.id) {
    // Poll up to 4 times (each 1 s apart) waiting for Google to provision the link
    for (let attempt = 1; attempt <= 4 && !meetLink; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      const { data: polled } = await calendarClient.events.get({
        calendarId: 'primary',
        eventId:    created.id,
      }).catch(() => ({ data: null }))

      meetLink = polled?.conferenceData?.entryPoints?.find(
        (ep) => ep.entryPointType === 'video',
      )?.uri ?? null

      console.log(`[calendar] Meet link poll attempt ${attempt}:`, meetLink ?? 'still pending')
    }
  }

  // Delete the temp calendar event — the Meet link stays active after deletion
  if (created.id) {
    await calendarClient.events.delete({
      calendarId: 'primary',
      eventId:    created.id,
    }).catch((err: Error) =>
      console.warn('[calendar] Failed to delete temp Meet event (non-fatal):', err.message),
    )
  }

  if (!meetLink) {
    console.error('[calendar] generateMeetLink: could not obtain Meet URL after polling')
  }

  return meetLink
}

// ─── Cron scheduler ───────────────────────────────────────────────────────────

export function startCalendarSyncCron(): void {
  // Run every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[calendar] Starting scheduled sync for all active users...')

    const { rows } = await query<{ id: string }>(
      `SELECT id FROM users
       WHERE google_refresh_token IS NOT NULL`,
    ).catch((err) => {
      console.error('[calendar] Failed to fetch users for sync:', err.message)
      return { rows: [] }
    })

    let ok = 0, fail = 0
    for (const user of rows) {
      try {
        await fetchUserEvents(user.id)
        ok++
      } catch (err) {
        fail++
        console.error(
          `[calendar] Sync error for user ${user.id}:`,
          (err as Error).message,
        )
      }
    }

    console.log(`[calendar] Scheduled sync complete — ${ok} ok, ${fail} failed`)
  })

  console.log('[calendar] Cron job registered (every 30 minutes)')

  // Run daily at 08:00 to send 2-day meeting reminders
  cron.schedule('0 8 * * *', async () => {
    console.log('[reminder] Checking for upcoming meetings to remind...')
    await sendUpcomingMeetingReminders().catch((err) =>
      console.error('[reminder] Cron error:', (err as Error).message),
    )
  })

  console.log('[calendar] Reminder cron job registered (daily at 08:00)')
}

// ─── Reminder sender ──────────────────────────────────────────────────────────

async function sendUpcomingMeetingReminders(): Promise<void> {
  // Find events starting in the 2-day window (between 48h and 72h from now)
  // that haven't had a reminder sent yet.
  const { rows: events } = await query<{
    id:              string
    title:           string
    start_time:      Date
    end_time:        Date
    organizer_email: string
    attendees:       { email: string; name: string }[]
  }>(`
    SELECT
      e.id,
      e.title,
      e.start_time,
      e.end_time,
      e.organizer_email,
      COALESCE(
        json_agg(
          json_build_object('email', ea.email, 'name', COALESCE(ea.name,''))
        ) FILTER (WHERE ea.email IS NOT NULL),
        '[]'
      ) AS attendees
    FROM events e
    LEFT JOIN event_attendees ea ON ea.event_id = e.id
    WHERE
      e.start_time >= NOW() + INTERVAL '48 hours'
      AND e.start_time <  NOW() + INTERVAL '72 hours'
      AND e.reminder_sent_at IS NULL
    GROUP BY e.id
  `)

  if (events.length === 0) {
    console.log('[reminder] No upcoming meetings to remind')
    return
  }

  for (const ev of events) {
    try {
      const attendeeEmails = (ev.attendees ?? []).map((a) => a.email).filter(Boolean)

      // Check if this is a recurring meeting (same title, previous finalized MOM)
      const { rows: prevRows } = await query<{
        event_id:   string
        start_time: Date
      }>(`
        SELECT e.id AS event_id, e.start_time
        FROM mom_sessions ms
        JOIN events e ON e.id = ms.event_id
        WHERE e.title = $1
          AND e.id   != $2
          AND ms.status = 'final'
        ORDER BY e.start_time DESC
        LIMIT 1
      `, [ev.title, ev.id])

      let previousMomDate: Date | undefined
      let previousMomItems: ReminderEmailItem[] | undefined

      if (prevRows.length > 0) {
        previousMomDate = new Date(prevRows[0].start_time)
        const prevEventId = prevRows[0].event_id

        const { rows: itemRows } = await query<{
          serial_number: number
          action_item:   string
          owner_email:   string | null
          eta:           string | null
          status:        'pending' | 'in-progress' | 'completed'
        }>(`
          SELECT mi.serial_number, mi.action_item, mi.owner_email, mi.eta, mi.status
          FROM mom_items mi
          JOIN mom_sessions ms ON ms.id = mi.session_id
          WHERE ms.event_id = $1 AND ms.status = 'final'
          ORDER BY mi.serial_number
        `, [prevEventId])

        previousMomItems = itemRows.map((r) => ({
          serialNumber: r.serial_number,
          actionItem:   r.action_item,
          ownerEmail:   r.owner_email,
          eta:          r.eta,
          status:       r.status,
        }))
      }

      await sendReminderEmail({
        eventTitle:      ev.title,
        eventStart:      new Date(ev.start_time),
        eventEnd:        new Date(ev.end_time),
        organizerEmail:  ev.organizer_email,
        attendeeEmails,
        previousMomDate,
        previousMomItems,
      })

      // Mark reminder sent
      await query(
        `UPDATE events SET reminder_sent_at = NOW() WHERE id = $1`,
        [ev.id],
      )

      console.log(`[reminder] Sent reminder for "${ev.title}" (${ev.id})`)
    } catch (err) {
      console.error(`[reminder] Failed for event ${ev.id}:`, (err as Error).message)
    }
  }
}
