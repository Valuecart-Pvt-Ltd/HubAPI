import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'
import cron from 'node-cron'
import { execSP, query, sql } from '../db'
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
    execSP('usp_UpdateGoogleTokens', {
      UserId:      { type: sql.UniqueIdentifier, value: userId },
      AccessToken: { type: sql.NVarChar(sql.MAX), value: tokens.access_token },
      TokenExpiry: { type: sql.DateTime2,         value: tokens.expiry_date ? new Date(tokens.expiry_date) : null },
    }).catch((err: Error) =>
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
// Performance: bulk upserts via JSON-driven SPs (usp_BulkUpsertCalendarEvents,
// usp_BulkUpsertAttendees) — single round-trip per recordset regardless of size.

export async function fetchUserEvents(userId: string): Promise<number> {
  const rows = await query<UserTokenRow>(
    `SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
     FROM users
     WHERE id = @userId
       AND google_access_token  IS NOT NULL
       AND google_refresh_token IS NOT NULL`,
    { userId: { type: sql.UniqueIdentifier, value: userId } },
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

  // Build the EventsJson payload for usp_BulkUpsertCalendarEvents
  interface EventPayload {
    googleEventId:   string
    title:           string
    description:     string | null
    startTime:       string
    endTime:         string
    organizerEmail:  string
    isExternal:      string                     // 'true' | 'false' — SP CASTs to BIT
    trelloBoardId:   string | null
    trelloBoardName: string | null
  }

  const eventPayload: EventPayload[] = []
  for (const e of calEvents) {
    if (!e.id || !e.start) continue
    const organizerEmail = e.organizer?.email ?? user.email
    eventPayload.push({
      googleEventId:   e.id,
      title:           e.summary ?? '(No title)',
      description:     e.description ?? null,
      startTime:       (e.start.dateTime ?? e.start.date)!,
      endTime:         (e.end?.dateTime  ?? e.end?.date)!,
      organizerEmail,
      isExternal:      ((e.attendees ?? []).some(
        (a) => a.email && !a.email.endsWith(`@${COMPANY_DOMAIN}`),
      )).toString(),
      // Trello has been removed — always null going forward
      trelloBoardId:   null,
      trelloBoardName: null,
    })
  }

  if (eventPayload.length === 0) return 0

  // ── Step 1: bulk upsert events ───────────────────────────────────────────────
  await execSP('usp_BulkUpsertCalendarEvents', {
    EventsJson: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(eventPayload) },
  })

  // ── Step 2: resolve google_event_id → DB id for the upserted rows ─────────────
  const dbIdRows = await query<{ id: string; google_event_id: string }>(
    `SELECT id, google_event_id
       FROM events
      WHERE google_event_id IN (SELECT value FROM OPENJSON(@ids))`,
    { ids: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(eventPayload.map((p) => p.googleEventId)) } },
  )
  const googleIdToDbId = new Map(dbIdRows.map((r) => [r.google_event_id, r.id]))

  // ── Step 3: build attendees JSON and bulk upsert ─────────────────────────────
  interface AttendeePayload {
    eventId:        string
    email:          string
    responseStatus: string
  }
  const attendeePayload: AttendeePayload[] = []
  for (const calEvent of calEvents) {
    if (!calEvent.id) continue
    const dbId = googleIdToDbId.get(calEvent.id)
    if (!dbId) continue
    for (const a of (calEvent.attendees ?? [])) {
      if (!a.email) continue
      attendeePayload.push({
        eventId:        dbId,
        email:          a.email,
        responseStatus: a.responseStatus ?? 'needsAction',
      })
    }
  }

  if (attendeePayload.length > 0) {
    await execSP('usp_BulkUpsertAttendees', {
      AttendeesJson: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(attendeePayload) },
    })
  }

  const syncCount = dbIdRows.length
  console.log(`[calendar] Synced ${syncCount}/${calEvents.length} events for user ${userId}`)
  return syncCount
}

// ─── Room resource fetcher ────────────────────────────────────────────────────

export interface RoomResource {
  id:          string   // calendar ID == booking email
  name:        string
  description: string
}

