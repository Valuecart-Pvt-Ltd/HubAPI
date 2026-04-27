import { Router } from 'express'
import { execSP, execSPMulti, query, sql } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { fetchUserEvents } from '../services/calendarService'
import { fetchOutlookEvents } from '../services/outlookService'
import { getAttendeeAvailability, generateTimeSlots } from '../services/availabilityService'
import { sendEventInviteEmail } from '../services/emailService'
import { fetchUserRooms, generateMeetLink } from '../services/calendarService'

export const eventsRouter = Router()
eventsRouter.use(requireAuth)

// ─── Shared types ─────────────────────────────────────────────────────────────

interface AttendeeShape {
  email:          string
  name:           string
  responseStatus: string
  department:     string | null
}

/**
 * Raw event row coming back from the SPs. Attendees and departments are
 * delivered as JSON strings (FOR JSON PATH) — we parse them in formatEvent.
 */
interface EventRowRaw {
  id:                string
  google_event_id:   string | null
  title:             string
  description:       string | null
  location:          string | null
  start_time:        Date
  end_time:          Date
  organizer_email:   string
  is_external:       boolean
  trello_board_id:   string | null
  trello_board_name: string | null
  created_at:        Date
  updated_at:        Date
  attendees_json:    string | null
  departments_json?: string | null
  mom_session_id:    string | null
  mom_status:        'draft' | 'final' | null
}

function parseJsonArray<T>(s: string | null | undefined): T[] {
  if (!s) return []
  try { return JSON.parse(s) as T[] } catch { return [] }
}

function formatEvent(row: EventRowRaw) {
  const attendees    = parseJsonArray<AttendeeShape>(row.attendees_json)
  const departments  = parseJsonArray<{ department: string }>(row.departments_json)
    .map((d) => d.department)
    .filter((d): d is string => Boolean(d))
  return {
    id:              row.id,
    googleEventId:   row.google_event_id,
    title:           row.title,
    description:     row.description,
    location:        row.location ?? null,
    startTime:       row.start_time,
    endTime:         row.end_time,
    organizerEmail:  row.organizer_email,
    isExternal:      row.is_external,
    trelloBoardId:   row.trello_board_id,
    trelloBoardName: row.trello_board_name,
    attendees,
    departments,
    momSessionId:    row.mom_session_id,
    momStatus:       row.mom_status,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  }
}

// ─── POST /api/events/availability ───────────────────────────────────────────
//
// Body: { emails: string[], date: string (YYYY-MM-DD), durationMinutes: number }
// Returns time slots for that date coloured by how many attendees are free.
// Must be declared BEFORE /:eventId to avoid route collision.

