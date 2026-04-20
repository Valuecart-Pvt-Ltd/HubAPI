import axios from 'axios'
import { query } from '../db'

// ─── Public types ─────────────────────────────────────────────────────────────

/** Minimal board descriptor returned by getBoardsByEmail. */
export interface TrelloBoard {
  boardId:   string
  boardName: string
}

/**
 * Full mapping record — includes the default list when one has been resolved.
 * trelloListId is null when only the board has been cached (no list selected yet).
 */
export interface TrelloBoardInfo {
  trelloBoardId:   string
  trelloBoardName: string
  trelloListId:    string | null
}

export interface TrelloList {
  listId:   string
  listName: string
}

// ─── Axios client ─────────────────────────────────────────────────────────────
//
// key + token are injected into every request as default query params.

const trello = axios.create({
  baseURL: 'https://api.trello.com/1',
  params: {
    key:   process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
  },
})

/** Translate an Axios error into a descriptive thrown Error; always throws. */
function trelloError(err: unknown, ctx: string): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? '?'
    const body   = JSON.stringify(err.response?.data ?? err.message)
    throw new Error(`Trello [${ctx}] ${status}: ${body}`)
  }
  throw err
}

// ─── 1. getBoardsByEmail ──────────────────────────────────────────────────────
//
// Calls GET /members/{id}/boards using the user's trello_member_id, caches
// each board in trello_mappings (trello_list_id = NULL), and returns the list.

export async function getBoardsByEmail(email: string): Promise<TrelloBoard[]> {
  // Resolve Trello member ID from our DB
  const { rows: userRows } = await query<{ trello_member_id: string | null }>(
    `SELECT trello_member_id FROM users WHERE email = $1 LIMIT 1`,
    [email],
  )

  const memberId = userRows[0]?.trello_member_id
  if (!memberId) {
    console.warn(`[trello] No trello_member_id stored for ${email} — skipping board lookup`)
    return []
  }

  // Fetch open boards from Trello
  const boards = await trello
    .get<Array<{ id: string; name: string }>>(`/members/${memberId}/boards`, {
      params: { fields: 'id,name', filter: 'open' },
    })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `GET /members/${memberId}/boards`))

  // Cache every board in trello_mappings (best-effort — skipped if migration 002 hasn't run)
  await Promise.all(
    boards.map((b) =>
      query(
        `INSERT INTO trello_mappings (user_email, trello_board_id, trello_board_name, trello_list_id)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (user_email, trello_board_id) DO UPDATE
           SET trello_board_name = EXCLUDED.trello_board_name`,
        [email, b.id, b.name],
      ).catch(() => {
        /* non-fatal — migration may not have run yet */
      }),
    ),
  )

  // Deduplicate by board ID (trello_mappings may have multiple rows per board)
  const unique = Array.from(new Map(boards.map((b) => [b.id, b])).values())
  return unique.map((b) => ({ boardId: b.id, boardName: b.name }))
}

// ─── 2. getBoardByEmail ───────────────────────────────────────────────────────
//
// Returns the primary board for an email address.  Tries the local cache first;
// falls back to a live Trello API call via getBoardsByEmail.

export async function getBoardByEmail(email: string): Promise<TrelloBoardInfo | null> {
  // DB-first: cheapest path
  const { rows } = await query<{
    trello_board_id:   string
    trello_board_name: string
    trello_list_id:    string | null
  }>(
    `SELECT trello_board_id, trello_board_name, trello_list_id
     FROM trello_mappings
     WHERE user_email = $1
     ORDER BY is_primary DESC, (trello_list_id IS NOT NULL) DESC, trello_board_id
     LIMIT 1`,
    [email],
  )

  if (rows[0]) {
    return {
      trelloBoardId:   rows[0].trello_board_id,
      trelloBoardName: rows[0].trello_board_name,
      trelloListId:    rows[0].trello_list_id,
    }
  }

  // API fallback — also populates the cache for next time
  const boards = await getBoardsByEmail(email)
  if (boards.length === 0) return null

  return {
    trelloBoardId:   boards[0].boardId,
    trelloBoardName: boards[0].boardName,
    trelloListId:    null,
  }
}

// ─── 3. getCardsByBoardAndOwner ───────────────────────────────────────────────
//
// Fetches open card names from the owner's specific list on a board.
// Resolution order:
//   1. DB-cached trello_list_id in trello_mappings (most reliable)
//   2. Name-match against the owner's display name (from users table) or email username
//   3. Return [] — never dumps all board cards when no list can be identified

