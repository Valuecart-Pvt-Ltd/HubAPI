const { google } = require('googleapis')
const axios      = require('axios')
const { query }  = require('../config/db')

// ─── OAuth2 helper (mirrors calendarService — kept local to avoid circular dep) ─

function buildGoogleAuth(userId, accessToken, refreshToken) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken })
  client.on('tokens', (tokens) => {
    if (!tokens.access_token) return
    query(
      `UPDATE users SET google_access_token = $1, google_token_expiry = $2 WHERE id = $3`,
      [tokens.access_token, tokens.expiry_date ? new Date(tokens.expiry_date) : null, userId],
    ).catch(() => {})
  })
  return client
}

async function refreshMicrosoftToken(userId, refreshToken) {
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    scope:         'openid profile email offline_access Calendars.Read',
  })
  const { data } = await axios.post(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  )
  await query(
    `UPDATE users
        SET microsoft_access_token = $1,
            microsoft_token_expiry = $2
      WHERE id = $3`,
    [data.access_token, data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null, userId],
  ).catch(() => {})
  return data.access_token
}

// ─── 1. Google free/busy ─────────────────────────────────────────────────────

async function getGoogleFreeBusy(organizerUserId, emails, timeMin, timeMax) {
  const result = new Map()
  if (!emails.length) return result

  const { rows } = await query(
    'SELECT google_access_token, google_refresh_token FROM users WHERE id = $1',
    [organizerUserId],
  )
  const user = rows[0]
  if (!user?.google_refresh_token) return result

  const auth     = buildGoogleAuth(organizerUserId, user.google_access_token || '', user.google_refresh_token)
  const calendar = google.calendar({ version: 'v3', auth })

  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: emails.map((id) => ({ id })),
    },
  })

  const calendars = resp.data.calendars || {}
  for (const email of emails) {
    const busy = (calendars[email]?.busy || []).map((b) => ({
      start: b.start,
      end:   b.end,
    }))
    result.set(email, busy)
  }
  return result
}

// ─── 2. Microsoft free/busy ──────────────────────────────────────────────────

async function getMicrosoftFreeBusy(organizerUserId, emails, timeMin, timeMax) {
  const result = new Map()
  if (!emails.length) return result

  const { rows } = await query(
    `SELECT microsoft_access_token, microsoft_refresh_token, microsoft_token_expiry
       FROM users WHERE id = $1`,
    [organizerUserId],
  )
  const user = rows[0]
  if (!user?.microsoft_access_token) return result

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

    for (const schedule of (resp.data.value || [])) {
      const email = schedule.scheduleId
      const busy = (schedule.scheduleItems || [])
        .filter((item) => item.status === 'busy' || item.status === 'tentative' || item.status === 'oof')
        .map((item) => ({
          start: item.start.dateTime.endsWith('Z') ? item.start.dateTime : `${item.start.dateTime}Z`,
          end:   item.end.dateTime.endsWith('Z')   ? item.end.dateTime   : `${item.end.dateTime}Z`,
        }))
      result.set(email, busy)
    }
  } catch (err) {
    console.warn('[availability] Microsoft getSchedule failed (non-fatal):', err.message)
  }
  return result
}

// ─── 3. Merged free/busy ─────────────────────────────────────────────────────

async function getAttendeeAvailability(organizerUserId, emails, timeMin, timeMax) {
  const [googleMap, msMap] = await Promise.all([
    getGoogleFreeBusy(organizerUserId,    emails, timeMin, timeMax).catch(() => new Map()),
    getMicrosoftFreeBusy(organizerUserId, emails, timeMin, timeMax).catch(() => new Map()),
  ])

  const merged = new Map()
  for (const email of emails) {
    const gBusy  = googleMap.get(email) || []
    const msBusy = msMap.get(email)     || []
    merged.set(email, [...gBusy, ...msBusy])
  }
  return merged
}

// ─── 4. Slot generator ───────────────────────────────────────────────────────

function generateTimeSlots(
  busyMap,
  date,
  durationMinutes,
  startHourUTC = 3,
  endHourUTC   = 14,
  intervalMins = 30,
) {
  const totalAttendees = busyMap.size
  const slots = []
  const allBusy = Array.from(busyMap.values())

  for (let h = startHourUTC; h < endHourUTC; h++) {
    for (let m = 0; m < 60; m += intervalMins) {
      const slotStart = new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
      const slotEnd   = new Date(slotStart.getTime() + durationMinutes * 60_000)

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

module.exports = {
  getGoogleFreeBusy,
  getMicrosoftFreeBusy,
  getAttendeeAvailability,
  generateTimeSlots,
}