eventsRouter.post('/availability', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId
    const { emails, date, durationMinutes } = req.body as {
      emails:          string[]
      date:            string
      durationMinutes: number
    }

    if (!Array.isArray(emails) || !date || !durationMinutes) {
      res.status(400).json({
        success: false,
        error:   'emails (array), date (YYYY-MM-DD) and durationMinutes are required',
        code:    'invalid_body',
        statusCode: 400,
      })
      return
    }

    const timeMin = `${date}T00:00:00Z`
    const timeMax = `${date}T23:59:59Z`

    const busyMap = await getAttendeeAvailability(userId, emails, timeMin, timeMax)
    const slots   = generateTimeSlots(busyMap, date, durationMinutes)

    res.json({ success: true, data: { slots, attendeeCount: emails.length } })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/events ─────────────────────────────────────────────────────────
//
// Creates a new event in the DB and sends .ics invites to all attendees.
// Body: { title, description?, location?, startTime, endTime, attendeeEmails[] }

eventsRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email

    const {
      title,
      description,
      location,
      startTime,
      endTime,
      attendeeEmails,
    } = req.body as {
      title:          string
      description?:   string
      location?:      string
      startTime:      string   // ISO
      endTime:        string   // ISO
      attendeeEmails: string[]
    }

    if (!title?.trim() || !startTime || !endTime || !Array.isArray(attendeeEmails)) {
      res.status(400).json({
        success: false,
        error:   'title, startTime, endTime and attendeeEmails are required',
        code:    'invalid_body',
        statusCode: 400,
      })
      return
    }

    const start = new Date(startTime)
    const end   = new Date(endTime)
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      res.status(400).json({
        success: false,
        error:   'startTime must be before endTime and both must be valid ISO dates',
        code:    'invalid_times',
        statusCode: 400,
      })
      return
    }

    // Determine if any attendee is external (outside COMPANY_DOMAIN)
    const COMPANY_DOMAIN = process.env.COMPANY_DOMAIN ?? 'valuecart.com'
    const isExternal = attendeeEmails.some((e) => !e.toLowerCase().endsWith(`@${COMPANY_DOMAIN}`))

    const allAttendees   = [...new Set([userEmail, ...attendeeEmails])]
    const otherAttendees = attendeeEmails.filter((e) => e !== userEmail)
    const attendeesJson  = JSON.stringify(otherAttendees.map((email) => ({ email })))

    // usp_CreateEvent inserts event + attendees and EXECs usp_GetEventDetail
    // returning multi-recordsets. We need recordset[1] (the event row).
    const result = await execSPMulti('usp_CreateEvent', {
      Title:          { type: sql.NVarChar(500),     value: title.trim() },
      Description:    { type: sql.NVarChar(sql.MAX), value: description ?? null },
      Location:       { type: sql.NVarChar(sql.MAX), value: location ?? null },
      StartTime:      { type: sql.DateTime2,         value: start },
      EndTime:        { type: sql.DateTime2,         value: end },
      OrganizerEmail: { type: sql.NVarChar(255),     value: userEmail },
      IsExternal:     { type: sql.Bit,               value: isExternal },
      AttendeeEmails: { type: sql.NVarChar(sql.MAX), value: attendeesJson },
    })

    // usp_CreateEvent → usp_GetEventDetail recordsets:
    //   [0] has_access flag,  [1] event row,  [2] mom items (none yet for new event)
    const eventRows = (result.recordsets?.[1] ?? []) as EventRowRaw[]
    const created   = eventRows[0]
    if (!created) {
      res.status(500).json({ success: false, error: 'Event created but not returned by SP', code: 'create_lookup_failed', statusCode: 500 })
      return
    }

    // Resolve attendee display names from users table
    const userRows = await query<{ email: string; name: string }>(
      `SELECT email, COALESCE(name, email) AS name
       FROM users
       WHERE email IN (SELECT value FROM OPENJSON(@emails))`,
      { emails: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(allAttendees) } },
    )
    const nameMap      = new Map(userRows.map((r) => [r.email, r.name]))
    const attendeeObjs = otherAttendees.map((e) => ({ email: e, name: nameMap.get(e) ?? e.split('@')[0] }))
    const organizerName = nameMap.get(userEmail) ?? userEmail.split('@')[0]

    // Send .ics invite (non-fatal)
    sendEventInviteEmail({
      uid:            created.id,
      title:          title.trim(),
      description:    description ?? '',
      location:       location ?? '',
      startTime:      start,
      endTime:        end,
      organizerEmail: userEmail,
      organizerName,
      attendees:      attendeeObjs,
    }).catch((err) => {
      console.error('[events] sendEventInviteEmail failed (non-fatal):', err.message)
    })

    res.status(201).json({ success: true, data: formatEvent(created) })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events — list ───────────────────────────────────────────────────

eventsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const page      = Math.max(1, Number(req.query.page)     || 1)
    const pageSize  = Math.min(100, Number(req.query.pageSize) || 25)

    // usp_GetEventList returns two recordsets: [0] = total count, [1] = paged rows
    const result = await execSPMulti('usp_GetEventList', {
      UserEmail: { type: sql.NVarChar(255), value: userEmail },
      Page:      { type: sql.Int,            value: page },
      PageSize:  { type: sql.Int,            value: pageSize },
    })

    const totalRow = (result.recordsets?.[0] ?? []) as { total: number }[]
    const rows     = (result.recordsets?.[1] ?? []) as EventRowRaw[]
    const total    = Number(totalRow[0]?.total ?? 0)

    res.json({
      success: true,
      data: {
        items:      rows.map(formatEvent),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/rooms ────────────────────────────────────────────────────

eventsRouter.get('/rooms', async (req: AuthRequest, res, next) => {
  try {
    const rooms = await fetchUserRooms(req.user!.userId)
    res.json({ success: true, data: rooms })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/events/rooms — add a room ─────────────────────────────────────

eventsRouter.post('/rooms', async (req: AuthRequest, res, next) => {
  try {
    const { name, email, description, capacity, building, floorLabel } = req.body as {
      name:        string
      email:       string
      description?: string
      capacity?:   number
      building?:   string
      floorLabel?: string
    }

    if (!name?.trim() || !email?.trim()) {
      res.status(400).json({ success: false, error: 'name and email are required', code: 'invalid_body', statusCode: 400 })
      return
    }

    const rows = await execSP<{ id: string; name: string; email: string; description: string }>(
      'usp_UpsertRoom',
      {
        Name:        { type: sql.NVarChar(255),     value: name.trim() },
        Email:       { type: sql.NVarChar(255),     value: email.trim().toLowerCase() },
        Description: { type: sql.NVarChar(sql.MAX), value: description ?? '' },
        Capacity:    { type: sql.Int,                value: capacity ?? null },
        Building:    { type: sql.NVarChar(255),     value: building ?? null },
        FloorLabel:  { type: sql.NVarChar(100),     value: floorLabel ?? null },
      },
    )

    res.status(201).json({ success: true, data: { id: rows[0].email, name: rows[0].name, description: rows[0].description } })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/events/rooms/:roomEmail — remove a room ─────────────────────

eventsRouter.delete('/rooms/:roomEmail', async (req: AuthRequest, res, next) => {
  try {
    const email = decodeURIComponent(req.params.roomEmail)
    await execSP('usp_DeleteRoom', {
      Email: { type: sql.NVarChar(255), value: email },
    })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/meet-link — generate a Google Meet link ─────────────────

eventsRouter.get('/meet-link', async (req: AuthRequest, res, next) => {
  try {
    const link = await generateMeetLink(req.user!.userId)
    if (!link) {
      res.status(400).json({
        success: false,
        error:   'Could not generate a Google Meet link. Make sure Google Calendar is connected and Google Meet is enabled on your account.',
        code:    'no_meet_link',
        statusCode: 400,
      })
      return
    }
    res.json({ success: true, data: { link } })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/sync — manual trigger ────────────────────────────────────

eventsRouter.get('/sync', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.userId
    const [googleCount, outlookCount] = await Promise.all([
      fetchUserEvents(userId).catch((err: Error) => {
        console.error('[sync] Google error:', err.message)
        return 0
      }),
      fetchOutlookEvents(userId).catch((err: Error) => {
        console.error('[sync] Outlook error:', err.message)
        return 0
      }),
    ])
    const total = googleCount + outlookCount
    res.json({
      success: true,
      data: { syncedEvents: total, message: `Synced ${total} events (Google: ${googleCount}, Outlook: ${outlookCount})` },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/:eventId/next — next occurrence in the same series ──────

eventsRouter.get('/:eventId/next', async (req: AuthRequest, res, next) => {
  try {
    const userEmail   = req.user!.email
    const { eventId } = req.params

    let rows: EventRowRaw[] | null
    try {
      rows = await execSP<EventRowRaw>('usp_GetNextEvent', {
        EventId:   { type: sql.UniqueIdentifier, value: eventId },
        UserEmail: { type: sql.NVarChar(255),    value: userEmail },
      })
    } catch (err) {
      if ((err as Error).message?.includes('NOT_FOUND')) {
        res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
        return
      }
      throw err
    }

    res.json({ success: true, data: rows[0] ? formatEvent(rows[0]) : null })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/:eventId — detail ───────────────────────────────────────

interface MomItemRow {
  id:             string
  serial_number:  number
  category:       string
  action_item:    string
  owner_email:    string | null
  eta:            Date   | null
  status:         'pending' | 'in-progress' | 'completed'
  trello_card_id: string | null
}

eventsRouter.get('/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail   = req.user!.email
    const { eventId } = req.params

    const result = await execSPMulti('usp_GetEventDetail', {
      EventId:   { type: sql.UniqueIdentifier, value: eventId },
      UserEmail: { type: sql.NVarChar(255),    value: userEmail },
    })

    // Recordsets: [0] has_access flag,
    //              [1] event row (only when access granted),
    //              [2] mom items
    const accessRow = (result.recordsets?.[0] ?? []) as { has_access: number }[]
    if (!accessRow[0]) {
      res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      return
    }
    if (accessRow[0].has_access === 0) {
      // SP returns 0 when no access — distinguish 404 from 403 with a follow-up check
      const exists = await query<{ id: string }>(
        `SELECT id FROM events WHERE id = @id`,
        { id: { type: sql.UniqueIdentifier, value: eventId } },
      )
      if (!exists[0]) {
        res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      } else {
        res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      }
      return
    }

    const eventRows = (result.recordsets?.[1] ?? []) as EventRowRaw[]
    if (!eventRows[0]) {
      res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      return
    }

    const itemRows = (result.recordsets?.[2] ?? []) as MomItemRow[]
    const momItems = itemRows.map(formatMomItem)

    res.json({ success: true, data: { ...formatEvent(eventRows[0]), momItems } })
  } catch (err) {
    next(err)
  }
})

function formatMomItem(r: MomItemRow) {
  return {
    id:           r.id,
    serialNumber: r.serial_number,
    category:     r.category,
    actionItem:   r.action_item,
    ownerEmail:   r.owner_email,
    eta:          r.eta ? (r.eta as Date).toISOString().split('T')[0] : null,
    status:       r.status,
    trelloCardId: r.trello_card_id,
  }
}

// ─── PATCH /api/events/:eventId — update event details ───────────────────────

eventsRouter.patch('/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail   = req.user!.email
    const { eventId } = req.params

    const { title, description, location, startTime, endTime } = req.body as {
      title?:       string
      description?: string | null
      location?:    string | null
      startTime?:   string
      endTime?:     string
    }

    if (
      title       === undefined &&
      description === undefined &&
      location    === undefined &&
      startTime   === undefined &&
      endTime     === undefined
    ) {
      res.status(400).json({ success: false, error: 'Nothing to update', code: 'nothing_to_update', statusCode: 400 })
      return
    }

    if (title !== undefined && !title.trim()) {
      res.status(400).json({ success: false, error: 'Title cannot be empty', code: 'invalid_title', statusCode: 400 })
      return
    }

    let start: Date | null = null
    let end:   Date | null = null
    if (startTime !== undefined || endTime !== undefined) {
      start = startTime ? new Date(startTime) : null
      end   = endTime   ? new Date(endTime)   : null
      if ((start && isNaN(start.getTime())) || (end && isNaN(end.getTime()))) {
        res.status(400).json({ success: false, error: 'Invalid date format', code: 'invalid_times', statusCode: 400 })
        return
      }
    }

    let rows: EventRowRaw[]
    try {
      rows = await execSP<EventRowRaw>('usp_UpdateEvent', {
        EventId:         { type: sql.UniqueIdentifier, value: eventId },
        UserEmail:       { type: sql.NVarChar(255),    value: userEmail },
        Title:           { type: sql.NVarChar(500),    value: title !== undefined ? title.trim() : null },
        Description:     { type: sql.NVarChar(sql.MAX), value: description !== undefined && description !== null ? description : null },
        SetDescNull:     { type: sql.Bit,               value: description === null },
        Location:        { type: sql.NVarChar(sql.MAX), value: location !== undefined && location !== null ? location : null },
        SetLocationNull: { type: sql.Bit,               value: location === null },
        StartTime:       { type: sql.DateTime2,         value: start },
        EndTime:         { type: sql.DateTime2,         value: end },
      })
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('NOT_FOUND')) {
        res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
        return
      }
      if (msg.includes('FORBIDDEN')) {
        res.status(403).json({ success: false, error: 'You are not a participant of this event', code: 'forbidden', statusCode: 403 })
        return
      }
      throw err
    }

    if (!rows[0]) {
      res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      return
    }

    const updated = formatEvent(rows[0])
    res.json({ success: true, data: updated })

    // ── Send update invitations (non-fatal) ──────────────────────────────────
    try {
      const eventRow  = rows[0]
      const attendees = parseJsonArray<AttendeeShape>(eventRow.attendees_json)
      const attendeeObjs = attendees
        .filter((a) => a.email.toLowerCase() !== eventRow.organizer_email.toLowerCase())
        .map((a) => ({ email: a.email, name: a.name || a.email.split('@')[0] }))

      const orgRows = await query<{ name: string }>(
        `SELECT COALESCE(name, email) AS name FROM users WHERE email = @email`,
        { email: { type: sql.NVarChar(255), value: eventRow.organizer_email } },
      )
      const organizerName = orgRows[0]?.name ?? eventRow.organizer_email.split('@')[0]

      sendEventInviteEmail({
        uid:            eventId,
        title:          updated.title,
        description:    updated.description ?? '',
        location:       updated.location    ?? '',
        startTime:      eventRow.start_time,
        endTime:        eventRow.end_time,
        organizerEmail: eventRow.organizer_email,
        organizerName,
        attendees:      attendeeObjs,
        sequence:       1,
        isUpdate:       true,
      }).catch((err: Error) => {
        console.error('[events] sendEventInviteEmail (update) failed (non-fatal):', err.message)
      })
    } catch (emailErr: unknown) {
      console.error('[events] Failed to prepare update invite (non-fatal):', (emailErr as Error).message)
    }
  } catch (err) {
    next(err)
  }
})
