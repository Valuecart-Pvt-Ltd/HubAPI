import { Router } from 'express'
import axios from 'axios'
import { query } from '../db'
import { requireAuth, AuthRequest } from '../middleware/auth'
import { getBoardsByEmail, getCardsByBoardAndOwner } from '../services/trelloService'

export const trelloRouter = Router()
trelloRouter.use(requireAuth)

// ─── Shared Trello API client ─────────────────────────────────────────────────

const trello = axios.create({
  baseURL: 'https://api.trello.com/1',
  params: {
    key:   process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
  },
})

// ─── Shared types ─────────────────────────────────────────────────────────────

type MomItemStatus = 'pending' | 'in-progress' | 'completed'

interface MomItemWithCard {
  id:                       string
  serial_number:            number
  category:                 string
  action_item:              string
  owner_email:              string | null
  eta:                      Date   | null
  status:                   MomItemStatus
  trello_card_id:           string
  trello_checklist_item_id: string | null
}

function formatItem(r: MomItemWithCard, overrideStatus?: MomItemStatus) {
  return {
    id:           r.id,
    serialNumber: r.serial_number,
    category:     r.category,
    actionItem:   r.action_item,
    ownerEmail:   r.owner_email,
    eta:          r.eta ? new Date(r.eta).toISOString().split('T')[0] : null,
    status:       overrideStatus ?? r.status,
    trelloCardId: r.trello_card_id,
  }
}

/**
 * Map a Trello checklist item state → our status enum.
 * - complete   → 'completed'
 * - incomplete → 'pending' if the item was previously completed (un-checked in Trello)
 * - incomplete → keep existing status otherwise (e.g. 'in-progress' stays)
 */
function resolveChecklistStatus(state: 'complete' | 'incomplete', current: MomItemStatus): MomItemStatus {
  if (state === 'complete') return 'completed'
  if (current === 'completed') return 'pending'  // was un-checked in Trello
  return current
}

/**
 * Legacy: map Trello card's dueComplete flag → our status enum.
 * Used for items that pre-date the checklist migration (no checklist_item_id stored).
 */
function resolveStatus(dueComplete: boolean, current: MomItemStatus): MomItemStatus {
  if (dueComplete) return 'completed'
  if (current === 'completed') return 'pending'
  return current
}

// ─── Helper: verify event membership ─────────────────────────────────────────

async function assertEventAccess(
  eventId:   string,
  userEmail: string,
): Promise<void> {
  const { rows } = await query<{ organizer_email: string; is_attendee: boolean }>(
    `SELECT e.organizer_email,
       EXISTS(
         SELECT 1 FROM event_attendees ea
         WHERE ea.event_id = e.id AND ea.email = $2
       ) AS is_attendee
     FROM events e WHERE e.id = $1`,
    [eventId, userEmail],
  )

  if (!rows[0]) {
    const err = new Error('Event not found') as Error & { statusCode: number }
    err.statusCode = 404
    throw err
  }
  if (rows[0].organizer_email !== userEmail && !rows[0].is_attendee) {
    const err = new Error('Forbidden') as Error & { statusCode: number }
    err.statusCode = 403
    throw err
  }
}

// ─── GET /api/trello/cards/:eventId ──────────────────────────────────────────
//
// For every mom_item linked to this event that has a trello_card_id:
//   1. Fetch the card's current dueComplete flag from Trello.
//   2. Derive the new status (see resolveStatus).
//   3. Persist any status changes to mom_items.
//   4. Return all linked items with fresh statuses.