export async function getCardsByBoardAndOwner(
  boardId:    string,
  ownerEmail: string | null,
): Promise<string[]> {
  let listId: string | null = null

  if (ownerEmail) {
    // 1. DB-first: use stored list ID if one has been linked
    const { rows: mappingRows } = await query<{ trello_list_id: string | null }>(
      `SELECT trello_list_id FROM trello_mappings
       WHERE user_email = $1 AND trello_board_id = $2 AND trello_list_id IS NOT NULL
       LIMIT 1`,
      [ownerEmail, boardId],
    )
    listId = mappingRows[0]?.trello_list_id ?? null

    // 2. Name-match fallback: try display name then email username
    if (!listId) {
      const { rows: userRows } = await query<{ name: string | null }>(
        `SELECT name FROM users WHERE email = $1 LIMIT 1`,
        [ownerEmail],
      )
      const displayName = userRows[0]?.name?.toLowerCase().trim() ?? null
      const emailName   = ownerEmail.split('@')[0].toLowerCase()

      const lists = await trello
        .get<Array<{ id: string; name: string }>>(`/boards/${boardId}/lists`, {
          params: { fields: 'id,name', filter: 'open' },
        })
        .then((r) => r.data)
        .catch((err) => trelloError(err, `GET /boards/${boardId}/lists`))

      const match = lists.find((l) => {
        const lName = l.name.toLowerCase().trim()
        return (
          (displayName && (lName.includes(displayName) || displayName.includes(lName))) ||
          lName.includes(emailName) ||
          emailName.includes(lName)
        )
      })
      listId = match?.id ?? null

      // Cache the resolved list ID so future calls skip the name-match
      if (listId) {
        await query(
          `UPDATE trello_mappings SET trello_list_id = $1
           WHERE user_email = $2 AND trello_board_id = $3`,
          [listId, ownerEmail, boardId],
        ).catch(() => { /* non-fatal */ })
      }
    }
  }

  // 3. No list resolved → return empty (never dump entire board)
  if (!listId) return []

  const cards = await trello
    .get<Array<{ name: string }>>(`/lists/${listId}/cards`, {
      params: { fields: 'name' },
    })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `GET /lists/${listId}/cards`))

  return cards.map((c) => c.name)
}

// ─── getBoardsByEmails (batch helper — used by calendarService) ───────────────

export async function getBoardsByEmails(
  emails: string[],
): Promise<Map<string, TrelloBoardInfo>> {
  if (emails.length === 0) return new Map()

  const { rows } = await query<{
    user_email:        string
    trello_board_id:   string
    trello_board_name: string
    trello_list_id:    string | null
  }>(
    `SELECT DISTINCT ON (user_email)
       user_email, trello_board_id, trello_board_name, trello_list_id
     FROM trello_mappings
     WHERE user_email = ANY($1::text[])
     ORDER BY user_email, trello_board_id`,
    [emails],
  )

  return new Map(
    rows.map((r) => [
      r.user_email,
      {
        trelloBoardId:   r.trello_board_id,
        trelloBoardName: r.trello_board_name,
        trelloListId:    r.trello_list_id,
      },
    ]),
  )
}

// ─── 3. getOrCreateList ───────────────────────────────────────────────────────
//
// Fetches all lists on a board and returns the one matching listName
// (case-insensitive).  Creates the list when it doesn't exist yet.

export async function getOrCreateList(
  boardId:  string,
  listName: string,
): Promise<TrelloList> {
  const lists = await trello
    .get<Array<{ id: string; name: string }>>(`/boards/${boardId}/lists`, {
      params: { fields: 'id,name' },
    })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `GET /boards/${boardId}/lists`))

  const match = lists.find((l) => l.name.toLowerCase() === listName.toLowerCase())
  if (match) return { listId: match.id, listName: match.name }

  // List does not exist — create it
  const created = await trello
    .post<{ id: string; name: string }>('/lists', { name: listName, idBoard: boardId })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `POST /lists (name=${listName})`))

  return { listId: created.id, listName: created.name }
}

// ─── createTrelloCard (utility, also used internally) ────────────────────────

export async function createTrelloCard(params: {
  name:    string
  desc?:   string
  listId:  string
  due?:    string | null
}): Promise<string> {
  const card = await trello
    .post<{ id: string }>('/cards', {
      name:   params.name,
      desc:   params.desc   ?? '',
      idList: params.listId,
      due:    params.due    ?? null,
    })
    .then((r) => r.data)
    .catch((err) => trelloError(err, 'POST /cards'))

  return card.id
}

