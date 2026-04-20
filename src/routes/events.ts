import { Router } from 'express'
import { query } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { fetchUserEvents } from '../services/calendarService'
import { fetchOutlookEvents } from '../services/outlookService'
import { getAttendeeAvailability, generateTimeSlots } from '../services/availabilityService'
import { sendEventInviteEmail } from '../services/emailService'
import { fetchUserRooms, generateMeetLink } from '../services/calendarService'

export const eventsRouter = Router()
eventsRouter.use(requireAuth)

// ─── Shared query builders ────────────────────────────────────────────────────

/**
 * Rich event row shape returned from the DB queries below.
 * Attendee list and departments are aggregated by PostgreSQL.
 */
interface EventRow {
  id:               string
  google_event_id:  string | null
  title:            string
  description:      string | null
  location:         string | null
  start_time:       Date
  end_time:         Date
  organizer_email:  string
  is_external:      boolean
  trello_board_id:  string | null
  trello_board_name: string | null
  created_at:       Date
  updated_at:       Date
  attendees:        AttendeeShape[]
  departments:      string[]
  mom_session_id:   string | null
  mom_status:       'draft' | 'final' | null
}

interface AttendeeShape {
  email:          string
  name:           string
  responseStatus: string
  department:     string | null
}

function formatEvent(row: EventRow) {
  return {
    id:             row.id,
    googleEventId:  row.google_event_id,
    title:          row.title,
    description:    row.description,
    location:       row.location ?? null,
    startTime:      row.start_time,
    endTime:        row.end_time,
    organizerEmail: row.organizer_email,
    isExternal:     row.is_external,
    trelloBoardId:  row.trello_board_id,
    trelloBoardName: row.trello_board_name,
    attendees:      row.attendees ?? [],
    departments:    row.departments ?? [],
    momSessionId:   row.mom_session_id,
    momStatus:      row.mom_status,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  }
}

// ─── Rich event SELECT fragment ───────────────────────────────────────────────
//
// Reused by both list and detail endpoints.
// Caller provides: $userEmail (for membership check), plus any additional params.

