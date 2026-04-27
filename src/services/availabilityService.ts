import { google }  from 'googleapis'
import axios        from 'axios'
import { execSP, query, sql }    from '../db'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BusySlot {
  start: string   // ISO
  end:   string   // ISO
}

export interface TimeSlot {
  start:          string   // ISO – slot start
  end:            string   // ISO – slot end
  freeCount:      number
  busyCount:      number
  totalAttendees: number
}

// ─── OAuth2 helper (mirrors calendarService — kept local to avoid circular dep) ──

function buildGoogleAuth(userId: string, accessToken: string, refreshToken: string) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
  )
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken })
  client.on('tokens', (tokens) => {
    if (!tokens.access_token) return
    execSP('usp_UpdateGoogleTokens', {
      UserId:      { type: sql.UniqueIdentifier, value: userId },
      AccessToken: { type: sql.NVarChar(sql.MAX), value: tokens.access_token },
      TokenExpiry: { type: sql.DateTime2,         value: tokens.expiry_date ? new Date(tokens.expiry_date) : null },
    }).catch(() => {})
  })
  return client
}

// ─── Microsoft token refresh (mirrors outlookService) ────────────────────────

async function refreshMicrosoftToken(userId: string, refreshToken: string): Promise<string> {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID!,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    scope:         'openid profile email offline_access Calendars.Read',
  })
  const { data } = await axios.post(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  )
  await execSP('usp_UpdateMicrosoftTokens', {
    UserId:       { type: sql.UniqueIdentifier, value: userId },
    AccessToken:  { type: sql.NVarChar(sql.MAX), value: data.access_token },
    RefreshToken: { type: sql.NVarChar(sql.MAX), value: null },
    TokenExpiry:  { type: sql.DateTime2,         value: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null },
  }).catch(() => {})
  return data.access_token as string
}

// ─── 1. Google free/busy ─────────────────────────────────────────────────────

export async function getGoogleFreeBusy(
  organizerUserId: string,
  emails:          string[],
  timeMin:         string,
  timeMax:         string,
): Promise<Map<string, BusySlot[]>> {
  const result = new Map<string, BusySlot[]>()
  if (!emails.length) return result

  const rows = await query<{
    google_access_token:  string | null
    google_refresh_token: string | null
  }>(
    `SELECT google_access_token, google_refresh_token FROM users WHERE id = @userId`,
    { userId: { type: sql.UniqueIdentifier, value: organizerUserId } },
  )
  const user = rows[0]
  if (!user?.google_refresh_token) return result

  const auth     = buildGoogleAuth(organizerUserId, user.google_access_token ?? '', user.google_refresh_token)
  const calendar = google.calendar({ version: 'v3', auth })

  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: emails.map((id) => ({ id })),
    },
  })

  const calendars = resp.data.calendars ?? {}
  for (const email of emails) {
    const busy = (calendars[email]?.busy ?? []).map((b) => ({
      start: b.start!,
      end:   b.end!,
    }))
    result.set(email, busy)
  }
  return result
}

// ─── 2. Microsoft free/busy ──────────────────────────────────────────────────