// ─── getOrCreateChecklist ─────────────────────────────────────────────────────
//
// Finds an existing checklist on a card by name (case-insensitive).
// Creates one when it doesn't exist yet.

async function getOrCreateChecklist(cardId: string, name: string): Promise<string> {
  const existing = await trello
    .get<Array<{ id: string; name: string }>>(`/cards/${cardId}/checklists`, {
      params: { fields: 'id,name' },
    })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `GET /cards/${cardId}/checklists`))

  const match = existing.find((cl) => cl.name.toLowerCase() === name.toLowerCase())
  if (match) return match.id

  const created = await trello
    .post<{ id: string }>('/checklists', { idCard: cardId, name })
    .then((r) => r.data)
    .catch((err) => trelloError(err, 'POST /checklists'))

  return created.id
}

// ─── addChecklistItem ─────────────────────────────────────────────────────────
//
// Appends an item to a checklist.  `due` is ISO-8601; `checked` marks it done.
// Returns the new checklist item's ID.

async function addChecklistItem(
  checklistId: string,
  name:        string,
  due:         string | null,
  checked:     boolean,
): Promise<string> {
  const item = await trello
    .post<{ id: string }>(`/checklists/${checklistId}/checkItems`, {
      name,
      due:     due ?? undefined,
      checked,
    })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `POST /checklists/${checklistId}/checkItems`))

  return item.id
}

// ─── 4. syncMOMToTrello ───────────────────────────────────────────────────────
//
// For each mom_item in the session that has an owner_email:
//   • Resolve the owner's Trello board (DB cache → API fallback).
//   • Group the owner's items by category — each category → one Trello card.
//   • If a card with that category name already exists on the board:
//       – Add a comment for every new action_item (those lacking trello_card_id).
//       – Extend the card's due date if any new item's ETA is later.
//   • If no matching card exists:
//       – getOrCreateList(boardId, 'Action Items') for the destination list.
//       – Create a card: title = category, desc = numbered action_items, due = latest ETA.
//   • Persist trello_card_id to every affected mom_item row.
//
// Individual failures (per-owner, per-category) are swallowed so one broken
// Trello mapping can never abort the rest of the sync.

