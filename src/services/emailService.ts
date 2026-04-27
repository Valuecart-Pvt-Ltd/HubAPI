import nodemailer from 'nodemailer'
import { format }  from 'date-fns'

// ─── Transporter ──────────────────────────────────────────────────────────────

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',   // true for port 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MomEmailItem {
  serialNumber: number
  category:     string
  actionItem:   string
  ownerEmail:   string | null
  eta:          string | null  // YYYY-MM-DD
  status:       'pending' | 'in-progress' | 'completed'
}

export interface SendMomEmailOptions {
  eventTitle:     string
  eventStart:     Date
  eventEnd:       Date
  organizerEmail: string
  attendeeEmails: string[]
  items:          MomEmailItem[]
  finalizedBy:    string
}

// ─── Status styles ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  'pending':     'Pending',
  'in-progress': 'In Progress',
  'completed':   'Completed',
}

const STATUS_COLOR: Record<string, string> = {
  'pending':     '#6B7280',
  'in-progress': '#D97706',
  'completed':   '#059669',
}

const STATUS_BG: Record<string, string> = {
  'pending':     '#F3F4F6',
  'in-progress': '#FFFBEB',
  'completed':   '#ECFDF5',
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHtml(opts: SendMomEmailOptions): string {
  const { eventTitle, eventStart, eventEnd, organizerEmail, attendeeEmails, items, finalizedBy } = opts

  const validItems = items.filter((it) => it.actionItem.trim())

  const itemRows = validItems.map((item, i) => `
    <tr style="background:${i % 2 === 0 ? '#1A1830' : '#161428'};border-top:1px solid #2D2A50">
      <td style="padding:10px 14px;font-size:12px;color:#6D5FA6;font-family:monospace;white-space:nowrap">${item.serialNumber}</td>
      <td style="padding:10px 14px;font-size:13px;color:#E9D5FF;font-weight:500">${item.actionItem}</td>
      <td style="padding:10px 14px;font-size:12px;color:#A78BFA;white-space:nowrap">${item.ownerEmail ? item.ownerEmail.split('@')[0] : '—'}</td>
      <td style="padding:10px 14px;font-size:12px;color:#A78BFA;white-space:nowrap">${item.eta ? format(new Date(item.eta), 'd MMM yyyy') : '—'}</td>
    </tr>
  `).join('')

  const attendeeList = [...new Set([organizerEmail, ...attendeeEmails])]
    .map((e) => e.split('@')[0])
    .join(', ')

  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0F0E1A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0E1A;padding:32px 16px">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;border-radius:14px;overflow:hidden">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2D1B69,#5B21B6);padding:28px 32px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">
              📋 Minutes of Meeting
            </div>
            <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px">
              Finalized · Karya
            </div>
          </td>
        </tr>

        <!-- Event info -->
        <tr>
          <td style="background:#1A1830;padding:24px 32px;border-left:1px solid #2D2A50;border-right:1px solid #2D2A50">
            <h2 style="margin:0 0 10px;font-size:20px;font-weight:700;color:#F5F3FF">${eventTitle}</h2>
            <p style="margin:0 0 4px;font-size:13px;color:#A78BFA">
              📅 ${format(new Date(eventStart), 'EEEE, d MMMM yyyy')}
              &nbsp;·&nbsp;
              🕐 ${format(new Date(eventStart), 'HH:mm')} – ${format(new Date(eventEnd), 'HH:mm')}
            </p>
            <p style="margin:10px 0 0;font-size:12px;color:#7C6FAE">
              Finalized by <strong style="color:#C4B5FD">${finalizedBy.split('@')[0]}</strong>
            </p>
          </td>
        </tr>

        <!-- Attendees -->
        <tr>
          <td style="background:#161428;padding:14px 32px;border-left:1px solid #2D2A50;border-right:1px solid #2D2A50;border-top:1px solid #2D2A50">
            <p style="margin:0 0 6px;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.8px">Attendees</p>
            <p style="margin:0;font-size:13px;color:#C4B5FD">${attendeeList}</p>
          </td>
        </tr>

        <!-- MOM items -->
        <tr>
          <td style="background:#1A1830;padding:24px 32px;border-left:1px solid #2D2A50;border-right:1px solid #2D2A50;border-top:1px solid #2D2A50">
            <p style="margin:0 0 14px;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.8px">Action Items</p>
            ${validItems.length === 0
              ? `<p style="color:#6D5FA6;font-size:13px;text-align:center;padding:24px 0">No action items recorded.</p>`
              : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #2D2A50;border-radius:8px;overflow:hidden">
                  <thead>
                    <tr style="background:#12102A">
                      <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">#</th>
                      <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px">Action Item</th>
                      <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">Owner</th>
                      <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">ETA</th>
                    </tr>
                  </thead>
                  <tbody>${itemRows}</tbody>
                </table>`
            }
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#12102A;padding:16px 32px;border:1px solid #2D2A50;border-top:none;text-align:center">
            <p style="margin:0;font-size:11px;color:#6D5FA6">
              Automated notification from <strong style="color:#A78BFA">Karya</strong>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
  `.trim()
}

// ─── Plain-text fallback ──────────────────────────────────────────────────────

function buildText(opts: SendMomEmailOptions): string {
  const { eventTitle, eventStart, eventEnd, items, finalizedBy } = opts
  const validItems = items.filter((it) => it.actionItem.trim())

  const lines = [
    `MINUTES OF MEETING — ${eventTitle}`,
    `Date: ${format(new Date(eventStart), 'EEEE, d MMMM yyyy')} · ${format(new Date(eventStart), 'HH:mm')}–${format(new Date(eventEnd), 'HH:mm')}`,
    `Finalized by: ${finalizedBy}`,
    '',
    'ACTION ITEMS',
    '─'.repeat(60),
  ]

  validItems.forEach((item) => {
    lines.push(
      `${item.serialNumber}. [${item.category || 'Uncategorized'}] ${item.actionItem}`,
      `   Owner: ${item.ownerEmail ?? '—'}  |  ETA: ${item.eta ?? '—'}`,
    )
  })

  lines.push('', '─'.repeat(60), 'Karya — automated notification')
  return lines.join('\n')
}

// ─── Reminder email ───────────────────────────────────────────────────────────

export interface ReminderEmailItem {
  serialNumber: number
  actionItem:   string
  ownerEmail:   string | null
  eta:          string | null   // YYYY-MM-DD
  status:       'pending' | 'in-progress' | 'completed'
}

export interface SendReminderEmailOptions {
  eventTitle:     string
  eventStart:     Date
  eventEnd:       Date
  organizerEmail: string
  attendeeEmails: string[]
  previousMomDate?: Date          // undefined = not a recurring meeting
  previousMomItems?: ReminderEmailItem[]
}

function buildReminderHtml(opts: SendReminderEmailOptions): string {
  const { eventTitle, eventStart, eventEnd, organizerEmail, attendeeEmails, previousMomDate, previousMomItems } = opts

  const attendeeList = [...new Set([organizerEmail, ...attendeeEmails])]
    .map((e) => e.split('@')[0])
    .join(', ')

  const hasPrevMom = previousMomDate && previousMomItems && previousMomItems.length > 0

  const prevRows = hasPrevMom
    ? previousMomItems!.map((item, i) => {
        const bg       = i % 2 === 0 ? '#1A1830' : '#161428'
        const sColor   = STATUS_COLOR[item.status] ?? '#6B7280'
        const sBg      = STATUS_BG[item.status]    ?? '#F3F4F6'
        const sLabel   = STATUS_LABEL[item.status] ?? item.status
        return `
    <tr style="background:${bg};border-top:1px solid #2D2A50">
      <td style="padding:10px 14px;font-size:12px;color:#6D5FA6;font-family:monospace;white-space:nowrap">${item.serialNumber}</td>
      <td style="padding:10px 14px;font-size:13px;color:#E9D5FF;font-weight:500">${item.actionItem}</td>
      <td style="padding:10px 14px;font-size:12px;color:#A78BFA;white-space:nowrap">${item.ownerEmail ? item.ownerEmail.split('@')[0] : '—'}</td>
      <td style="padding:10px 14px;font-size:12px;color:#A78BFA;white-space:nowrap">${item.eta ? format(new Date(item.eta), 'd MMM yyyy') : '—'}</td>
      <td style="padding:10px 14px;white-space:nowrap">
        <span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:${sBg};color:${sColor}">${sLabel}</span>
      </td>
    </tr>`
      }).join('')
    : ''

  const prevMomSection = hasPrevMom ? `
        <!-- Previous MOM -->
        <tr>
          <td style="background:#1A1830;padding:24px 32px;border-left:1px solid #2D2A50;border-right:1px solid #2D2A50;border-top:1px solid #2D2A50">
            <p style="margin:0 0 4px;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.8px">Previous MOM</p>
            <p style="margin:0 0 14px;font-size:12px;color:#7C6FAE">From meeting on ${format(previousMomDate!, 'EEEE, d MMMM yyyy')}</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #2D2A50;border-radius:8px;overflow:hidden">
              <thead>
                <tr style="background:#12102A">
                  <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">#</th>
                  <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px">Action Item</th>
                  <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">Owner</th>
                  <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap">ETA</th>
                  <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.5px">Status</th>
                </tr>
              </thead>
              <tbody>${prevRows}</tbody>
            </table>
          </td>
        </tr>` : ''

  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0F0E1A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0F0E1A;padding:32px 16px">
    <tr><td align="center">
      <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;border-radius:14px;overflow:hidden">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1E3A5F,#1D4ED8);padding:28px 32px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px">
              📅 Meeting Reminder
            </div>
            <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px">
              In 2 days · Karya
            </div>
          </td>
        </tr>

        <!-- Event info -->
        <tr>
          <td style="background:#1A1830;padding:24px 32px;border-left:1px solid #2D2A50;border-right:1px solid #2D2A50">
            <h2 style="margin:0 0 10px;font-size:20px;font-weight:700;color:#F5F3FF">${eventTitle}</h2>
            <p style="margin:0 0 4px;font-size:13px;color:#93C5FD">
              📅 ${format(eventStart, 'EEEE, d MMMM yyyy')}
              &nbsp;·&nbsp;
              🕐 ${format(eventStart, 'HH:mm')} – ${format(eventEnd, 'HH:mm')}
            </p>
          </td>
        </tr>

        <!-- Attendees -->
        <tr>
          <td style="background:#161428;padding:14px 32px;border-left:1px solid #2D2A50;border-right:1px solid #2D2A50;border-top:1px solid #2D2A50">
            <p style="margin:0 0 6px;font-size:10px;font-weight:600;color:#6D5FA6;text-transform:uppercase;letter-spacing:0.8px">Attendees</p>
            <p style="margin:0;font-size:13px;color:#C4B5FD">${attendeeList}</p>
          </td>
        </tr>

        ${prevMomSection}

        <!-- Footer -->
        <tr>
          <td style="background:#12102A;padding:16px 32px;border:1px solid #2D2A50;border-top:none;text-align:center">
            <p style="margin:0;font-size:11px;color:#6D5FA6">
              Automated reminder from <strong style="color:#A78BFA">Karya</strong>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`.trim()
}

function buildReminderText(opts: SendReminderEmailOptions): string {
  const { eventTitle, eventStart, eventEnd, previousMomDate, previousMomItems } = opts
  const lines = [
    `MEETING REMINDER — ${eventTitle}`,
    `Date: ${format(eventStart, 'EEEE, d MMMM yyyy')} · ${format(eventStart, 'HH:mm')}–${format(eventEnd, 'HH:mm')}`,
    `This meeting is in 2 days.`,
  ]

  if (previousMomDate && previousMomItems && previousMomItems.length > 0) {
    lines.push('', `PREVIOUS MOM — ${format(previousMomDate, 'EEEE, d MMMM yyyy')}`, '─'.repeat(60))
    previousMomItems.forEach((item) => {
      lines.push(
        `${item.serialNumber}. ${item.actionItem}`,
        `   Owner: ${item.ownerEmail ?? '—'}  |  ETA: ${item.eta ?? '—'}  |  Status: ${STATUS_LABEL[item.status] ?? item.status}`,
      )
    })
  }

  lines.push('', '─'.repeat(60), 'Karya — automated reminder')
  return lines.join('\n')
}

export async function sendReminderEmail(opts: SendReminderEmailOptions): Promise<void> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[email] SMTP not configured — skipping reminder email')
    return
  }

  const recipients = [...new Set([opts.organizerEmail, ...opts.attendeeEmails])]
  if (recipients.length === 0) return

  const transporter = createTransporter()

  await transporter.sendMail({
    from:    `"Karya" <${process.env.SMTP_USER}>`,
    to:      recipients.join(', '),
    subject: `📅 Reminder: ${opts.eventTitle} in 2 days`,
    text:    buildReminderText(opts),
    html:    buildReminderHtml(opts),
  })

  console.log(`[email] Reminder sent to ${recipients.length} recipients for "${opts.eventTitle}"`)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendMomFinalizedEmail(opts: SendMomEmailOptions): Promise<void> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[email] SMTP_USER / SMTP_PASS not configured — skipping MOM email')
    return
  }

  const recipients = [...new Set([opts.organizerEmail, ...opts.attendeeEmails])]
  if (recipients.length === 0) return

  const transporter = createTransporter()

  await transporter.sendMail({
    from:    `"Karya" <${process.env.SMTP_USER}>`,
    to:      recipients.join(', '),
    subject: `📋 MOM Finalized: ${opts.eventTitle}`,
    text:    buildText(opts),
    html:    buildHtml(opts),
  })

  console.log(`[email] MOM finalized email sent to ${recipients.length} recipients for "${opts.eventTitle}"`)
}

// ─── Calendar invite (.ics) ───────────────────────────────────────────────────

export interface EventInviteOptions {
  uid:            string      // event UUID
  title:          string
  description:    string
  location:       string
  startTime:      Date
  endTime:        Date
  organizerEmail: string
  organizerName:  string
  attendees:      { email: string; name: string }[]
  /** SEQUENCE number for iCalendar updates. 0 = new invite, 1+ = update. Default: 0 */
  sequence?:      number
  /** When true the email subject + header say "Updated" instead of "Invite". Default: false */
  isUpdate?:      boolean
}

/** Escape text for ICS: backslash, comma, semicolon, newlines */
function icsEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
}

function toICSDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function buildICS(opts: EventInviteOptions): string {
  const now = toICSDate(new Date())
  const dtStart = toICSDate(opts.startTime)
  const dtEnd   = toICSDate(opts.endTime)

  const attendeeLines = opts.attendees
    .map((a) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${icsEscape(a.name || a.email)}:mailto:${a.email}`)
    .join('\r\n')

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ValueCart MOM//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${opts.uid}@valuecart`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(opts.description || '')}`,
    `LOCATION:${icsEscape(opts.location || '')}`,
    `ORGANIZER;CN=${icsEscape(opts.organizerName || opts.organizerEmail)}:mailto:${opts.organizerEmail}`,
    attendeeLines,
    'STATUS:CONFIRMED',
    `SEQUENCE:${opts.sequence ?? 0}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
}

export async function sendEventInviteEmail(opts: EventInviteOptions): Promise<void> {
  if (!opts.attendees.length) return

  const ics         = buildICS(opts)
  const dateStr     = format(opts.startTime, 'EEEE, d MMMM yyyy')
  const timeStr     = `${format(opts.startTime, 'HH:mm')} – ${format(opts.endTime, 'HH:mm')}`
  const allEmails   = [...new Set([opts.organizerEmail, ...opts.attendees.map((a) => a.email)])]
  const attendeeListHtml = opts.attendees.map((a) =>
    `<li style="margin:2px 0;color:#C4B5FD">${a.name || a.email.split('@')[0]} &lt;${a.email}&gt;</li>`,
  ).join('')

  const isUpdate    = opts.isUpdate ?? false
  const inviteLabel = isUpdate ? 'Meeting Updated' : 'Meeting Invite'
  const inviteBadge = isUpdate ? 'Updated Invite' : 'Meeting Invite'

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0F0D1F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#1A1830;border-radius:12px;overflow:hidden;border:1px solid #2D2A50">
    <div style="background:linear-gradient(135deg,#D81B72,#9B59B6);padding:28px 32px">
      <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,0.7)">${inviteBadge}</p>
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#fff">${opts.title}</h1>
    </div>
    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr><td style="padding:8px 0;font-size:12px;color:#7C6FAE;width:80px">Date</td>
            <td style="padding:8px 0;font-size:14px;color:#E9D5FF;font-weight:500">${dateStr}</td></tr>
        <tr><td style="padding:8px 0;font-size:12px;color:#7C6FAE">Time</td>
            <td style="padding:8px 0;font-size:14px;color:#E9D5FF;font-weight:500">${timeStr}</td></tr>
        <tr><td style="padding:8px 0;font-size:12px;color:#7C6FAE">Organizer</td>
            <td style="padding:8px 0;font-size:14px;color:#E9D5FF">${opts.organizerName || opts.organizerEmail}</td></tr>
        ${opts.location ? `<tr><td style="padding:8px 0;font-size:12px;color:#7C6FAE">Location</td>
            <td style="padding:8px 0;font-size:14px;color:#E9D5FF">${opts.location}</td></tr>` : ''}
      </table>
      ${opts.description ? `<p style="font-size:13px;color:#A78BFA;line-height:1.6;margin:0 0 20px">${opts.description.replace(/\n/g, '<br>')}</p>` : ''}
      <div style="background:#13112A;border-radius:8px;padding:16px">
        <p style="margin:0 0 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#6D5FA6">Attendees</p>
        <ul style="margin:0;padding:0 0 0 18px;font-size:13px">${attendeeListHtml}</ul>
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#4A4270">
        A calendar invite (.ics) is attached. Open it to add this meeting to your calendar.
      </p>
    </div>
  </div>
</body>
</html>`

  const text = [
    `${inviteLabel}: ${opts.title}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    opts.location ? `Location: ${opts.location}` : '',
    `Organizer: ${opts.organizerEmail}`,
    opts.description ? `\n${opts.description}` : '',
    `\nAttendees:\n${opts.attendees.map((a) => `  - ${a.email}`).join('\n')}`,
    '\nA calendar invite is attached.',
  ].filter(Boolean).join('\n')

  const transporter = createTransporter()
  await transporter.sendMail({
    from:    `"Karya" <${process.env.SMTP_USER}>`,
    to:      allEmails.join(', '),
    subject: `📅 ${inviteLabel}: ${opts.title} — ${dateStr}`,
    text,
    html,
    attachments: [{
      filename:    'invite.ics',
      content:     ics,
      contentType: 'text/calendar; method=REQUEST',
    }],
  })

  console.log(`[email] ${inviteLabel} sent to ${allEmails.length} recipients for "${opts.title}"`)
}

// ─── Workspace invitation (Kaarya, Phase 6) ──────────────────────────────────

interface WorkspaceInvitationOptions {
  to:             string
  workspaceName:  string
  inviterName:    string
  acceptUrl:      string
  expiresAt:      Date
}

export async function sendWorkspaceInvitationEmail(opts: WorkspaceInvitationOptions): Promise<void> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn('[email] SMTP not configured — skipping invitation email')
    return
  }
  const transporter = createTransporter()

  const expiresStr = opts.expiresAt.toUTCString()
  const subject = `${opts.inviterName} invited you to "${opts.workspaceName}" on Kaarya`

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#2D2361;max-width:520px;margin:0 auto;padding:24px">
  <p style="font-size:11px;font-weight:bold;color:#F0841C;letter-spacing:.08em">VALUECART KAARYA</p>
  <h1 style="font-size:22px;margin:8px 0 16px">You've been invited to <span style="color:#F0841C">${escapeInviteHtml(opts.workspaceName)}</span></h1>
  <p style="font-size:14px;line-height:1.6">${escapeInviteHtml(opts.inviterName)} has invited you to join their Kaarya workspace.</p>
  <p style="margin:24px 0">
    <a href="${opts.acceptUrl}" style="display:inline-block;padding:12px 24px;background:#1F2937;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Accept invitation</a>
  </p>
  <p style="font-size:12px;color:#6B7280">Or paste this link into your browser:<br/><span style="word-break:break-all">${opts.acceptUrl}</span></p>
  <p style="font-size:12px;color:#9CA3AF;margin-top:24px">This invitation expires on ${expiresStr}.</p>
</div>`.trim()

  await transporter.sendMail({
    from:    process.env.SMTP_USER,
    to:      opts.to,
    subject,
    html,
  })

  console.log(`[email] workspace invitation sent to ${opts.to}`)
}

function escapeInviteHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