trelloRouter.get('/cards/:eventId', async (req: AuthRequest, res, next) => {
  try {
    const userEmail = req.user!.email
    const { eventId } = req.params

    try {
      await assertEventAccess(eventId, userEmail)
    } catch (e: unknown) {
      const err = e as Error & { statusCode?: number }
      res.status(err.statusCode ?? 500).json({
        success: false, error: err.message, code: err.statusCode === 403 ? 'forbidden' : 'event_not_found', statusCode: err.statusCode ?? 500,
      })
      return
    }

    // Fetch MOM items that have a Trello card linked
    const { rows: items } = await query<MomItemWithCard>(
      `SELECT mi.id, mi.serial_number, mi.category, mi.action_item,
              mi.owner_email, mi.eta, mi.status,
              mi.trello_card_id, mi.trello_checklist_item_id
       FROM mom_items mi
       JOIN mom_sessions ms ON ms.id = mi.mom_session_id
       WHERE ms.event_id = $1
         AND mi.trello_card_id IS NOT NULL
       ORDER BY mi.serial_number ASC`,
      [eventId],
    )

    if (items.length === 0) {
      res.json({ success: true, data: { updated: 0, items: [] } })
      return
    }

    // Split into checklist-based items (new) and legacy card-level items (old)
    const checklistItems = items.filter((it) => it.trello_checklist_item_id)
    const legacyItems    = items.filter((it) => !it.trello_checklist_item_id)

    const statusMap = new Map<string, MomItemStatus>()

    // ── Checklist items: batch by card, fetch checkItemStates once per card ──
    if (checklistItems.length > 0) {
      const uniqueCardIds = [...new Set(checklistItems.map((it) => it.trello_card_id))]

      // Map checklistItemId → 'complete' | 'incomplete'
      const checkItemStateMap = new Map<string, 'complete' | 'incomplete'>()

      await Promise.all(
        uniqueCardIds.map(async (cardId) => {
          try {
            const { data } = await trello.get<Array<{ idCheckItem: string; state: string }>>(
              `/cards/${cardId}/checkItemStates`,
            )
            for (const s of data) {
              checkItemStateMap.set(s.idCheckItem, s.state as 'complete' | 'incomplete')
            }
          } catch {
            // card may have been deleted — skip
          }
        }),
      )

      for (const item of checklistItems) {
        const state = checkItemStateMap.get(item.trello_checklist_item_id!)
        if (state === undefined) continue  // could not fetch — keep current
        statusMap.set(item.id, resolveChecklistStatus(state, item.status))
      }
    }

    // ── Legacy items: read card-level dueComplete flag ────────────────────────
    if (legacyItems.length > 0) {
      const legacyResults = await Promise.all(
        legacyItems.map(async (item) => {
          try {
            const { data } = await trello.get<{ id: string; dueComplete: boolean }>(
              `/cards/${item.trello_card_id}`,
              { params: { fields: 'id,dueComplete' } },
            )
            return { itemId: item.id, dueComplete: data.dueComplete }
          } catch {
            return null
          }
        }),
      )

      legacyItems.forEach((item, i) => {
        const result = legacyResults[i]
        if (!result) return
        statusMap.set(item.id, resolveStatus(result.dueComplete, item.status))
      })
    }

    // Compute new statuses and persist changes
    let updatedCount = 0

    await Promise.all(
      items.map(async (item) => {
        const newStatus = statusMap.get(item.id)
        if (!newStatus || newStatus === item.status) return

        updatedCount++
        await query(
          `UPDATE mom_items SET status = $1, updated_at = NOW() WHERE id = $2`,
          [newStatus, item.id],
        ).catch(() => { /* non-fatal — return stale data */ })
      }),
    )

    res.json({
      success: true,
      data: {
        updated: updatedCount,
        items:   items.map((item) => formatItem(item, statusMap.get(item.id))),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/trello/boards ───────────────────────────────────────────────────
//
// Returns all Trello boards the logged-in user has access to.
// Uses the user's trello_member_id from the DB; falls back to [] when not set.
// Caches results in trello_mappings (see getBoardsByEmail).

trelloRouter.get('/boards', async (req: AuthRequest, res, next) => {
  try {
    const email  = req.user!.email
    const boards = await getBoardsByEmail(email)

    // Annotate each board with whether it is currently primary
    const { rows: primRows } = await query<{ trello_board_id: string }>(
      `SELECT trello_board_id FROM trello_mappings
       WHERE user_email = $1 AND is_primary = TRUE LIMIT 1`,
      [email],
    )
    const primaryId = primRows[0]?.trello_board_id ?? null

    const annotated = boards.map((b) => ({
      ...b,
      isPrimary: b.boardId === primaryId,
    }))

    res.json({ success: true, data: annotated })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/trello/primary-board ──────────────────────────────────────────
//
// Sets the given boardId as the user's primary Trello board.
// Clears is_primary on all other boards for this user first.

trelloRouter.post('/primary-board', async (req: AuthRequest, res, next) => {
  try {
    const email   = req.user!.email
    const { boardId } = req.body as { boardId: string }

    if (!boardId) {
      res.status(400).json({ success: false, error: 'boardId is required', code: 'missing_board_id', statusCode: 400 })
      return
    }

    // Clear all primaries for this user, then set the new one
    await query(
      `UPDATE trello_mappings SET is_primary = FALSE WHERE user_email = $1`,
      [email],
    )
    await query(
      `UPDATE trello_mappings SET is_primary = TRUE
       WHERE user_email = $1 AND trello_board_id = $2`,
      [email, boardId],
    )

    res.json({ success: true, data: { primaryBoardId: boardId } })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/trello/board-cards ─────────────────────────────────────────────
//
// Returns card names for a board, filtered to the owner's list when ownerEmail
// is provided. Used to populate the Category dropdown in the MOM editor.

trelloRouter.get('/board-cards', async (req: AuthRequest, res, next) => {
  try {
    const { boardId, ownerEmail } = req.query as { boardId?: string; ownerEmail?: string }
    if (!boardId) {
      res.status(400).json({ success: false, error: 'boardId is required', code: 'missing_board_id', statusCode: 400 })
      return
    }
    const cards = await getCardsByBoardAndOwner(boardId, ownerEmail ?? null)
    res.json({ success: true, data: cards })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/trello/link ────────────────────────────────────────────────────
//
// Dual-purpose endpoint:
//
//   1. Set trello_member_id on the user (enables board lookup via Trello API):
//        body: { memberId: "trello_username_or_id" }
//
//   2. Manually link a Trello board+list to an email address in trello_mappings:
//        body: { boardId, boardName, listId?, listName?, userEmail? }
//
// Both actions can be combined in a single request.

trelloRouter.post('/link', async (req: AuthRequest, res, next) => {
  try {
    const actor = req.user!
    const {
      memberId,
      boardId,
      boardName,
      listId,
      userEmail = actor.email,
    } = req.body as {
      memberId?:  string
      boardId?:   string
      boardName?: string
      listId?:    string
      listName?:  string  // stored in name column of whatever, not in DB yet — accepted but unused
      userEmail?: string
    }

    if (!memberId && !boardId) {
      res.status(400).json({
        success: false,
        error:   'Provide at least one of: memberId, boardId',
        code:    'missing_fields',
        statusCode: 400,
      })
      return
    }

    // ── 1. Persist Trello member ID + auto-set department from primary board ──
    if (memberId) {
      await query(
        `UPDATE users SET trello_member_id = $1 WHERE id = $2`,
        [memberId.trim(), actor.userId],
      )

      // Fetch boards to populate trello_mappings, then set department to primary board name
      try {
        await getBoardsByEmail(actor.email)

        // Pick the board with a list already configured (highest priority), else first board
        const { rows: primaryBoard } = await query<{ trello_board_name: string }>(
          `SELECT trello_board_name FROM trello_mappings
           WHERE user_email = $1
           ORDER BY (trello_list_id IS NOT NULL) DESC, trello_board_id
           LIMIT 1`,
          [actor.email],
        )

        if (primaryBoard[0]) {
          await query(
            `UPDATE users SET department = $1 WHERE id = $2`,
            [primaryBoard[0].trello_board_name, actor.userId],
          )
        }
      } catch {
        // Non-fatal — department update is best-effort
      }
    }

    // ── 2. Upsert board mapping ───────────────────────────────────────────────
    if (boardId) {
      if (!boardName) {
        res.status(400).json({
          success: false,
          error:   'boardName is required when linking a board',
          code:    'missing_fields',
          statusCode: 400,
        })
        return
      }

      await query(
        `INSERT INTO trello_mappings (user_email, trello_board_id, trello_board_name, trello_list_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_email, trello_board_id) DO UPDATE
           SET trello_board_name = EXCLUDED.trello_board_name,
               trello_list_id    = COALESCE(EXCLUDED.trello_list_id, trello_mappings.trello_list_id)`,
        [userEmail, boardId, boardName, listId ?? null],
      )
    }

    res.json({ success: true, data: { memberId: memberId ?? null, boardId: boardId ?? null } })
  } catch (err) {
    next(err)
  }
})