export async function syncMOMToTrello(sessionId: string): Promise<void> {
  console.log(`[trello] syncMOMToTrello started — session=${sessionId}`)

  const { rows: items } = await query<{
    id:              string
    category:        string
    action_item:     string
    owner_email:     string | null
    eta:             Date   | null
    status:          string
    trello_card_id:  string | null
    trello_board_id: string | null
  }>(
    `SELECT id, category, action_item, owner_email, eta, status, trello_card_id, trello_board_id
     FROM mom_items
     WHERE mom_session_id = $1
     ORDER BY serial_number ASC`,
    [sessionId],
  )

  console.log(`[trello] Found ${items.length} item(s) total`)

  // Only sync items that have both an owner and a non-empty category
  const syncable = items.filter((it) => it.owner_email && it.category?.trim())
  console.log(`[trello] ${syncable.length} item(s) eligible for sync (have owner + category)`)

  if (syncable.length === 0) return

  // Group by owner
  const byOwner = new Map<string, typeof syncable>()
  for (const item of syncable) {
    const key = item.owner_email!
    if (!byOwner.has(key)) byOwner.set(key, [])
    byOwner.get(key)!.push(item)
  }

  // Collect ID updates; flushed in one batch at the end
  const cardUpdates: Array<{ itemId: string; cardId: string; checklistItemId: string }> = []

  await Promise.all(
    [...byOwner.entries()].map(async ([ownerEmail, ownerItems]) => {
      try {
        console.log(`[trello] Processing owner=${ownerEmail} items=${ownerItems.length}`)

        // Use item-level board if set, otherwise fall back to owner's primary board
        const itemWithBoard = ownerItems.find((it) => it.trello_board_id)
        let board: TrelloBoardInfo | null = null

        if (itemWithBoard?.trello_board_id) {
          const { rows: bRows } = await query<{ trello_board_name: string; trello_list_id: string | null }>(
            `SELECT trello_board_name, trello_list_id FROM trello_mappings
             WHERE trello_board_id = $1 LIMIT 1`,
            [itemWithBoard.trello_board_id],
          )
          board = {
            trelloBoardId:   itemWithBoard.trello_board_id,
            trelloBoardName: bRows[0]?.trello_board_name ?? '',
            trelloListId:    bRows[0]?.trello_list_id ?? null,
          }
        } else {
          board = await getBoardByEmail(ownerEmail)
        }

        if (!board) {
          console.warn(`[trello] No board found for ${ownerEmail} — skipping`)
          return
        }
        console.log(`[trello] Using board="${board.trelloBoardName}" (${board.trelloBoardId}) listId=${board.trelloListId ?? 'none'}`)

        // For items with explicit board overrides, re-group by their own board
        const boardGroups = new Map<string, { board: TrelloBoardInfo; items: typeof ownerItems }>()
        for (const item of ownerItems) {
          const boardId = item.trello_board_id ?? board.trelloBoardId
          if (!boardGroups.has(boardId)) {
            if (item.trello_board_id && item.trello_board_id !== board.trelloBoardId) {
              const { rows: bRows } = await query<{ trello_board_name: string; trello_list_id: string | null }>(
                `SELECT trello_board_name, trello_list_id FROM trello_mappings WHERE trello_board_id = $1 LIMIT 1`,
                [item.trello_board_id],
              )
              boardGroups.set(boardId, {
                board: { trelloBoardId: boardId, trelloBoardName: bRows[0]?.trello_board_name ?? '', trelloListId: bRows[0]?.trello_list_id ?? null },
                items: [],
              })
            } else {
              boardGroups.set(boardId, { board, items: [] })
            }
          }
          boardGroups.get(boardId)!.items.push(item)
        }

        for (const { board: itemBoard, items: boardItems } of boardGroups.values()) {
          // Fetch all open cards on this board once
          const boardCards = await trello
            .get<Array<{ id: string; name: string; due: string | null }>>(
              `/boards/${itemBoard.trelloBoardId}/cards`,
              { params: { fields: 'id,name,due', filter: 'open' } },
            )
            .then((r) => r.data)
            .catch((err) => {
              console.error(`[trello] Failed to fetch cards for board ${itemBoard.trelloBoardId}:`, err?.message ?? err)
              return [] as Array<{ id: string; name: string; due: string | null }>
            })
          console.log(`[trello] Board "${itemBoard.trelloBoardName}" has ${boardCards.length} open card(s)`)

          // Group by category
          const byCategory = new Map<string, typeof boardItems>()
          for (const item of boardItems) {
            if (!byCategory.has(item.category)) byCategory.set(item.category, [])
            byCategory.get(item.category)!.push(item)
          }

          for (const [category, catItems] of byCategory.entries()) {
            try {
              const newItems      = catItems.filter((it) => !it.trello_card_id)
              const cardFromItem  = catItems.find((it) => it.trello_card_id)
              const cardFromBoard = boardCards.find((c) => c.name.toLowerCase() === category.toLowerCase())
              const existingCardId = cardFromItem?.trello_card_id ?? cardFromBoard?.id

              console.log(`[trello] Category="${category}" existingCard=${existingCardId ?? 'none'} newItems=${newItems.length}`)

              if (newItems.length === 0) continue

              if (!existingCardId) {
                // ── New card ──────────────────────────────────────────────────
                let listId: string
                if (itemBoard.trelloListId) {
                  listId = itemBoard.trelloListId
                } else {
                  const { rows: ownerRows } = await query<{ name: string }>(
                    `SELECT name FROM users WHERE email = $1 LIMIT 1`,
                    [ownerEmail],
                  )
                  const listName = ownerRows[0]?.name ?? 'Action Items'
                  console.log(`[trello] Resolving list "${listName}" on board ${itemBoard.trelloBoardId}`)
                  const list = await getOrCreateList(itemBoard.trelloBoardId, listName)
                  listId = list.listId
                }

                const dueDate = latestDate(newItems.map((it) => it.eta))
                console.log(`[trello] Creating card "${category}" in list ${listId}`)
                const cardId = await createTrelloCard({
                  name: category, desc: '', listId, due: dueDate?.toISOString() ?? null,
                })
                console.log(`[trello] Created card ${cardId}`)

                const checklistId = await getOrCreateChecklist(cardId, 'Action Items')
                console.log(`[trello] Checklist ${checklistId} ready on card ${cardId}`)

                for (const item of newItems) {
                  const label           = item.eta ? `${item.action_item} (ETA: ${fmtDate(item.eta)})` : item.action_item
                  const checklistItemId = await addChecklistItem(
                    checklistId, label,
                    item.eta ? new Date(item.eta).toISOString() : null,
                    item.status === 'completed',
                  )
                  console.log(`[trello] Added checklist item ${checklistItemId}: "${label}"`)
                  cardUpdates.push({ itemId: item.id, cardId, checklistItemId })
                }
              } else {
                // ── Existing card — add new items to its checklist ────────────
                const checklistId = await getOrCreateChecklist(existingCardId, 'Action Items')
                console.log(`[trello] Checklist ${checklistId} ready on existing card ${existingCardId}`)

                for (const item of newItems) {
                  const label           = item.eta ? `${item.action_item} (ETA: ${fmtDate(item.eta)})` : item.action_item
                  const checklistItemId = await addChecklistItem(
                    checklistId, label,
                    item.eta ? new Date(item.eta).toISOString() : null,
                    item.status === 'completed',
                  )
                  console.log(`[trello] Added checklist item ${checklistItemId}: "${label}"`)
                  cardUpdates.push({ itemId: item.id, cardId: existingCardId, checklistItemId })
                }
              }
            } catch (err) {
              console.error(`[trello] Per-category error (category="${category}"):`, err)
            }
          }
        } // end boardGroups loop
      } catch (err) {
        console.error(`[trello] Per-owner error (owner=${ownerEmail}):`, err)
      }
    }),
  )

  // Flush card + checklist item ID updates to DB
  await Promise.all(
    cardUpdates.map(({ itemId, cardId, checklistItemId }) =>
      query(
        `UPDATE mom_items SET trello_card_id = $1, trello_checklist_item_id = $2 WHERE id = $3`,
        [cardId, checklistItemId, itemId],
      ).catch(() => { /* non-fatal */ }),
    ),
  )
}