export async function getMicrosoftFreeBusy(
  organizerUserId: string,
  emails:          string[],
  timeMin:         string,
  timeMax:         string,
): Promise<Map<string, BusySlot[]>> {
  const result = new Map<string, BusySlot[]>()
  if (!emails.length) return result

  const rows = await query<{
    microsoft_access_token:  string | null
    microsoft_refresh_token: string | null
    microsoft_token_expiry:  Date   | null
  }>(
    `SELECT microsoft_access_token, microsoft_refresh_token, microsoft_token_expiry
     FROM users WHERE id = @userId`,
    { userId: { type: sql.UniqueIdentifier, value: organizerUserId } },
  )
  const user = rows[0]
  if (!user?.microsoft_access_token) return result

  // Refresh token if expired (or about to expire in <60s)
  let token = user.microsoft_access_token
  const expiry = user.microsoft_token_expiry ? new Date(user.microsoft_token_expiry) : null
  if (expiry && expiry.getTime() - Date.now() < 60_000) {
    if (!user.microsoft_refresh_token) return result
    try {
      token = await refreshMicrosoftToken(organizerUserId, user.microsoft_refresh_token)
    } catch {
      return result
    }
  }

  try {
    const resp = await axios.post(
      'https://graph.microsoft.com/v1.0/me/calendar/getSchedule',
      {
        schedules:                emails,
        startTime:                { dateTime: timeMin.replace('Z', ''), timeZone: 'UTC' },
        endTime:                  { dateTime: timeMax.replace('Z', ''), timeZone: 'UTC' },
        availabilityViewInterval: 30,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    )

    for (const schedule of (resp.data.value ?? [])) {
      const email = schedule.scheduleId as string
      const busy: BusySlot[] = (schedule.scheduleItems ?? [])
        .filter((item: { status: string }) => item.status === 'busy' || item.status === 'tentative' || item.status === 'oof')
        .map((item: { start: { dateTime: string }; end: { dateTime: string } }) => ({
          start: item.start.dateTime.endsWith('Z') ? item.start.dateTime : `${item.start.dateTime}Z`,
          end:   item.end.dateTime.endsWith('Z')   ? item.end.dateTime   : `${item.end.dateTime}Z`,
        }))
      result.set(email, busy)
    }
  } catch (err) {
    console.warn('[availability] Microsoft getSchedule failed (non-fatal):', (err as Error).message)
  }
  return result
}

// ─── 3. Merged free/busy ─────────────────────────────────────────────────────

export async function getAttendeeAvailability(
  organizerUserId: string,
  emails:          string[],
  timeMin:         string,
  timeMax:         string,
): Promise<Map<string, BusySlot[]>> {
  const [googleMap, msMap] = await Promise.all([
    getGoogleFreeBusy(organizerUserId,   emails, timeMin, timeMax).catch(() => new Map<string, BusySlot[]>()),
    getMicrosoftFreeBusy(organizerUserId, emails, timeMin, timeMax).catch(() => new Map<string, BusySlot[]>()),
  ])

  // Merge: union busy slots from both providers per email
  const merged = new Map<string, BusySlot[]>()
  for (const email of emails) {
    const gBusy  = googleMap.get(email) ?? []
    const msBusy = msMap.get(email) ?? []
    merged.set(email, [...gBusy, ...msBusy])
  }
  return merged
}

// ─── 4. Slot generator ───────────────────────────────────────────────────────

export function generateTimeSlots(
  busyMap:         Map<string, BusySlot[]>,
  date:            string,          // YYYY-MM-DD  (interpreted in UTC)
  durationMinutes: number,
  startHourUTC:    number = 3,      // 3 UTC = 8:30 AM IST
  endHourUTC:      number = 14,     // 14 UTC = 7:30 PM IST
  intervalMins:    number = 30,
): TimeSlot[] {
  const totalAttendees = busyMap.size
  const slots: TimeSlot[] = []
  const allBusy = Array.from(busyMap.values())

  for (let h = startHourUTC; h < endHourUTC; h++) {
    for (let m = 0; m < 60; m += intervalMins) {
      const slotStart = new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
      const slotEnd   = new Date(slotStart.getTime() + durationMinutes * 60_000)

      // Don't generate slots that end past our window
      if (slotEnd.getUTCHours() > endHourUTC) break

      let busyCount = 0
      for (const busy of allBusy) {
        const conflict = busy.some((b) => {
          const bStart = new Date(b.start)
          const bEnd   = new Date(b.end)
          return slotStart < bEnd && slotEnd > bStart
        })
        if (conflict) busyCount++
      }

      slots.push({
        start:          slotStart.toISOString(),
        end:            slotEnd.toISOString(),
        freeCount:      totalAttendees - busyCount,
        busyCount,
        totalAttendees,
      })
    }
  }
  return slots
}