export async function fetchUserRooms(userId: string): Promise<RoomResource[]> {
  // ── 1. Load rooms saved in the DB (primary source) ───────────────────────
  const dbRooms = await execSP<{
    id: string; name: string; email: string; description: string
  }>('usp_GetRooms')

  const dbEmails = new Set(dbRooms.map((r) => r.email.toLowerCase()))

  const result: RoomResource[] = dbRooms.map((r) => ({
    id:          r.email,
    name:        r.name,
    description: r.description,
  }))

  // ── 2. Supplement with Google Calendar resource calendars the user has ────
  try {
    const rows = await query<UserTokenRow>(
      `SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
       FROM users
       WHERE id = @userId
         AND google_access_token  IS NOT NULL
         AND google_refresh_token IS NOT NULL`,
      { userId: { type: sql.UniqueIdentifier, value: userId } },
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

export async function generateMeetLink(userId: string): Promise<string | null> {
  const rows = await query<UserTokenRow>(
    `SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
     FROM users
     WHERE id = @userId
       AND google_access_token  IS NOT NULL
       AND google_refresh_token IS NOT NULL`,
    { userId: { type: sql.UniqueIdentifier, value: userId } },
  )
  if (!rows[0]) {
    console.warn('[calendar] generateMeetLink: no Google tokens for user', userId)
    return null
  }

  const oauthClient    = buildOAuthClient(userId, rows[0].google_access_token, rows[0].google_refresh_token)
  const calendarClient = google.calendar({ version: 'v3', auth: oauthClient })

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

  let meetLink: string | null = created.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === 'video',
  )?.uri ?? null

  if (!meetLink && created.id) {
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

    const rows = await execSP<{ id: string; email: string }>('usp_GetUsersForCalendarSync').catch((err: Error) => {
      console.error('[calendar] Failed to fetch users for sync:', err.message)
      return [] as { id: string; email: string }[]
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
  // usp_GetUpcomingMeetingsForReminder finds events 48–72h out with no reminder yet
  const events = await execSP<{
    id:              string
    title:           string
    start_time:      Date
    end_time:        Date
    organizer_email: string
    attendees_json:  string | null
  }>('usp_GetUpcomingMeetingsForReminder')

  if (events.length === 0) {
    console.log('[reminder] No upcoming meetings to remind')
    return
  }

  for (const ev of events) {
    try {
      const attendees: { email: string }[] = ev.attendees_json ? JSON.parse(ev.attendees_json) : []
      const attendeeEmails = attendees.map((a) => a.email).filter(Boolean)

      // Check if this is a recurring meeting (same title, previous finalized MOM)
      const prevRows = await query<{
        event_id:   string
        start_time: Date
      }>(
        `SELECT TOP 1 e.id AS event_id, e.start_time
           FROM mom_sessions ms
           JOIN events e ON e.id = ms.event_id
          WHERE e.title    = @title
            AND e.id      != @eventId
            AND ms.status  = 'final'
          ORDER BY e.start_time DESC`,
        {
          title:   { type: sql.NVarChar(500),     value: ev.title },
          eventId: { type: sql.UniqueIdentifier, value: ev.id },
        },
      )

      let previousMomDate: Date | undefined
      let previousMomItems: ReminderEmailItem[] | undefined

      if (prevRows.length > 0) {
        previousMomDate = new Date(prevRows[0].start_time)
        const prevEventId = prevRows[0].event_id

        const itemRows = await query<{
          serial_number: number
          action_item:   string
          owner_email:   string | null
          eta:           string | null
          status:        'pending' | 'in-progress' | 'completed'
        }>(
          `SELECT mi.serial_number, mi.action_item, mi.owner_email, mi.eta, mi.status
             FROM mom_items mi
             JOIN mom_sessions ms ON ms.id = mi.mom_session_id
            WHERE ms.event_id = @eventId AND ms.status = 'final'
            ORDER BY mi.serial_number`,
          { eventId: { type: sql.UniqueIdentifier, value: prevEventId } },
        )

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
      await execSP('usp_MarkReminderSent', {
        EventId: { type: sql.UniqueIdentifier, value: ev.id },
      })

      console.log(`[reminder] Sent reminder for "${ev.title}" (${ev.id})`)
    } catch (err) {
      console.error(`[reminder] Failed for event ${ev.id}:`, (err as Error).message)
    }
  }
}