// ─── 5. updateCardStatus ─────────────────────────────────────────────────────
//
// • Moves the card to a "Done" list on its board when status === "completed".
// • Always adds a timestamped comment reflecting the new status.

export async function updateCardStatus(
  cardId: string,
  status: 'pending' | 'in-progress' | 'completed',
): Promise<void> {
  // Resolve the card's board so we can find/create the Done list
  const cardData = await trello
    .get<{ idBoard: string }>(`/cards/${cardId}`, { params: { fields: 'idBoard' } })
    .then((r) => r.data)
    .catch((err) => trelloError(err, `GET /cards/${cardId}`))

  if (status === 'completed') {
    const doneList = await getOrCreateList(cardData.idBoard, 'Done')
    await trello
      .put(`/cards/${cardId}`, { idList: doneList.listId })
      .catch((err) => trelloError(err, `PUT /cards/${cardId} (move to Done)`))
  }

  // Add audit comment
  await trello
    .post(`/cards/${cardId}/actions/comments`, {
      text: `Status updated to **${status}** via ValueCart MOM Tool`,
    })
    .catch((err) => trelloError(err, `POST /cards/${cardId}/actions/comments`))
}

// ─── 6. updateCardName ───────────────────────────────────────────────────────
//
// Renames a Trello card when the action item text is edited.

export async function updateCardName(cardId: string, name: string): Promise<void> {
  await trello
    .put(`/cards/${cardId}`, { name })
    .catch((err) => trelloError(err, `PUT /cards/${cardId} (rename)`))
}

// ─── 7. archiveCard ───────────────────────────────────────────────────────────
//
// Archives (closes) a Trello card when the MOM item is deleted.

export async function archiveCard(cardId: string): Promise<void> {
  await trello
    .put(`/cards/${cardId}`, { closed: true })
    .catch((err) => trelloError(err, `PUT /cards/${cardId} (archive)`))
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Formats a Date (or date-like value from pg) as "15 Apr 2026". */
function fmtDate(d: Date | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Returns the latest non-null Date from an array, or null if all are null. */
function latestDate(dates: (Date | null)[]): Date | null {
  const valid = dates
    .filter((d): d is Date => d !== null)
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()))

  if (valid.length === 0) return null
  return new Date(Math.max(...valid.map((d) => d.getTime())))
}

/** True when `candidate` is strictly later than `current` (ISO string or null). */
function isLaterThan(candidate: Date, current: string | null): boolean {
  if (!current) return true
  return candidate.getTime() > new Date(current).getTime()
}
