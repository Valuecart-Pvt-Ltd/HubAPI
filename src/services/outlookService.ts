import axios from 'axios'
import { execSP, query, sql } from '../db'

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

  await execSP('usp_UpdateMicrosoftTokens', {
    UserId:       { type: sql.UniqueIdentifier, value: userId },
    AccessToken:  { type: sql.NVarChar(sql.MAX), value: data.access_token },
    RefreshToken: { type: sql.NVarChar(sql.MAX), value: null },
    TokenExpiry:  { type: sql.DateTime2,         value: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null },
  })

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

function mapResponseStatus(response?: string): string {
  switch (response) {
    case 'accepted':            return 'accepted'
    case 'declined':            return 'declined'
    case 'tentativelyAccepted': return 'tentative'
    default:                    return 'needsAction'
  }
}

// ─── Main sync function ───────────────────────────────────────────────────────

export async function fetchOutlookEvents(userId: string): Promise<number> {
  const rows = await query<UserTokenRow>(
    `SELECT id, email, microsoft_access_token, microsoft_refresh_token, microsoft_token_expiry
     FROM users
     WHERE id = @userId
       AND microsoft_access_token  IS NOT NULL
       AND microsoft_refresh_token IS NOT NULL`,
    { userId: { type: sql.UniqueIdentifier, value: userId } },
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

  // Build the bulk-upsert events JSON. Outlook events use outlook_event_id
  // rather than google_event_id, so we use inline T-SQL MERGE here instead of
  // the Google-specific usp_BulkUpsertCalendarEvents SP.
  interface EventPayload {
    outlookEventId: string
    title:          string
    description:    string | null
    startTime:      string
    endTime:        string
    organizerEmail: string
    isExternal:     boolean
  }
  interface AttendeePayload {
    eventId:        string
    email:          string
    responseStatus: string
  }

  const eventPayload:    EventPayload[]    = []
  const attendeePayload: AttendeePayload[] = []

  // First pass: build event payload
  for (const ev of graphEvents) {
    if (!ev.id || !ev.start) continue
    const organizerEmail = ev.organizer?.emailAddress?.address ?? user.email
    const attendees      = ev.attendees ?? []
    const isExternal     = attendees.some(
      (a) => a.emailAddress.address && !a.emailAddress.address.endsWith(`@${COMPANY_DOMAIN}`),
    )
    eventPayload.push({
      outlookEventId: ev.id,
      title:          ev.subject ?? '(No title)',
      description:    ev.bodyPreview ?? null,
      startTime:      ev.start.dateTime,
      endTime:        ev.end.dateTime,
      organizerEmail,
      isExternal,
    })
  }

  if (eventPayload.length === 0) return 0

  // MERGE upsert events using OPENJSON
  await query(
    `MERGE events AS target
     USING (
       SELECT
         j.outlook_event_id,
         j.title,
         j.description,
         CAST(j.start_time AS DATETIME2) AS start_time,
         CAST(j.end_time   AS DATETIME2) AS end_time,
         j.organizer_email,
         CAST(j.is_external AS BIT)      AS is_external
       FROM OPENJSON(@payload) WITH (
         outlook_event_id NVARCHAR(255) '$.outlookEventId',
         title            NVARCHAR(500) '$.title',
         description      NVARCHAR(MAX) '$.description',
         start_time       NVARCHAR(50)  '$.startTime',
         end_time         NVARCHAR(50)  '$.endTime',
         organizer_email  NVARCHAR(255) '$.organizerEmail',
         is_external      NVARCHAR(5)   '$.isExternal'
       ) AS j
     ) AS src
       ON target.outlook_event_id = src.outlook_event_id
     WHEN MATCHED THEN UPDATE SET
        title       = src.title,
        description = src.description,
        start_time  = src.start_time,
        end_time    = src.end_time,
        is_external = src.is_external
     WHEN NOT MATCHED THEN
       INSERT (id, outlook_event_id, title, description, start_time, end_time, organizer_email, is_external)
       VALUES (NEWID(), src.outlook_event_id, src.title, src.description, src.start_time, src.end_time, src.organizer_email, src.is_external);`,
    { payload: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(eventPayload) } },
  )

  // Resolve outlook_event_id → DB id
  const idRows = await query<{ id: string; outlook_event_id: string }>(
    `SELECT id, outlook_event_id
       FROM events
      WHERE outlook_event_id IN (SELECT value FROM OPENJSON(@ids))`,
    { ids: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(eventPayload.map((p) => p.outlookEventId)) } },
  )
  const outlookIdToDbId = new Map(idRows.map((r) => [r.outlook_event_id, r.id]))

  // Second pass: build attendee payload from the now-known DB ids
  for (const ev of graphEvents) {
    if (!ev.id) continue
    const dbId = outlookIdToDbId.get(ev.id)
    if (!dbId) continue
    for (const a of (ev.attendees ?? [])) {
      const email = a.emailAddress.address
      if (!email) continue
      attendeePayload.push({
        eventId:        dbId,
        email,
        responseStatus: mapResponseStatus(a.status?.response),
      })
    }
  }

  if (attendeePayload.length > 0) {
    await execSP('usp_BulkUpsertAttendees', {
      AttendeesJson: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(attendeePayload) },
    })
  }

  const syncCount = idRows.length
  console.log(`[outlook] Synced ${syncCount}/${graphEvents.length} events for user ${userId}`)
  return syncCount
}
