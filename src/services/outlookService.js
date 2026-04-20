const axios = require('axios')
const { query, withTransaction } = require('../config/db')

const COMPANY_DOMAIN   = process.env.COMPANY_DOMAIN || 'valuecart.com'
const SYNC_WINDOW_DAYS = 90
const GRAPH_BASE       = 'https://graph.microsoft.com/v1.0'

// ─── Token refresh helper ─────────────────────────────────────────────────────

async function refreshAccessToken(userId, refreshToken) {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
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

async function fetchGraphEvents(accessToken) {
  const now = new Date()
  const end = new Date(now.getTime() + SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const events = []
  let url =
    `${GRAPH_BASE}/me/calendarView` +
    `?startDateTime=${now.toISOString()}` +
    `&endDateTime=${end.toISOString()}` +
    `&$select=id,subject,bodyPreview,start,end,organizer,attendees` +
    `&$top=100`

  while (url) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    events.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }

  return events
}

// ─── DB upsert helpers ────────────────────────────────────────────────────────

async function upsertOutlookEvent(tx, ev, organizerEmail, isExternal) {
  const { rows } = await tx(
    `MERGE events AS tgt
       USING (VALUES ($1, $2, $3, $4, $5, $6, $7))
             AS src (outlook_event_id, title, description, start_time, end_time,
                     organizer_email, is_external)
       ON tgt.outlook_event_id = src.outlook_event_id
       WHEN MATCHED THEN UPDATE SET
         title       = src.title,
         description = src.description,
         start_time  = src.start_time,
         end_time    = src.end_time,
         is_external = src.is_external
       WHEN NOT MATCHED THEN
         INSERT (outlook_event_id, title, description, start_time, end_time,
                 organizer_email, is_external)
         VALUES (src.outlook_event_id, src.title, src.description, src.start_time,
                 src.end_time, src.organizer_email, src.is_external)
       OUTPUT INSERTED.id;`,
    [
      ev.id,
      ev.subject || '(No title)',
      ev.bodyPreview || null,
      ev.start.dateTime,
      ev.end.dateTime,
      organizerEmail,
      isExternal ? 1 : 0,
    ],
  )
  return rows[0].id
}

async function upsertAttendees(tx, eventId, attendees) {
  if (!attendees || !attendees.length) return

  const emails = attendees.map((a) => a.emailAddress.address).filter(Boolean)

  // Postgres `email = ANY($1::text[])` → MSSQL needs an `IN` with inlined placeholders.
  const placeholders = emails.map((_, i) => `$${i + 1}`).join(', ')
  const { rows: userRows } = emails.length
    ? await tx(
        `SELECT id, email FROM users WHERE email IN (${placeholders})`,
        emails,
      )
    : { rows: [] }

  const emailToUserId = new Map(userRows.map((r) => [r.email, r.id]))

  for (const attendee of attendees) {
    const email = attendee.emailAddress.address
    if (!email) continue
    const responseStatus = mapResponseStatus(attendee.status?.response)

    await tx(
      `MERGE event_attendees AS tgt
         USING (VALUES ($1, $2, $3, $4))
               AS src (event_id, user_id, email, response_status)
         ON tgt.event_id = src.event_id AND tgt.email = src.email
         WHEN MATCHED THEN UPDATE SET
           user_id         = COALESCE(src.user_id, tgt.user_id),
           response_status = src.response_status
         WHEN NOT MATCHED THEN
           INSERT (event_id, user_id, email, response_status)
           VALUES (src.event_id, src.user_id, src.email, src.response_status);`,
      [eventId, emailToUserId.get(email) || null, email, responseStatus],
    )
  }
}

function mapResponseStatus(response) {
  switch (response) {
    case 'accepted':  return 'accepted'
    case 'declined':  return 'declined'
    case 'tentativelyAccepted': return 'tentative'
    default: return 'needsAction'
  }
}

// ─── Main sync function ───────────────────────────────────────────────────────

async function fetchOutlookEvents(userId) {
  const { rows } = await query(
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

  let accessToken = user.microsoft_access_token
  const expiry = user.microsoft_token_expiry
  if (!expiry || new Date(expiry).getTime() - Date.now() < 5 * 60 * 1000) {
    try {
      accessToken = await refreshAccessToken(userId, user.microsoft_refresh_token)
    } catch (err) {
      console.error(`[outlook] Token refresh failed for user ${userId}:`, err.message)
      return 0
    }
  }

  const graphEvents = await fetchGraphEvents(accessToken)
  if (graphEvents.length === 0) return 0

  let syncCount = 0

  for (const ev of graphEvents) {
    if (!ev.id || !ev.start) continue

    const organizerEmail = ev.organizer?.emailAddress?.address || user.email
    const attendees      = ev.attendees || []
    const isExternal     = attendees.some(
      (a) => a.emailAddress.address && !a.emailAddress.address.endsWith(`@${COMPANY_DOMAIN}`),
    )

    try {
      await withTransaction(async (tx) => {
        const eventId = await upsertOutlookEvent(tx, ev, organizerEmail, isExternal)
        await upsertAttendees(tx, eventId, attendees)
      })
      syncCount++
    } catch (err) {
      console.error(
        `[outlook] Failed to upsert event ${ev.id} for user ${userId}:`, err.message,
      )
    }
  }

  console.log(`[outlook] Synced ${syncCount}/${graphEvents.length} events for user ${userId}`)
  return syncCount
}

module.exports = { fetchOutlookEvents }