const EVENT_SELECT = `
  WITH latest_mom AS (
    SELECT DISTINCT ON (event_id)
      id    AS mom_session_id,
      event_id,
      status AS mom_status
    FROM mom_sessions
    ORDER BY event_id, created_at DESC
  ),
  attendee_departments AS (
    -- Departments come from the organizer's Trello boards only
    SELECT e.id AS event_id, tm.trello_board_name AS department
    FROM events e
    JOIN trello_mappings tm ON tm.user_email = e.organizer_email
  ),
  event_attendees_agg AS (
    -- Pre-aggregate attendees so the boards join below cannot multiply rows
    SELECT
      ea.event_id,
      COALESCE(
        json_agg(
          json_build_object(
            'email',          ea.email,
            'name',           COALESCE(u.name, ea.email),
            'responseStatus', ea.response_status,
            'department',     u.department
          ) ORDER BY ea.email
        ) FILTER (WHERE ea.email IS NOT NULL),
        '[]'::json
      ) AS attendees
    FROM event_attendees ea
    LEFT JOIN users u ON u.email = ea.email
    GROUP BY ea.event_id
  )
  SELECT
    e.id,
    e.google_event_id,
    e.title,
    e.description,
    e.location,
    e.start_time,
    e.end_time,
    e.organizer_email,
    e.is_external,
    e.trello_board_id,
    e.trello_board_name,
    e.created_at,
    e.updated_at,
    COALESCE(MAX(eaa.attendees::text)::json, '[]'::json) AS attendees,
    array_remove(array_agg(DISTINCT ad.department), NULL) AS departments,
    lm.mom_session_id,
    lm.mom_status
  FROM events e
  LEFT JOIN event_attendees_agg eaa ON eaa.event_id = e.id
  LEFT JOIN attendee_departments ad  ON ad.event_id  = e.id
  LEFT JOIN latest_mom lm            ON lm.event_id  = e.id
`

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
    const userId    = req.user!.userId

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

    // Insert event
    const { rows: evRows } = await query<{ id: string }>(
      `INSERT INTO events
         (title, description, location, start_time, end_time, organizer_email, is_external, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')
       RETURNING id`,
      [title.trim(), description ?? null, location ?? null, start, end, userEmail, isExternal],
    )
    const eventId = evRows[0].id

    // Insert organizer as an attendee (accepted)
    const allAttendees = [...new Set([userEmail, ...attendeeEmails])]
    for (const email of allAttendees) {
      const responseStatus = email === userEmail ? 'accepted' : 'needsAction'
      await query(
        `INSERT INTO event_attendees (event_id, email, response_status)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, email) DO UPDATE SET response_status = $3`,
        [eventId, email, responseStatus],
      )
    }

    // Resolve attendee display names from users table
    const { rows: userRows } = await query<{ email: string; name: string }>(
      `SELECT email, COALESCE(name, email) AS name FROM users WHERE email = ANY($1)`,
      [allAttendees],
    )
    const nameMap = new Map(userRows.map((r) => [r.email, r.name]))
    const attendeeObjs = attendeeEmails
      .filter((e) => e !== userEmail)
      .map((e) => ({ email: e, name: nameMap.get(e) ?? e.split('@')[0] }))

    // Organizer name
    const organizerName = nameMap.get(userEmail) ?? userEmail.split('@')[0]

    // Send .ics invite (non-fatal)
    sendEventInviteEmail({
      uid:            eventId,
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

    // Return the created event in the same shape as GET /api/events
    const { rows } = await query<EventRow>(
      `${EVENT_SELECT}
       WHERE e.id = $1
       GROUP BY e.id, lm.mom_session_id, lm.mom_status`,
      [eventId],
    )

    res.status(201).json({ success: true, data: formatEvent(rows[0]) })
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
    const offset    = (page - 1) * pageSize

    const { rows } = await query<EventRow>(
      `${EVENT_SELECT}
       WHERE e.id IN (
         -- events the user organised
         SELECT id FROM events WHERE organizer_email = $1
         UNION
         -- events the user was invited to
         SELECT event_id FROM event_attendees WHERE email = $1
       )
       GROUP BY e.id, lm.mom_session_id, lm.mom_status
       ORDER BY e.start_time ASC
       LIMIT $2 OFFSET $3`,
      [userEmail, pageSize, offset],
    )

    // Count total (without pagination) for the client
    const { rows: countRows } = await query<{ total: string }>(
      `SELECT COUNT(DISTINCT e.id) AS total
       FROM events e
       LEFT JOIN event_attendees ea ON ea.event_id = e.id
       WHERE e.organizer_email = $1 OR ea.email = $1`,
      [userEmail],
    )

    res.json({
      success: true,
      data: {
        items:      rows.map(formatEvent),
        total:      Number(countRows[0].total),
        page,
        pageSize,
        totalPages: Math.ceil(Number(countRows[0].total) / pageSize),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/rooms ────────────────────────────────────────────────────
// Returns DB-stored conference rooms merged with any Google Calendar resource
// calendars the user has subscribed to.

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

    const { rows } = await query<{ id: string; name: string; email: string; description: string }>(
      `INSERT INTO conference_rooms (name, email, description, capacity, building, floor_label)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         name        = EXCLUDED.name,
         description = EXCLUDED.description,
         capacity    = EXCLUDED.capacity,
         building    = EXCLUDED.building,
         floor_label = EXCLUDED.floor_label
       RETURNING id, name, email, description`,
      [name.trim(), email.trim().toLowerCase(), description ?? '', capacity ?? null, building ?? null, floorLabel ?? null],
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
    await query(`DELETE FROM conference_rooms WHERE email = $1`, [email])
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/events/meet-link — generate a Google Meet link ─────────────────
// Creates a temporary Google Calendar event to obtain a Meet conference link,
// then deletes the temp event. The Meet link remains valid after deletion.

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
//
// NOTE: must be declared before /:eventId so Express doesn't treat "sync" as an ID

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
//
// Returns the nearest future event with the same title that starts after the
// current event ends. Used to show "Next Meeting" on the EventDetail page.
// Must be declared BEFORE /:eventId to avoid Express treating "next" as an ID.

eventsRouter.get('/:eventId/next', async (req: AuthRequest, res, next) => {
  try {
    const userEmail   = req.user!.email
    const { eventId } = req.params

    // Fetch the current event to get its title + end_time
    const { rows: currRows } = await query<{ title: string; end_time: Date }>(
      `SELECT title, end_time FROM events WHERE id = $1`,
      [eventId],
    )
    if (!currRows[0]) {
      res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      return
    }

    const { title, end_time } = currRows[0]

    // Find the nearest future event with the same title the user can see
    const { rows } = await query<EventRow>(
      `${EVENT_SELECT}
       WHERE e.id != $1
         AND LOWER(e.title) = LOWER($2)
         AND e.start_time > $3
         AND e.start_time > NOW()
         AND e.id IN (
           SELECT id FROM events WHERE organizer_email = $4
           UNION
           SELECT event_id FROM event_attendees WHERE email = $4
         )
       GROUP BY e.id, lm.mom_session_id, lm.mom_status
       ORDER BY e.start_time ASC
       LIMIT 1`,
      [eventId, title, end_time, userEmail],
    )

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

    const { rows } = await query<EventRow>(
      `${EVENT_SELECT}
       WHERE e.id = $1
       GROUP BY e.id, lm.mom_session_id, lm.mom_status`,
      [eventId],
    )

    if (!rows[0]) {
      res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      return
    }

    const event = rows[0]

    // Authorisation — must be organiser or attendee
    // Cross-user visibility: any attendee whose email is stored in event_attendees
    // can access this event, regardless of who performed the calendar sync.
    const isOrganiser = event.organizer_email === userEmail
    const isAttendee  = (event.attendees ?? []).some(
      (a: AttendeeShape) => a.email === userEmail,
    )

    if (!isOrganiser && !isAttendee) {
      res.status(403).json({ success: false, error: 'Forbidden', code: 'forbidden', statusCode: 403 })
      return
    }

    // Fetch MOM items when a session exists
    let momItems: ReturnType<typeof formatMomItem>[] = []
    if (event.mom_session_id) {
      const { rows: itemRows } = await query<MomItemRow>(
        `SELECT id, serial_number, category, action_item, owner_email, eta, status, trello_card_id
         FROM mom_items
         WHERE mom_session_id = $1
         ORDER BY serial_number ASC`,
        [event.mom_session_id],
      )
      momItems = itemRows.map(formatMomItem)
    }

    res.json({ success: true, data: { ...formatEvent(event), momItems } })
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
//
// Only the organiser may update. Allows editing title, description, location,
// startTime, endTime. Calendar invites are NOT re-sent automatically.

eventsRouter.patch('/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail   = req.user!.email
    const { eventId } = req.params

    // Verify the user is an organiser or attendee of this event
    const { rows: access } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
       FROM events e
       LEFT JOIN event_attendees ea ON ea.event_id = e.id
       WHERE e.id = $1
         AND (LOWER(e.organizer_email) = LOWER($2) OR LOWER(ea.email) = LOWER($2))`,
      [eventId, userEmail],
    )
    if (Number(access[0]?.cnt ?? 0) === 0) {
      // Distinguish 404 vs 403
      const { rows: exists } = await query<{ id: string }>(`SELECT id FROM events WHERE id = $1`, [eventId])
      if (!exists[0]) {
        res.status(404).json({ success: false, error: 'Event not found', code: 'event_not_found', statusCode: 404 })
      } else {
        res.status(403).json({ success: false, error: 'You are not a participant of this event', code: 'forbidden', statusCode: 403 })
      }
      return
    }

    const { title, description, location, startTime, endTime } = req.body as {
      title?:       string
      description?: string | null
      location?:    string | null
      startTime?:   string
      endTime?:     string
    }

    const setClauses: string[] = []
    const params: unknown[]    = []
    let idx = 1

    if (title !== undefined) {
      if (!title.trim()) {
        res.status(400).json({ success: false, error: 'Title cannot be empty', code: 'invalid_title', statusCode: 400 })
        return
      }
      setClauses.push(`title = $${idx++}`)
      params.push(title.trim())
    }
    if (description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(description ?? null) }
    if (location    !== undefined) { setClauses.push(`location    = $${idx++}`); params.push(location    ?? null) }

    if (startTime !== undefined || endTime !== undefined) {
      // Need both or neither for validation
      const start = startTime ? new Date(startTime) : null
      const end   = endTime   ? new Date(endTime)   : null
      if ((start && isNaN(start.getTime())) || (end && isNaN(end.getTime()))) {
        res.status(400).json({ success: false, error: 'Invalid date format', code: 'invalid_times', statusCode: 400 })
        return
      }
      if (start) { setClauses.push(`start_time = $${idx++}`); params.push(start) }
      if (end)   { setClauses.push(`end_time   = $${idx++}`); params.push(end)   }
    }

    if (setClauses.length === 0) {
      res.status(400).json({ success: false, error: 'Nothing to update', code: 'nothing_to_update', statusCode: 400 })
      return
    }

    params.push(eventId)
    await query(
      `UPDATE events SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      params,
    )

    // Return full updated event
    const { rows } = await query<EventRow>(
      `${EVENT_SELECT}
       WHERE e.id = $1
       GROUP BY e.id, lm.mom_session_id, lm.mom_status`,
      [eventId],
    )

    const updated = formatEvent(rows[0])
    res.json({ success: true, data: updated })

    // ── Send update invitations (non-fatal) ──────────────────────────────────
    // Build attendee list from the freshly-fetched event row.
    // Exclude the organiser (they already know — they made the change).
    try {
      const attendeeObjs = (rows[0].attendees ?? [])
        .filter((a: AttendeeShape) => a.email.toLowerCase() !== rows[0].organizer_email.toLowerCase())
        .map((a: AttendeeShape) => ({ email: a.email, name: a.name || a.email.split('@')[0] }))

      const { rows: orgRows } = await query<{ name: string }>(
        `SELECT COALESCE(name, email) AS name FROM users WHERE email = $1`,
        [rows[0].organizer_email],
      )
      const organizerName = orgRows[0]?.name ?? rows[0].organizer_email.split('@')[0]

      sendEventInviteEmail({
        uid:            eventId,
        title:          updated.title,
        description:    updated.description ?? '',
        location:       updated.location    ?? '',
        startTime:      rows[0].start_time,
        endTime:        rows[0].end_time,
        organizerEmail: rows[0].organizer_email,
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
