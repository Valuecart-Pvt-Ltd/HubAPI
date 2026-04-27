-- ============================================================
--  Phase 3 — Karya ↔ Kaarya integration
--
--  Adds the columns and procedures that let MOM action items
--  flow into Kaarya cards on a configured board.
--
--  All statements idempotent; safe to re-run.
-- ============================================================

-- ─── 1. ALTER events — add Kaarya board mapping ──────────────────────────────
-- When events.kaarya_board_id is NULL, no auto-sync happens.
-- The user picks a board from the Event Detail page; the first list of that
-- board becomes the destination unless events.kaarya_list_id is set explicitly.

IF COL_LENGTH('events', 'kaarya_board_id') IS NULL
BEGIN
    ALTER TABLE events ADD kaarya_board_id UNIQUEIDENTIFIER NULL;
    PRINT 'events: + kaarya_board_id';
END
GO

IF COL_LENGTH('events', 'kaarya_list_id') IS NULL
BEGIN
    ALTER TABLE events ADD kaarya_list_id UNIQUEIDENTIFIER NULL;
    PRINT 'events: + kaarya_list_id';
END
GO

-- ─── 2. ALTER mom_items — direct backref to its Kaarya card ──────────────────
-- The Kaarya side already has karya_mom_item_id on kaarya_cards. The reverse
-- pointer here speeds up the "is this item synced?" badge query without
-- requiring a join through kaarya_cards.

IF COL_LENGTH('mom_items', 'kaarya_card_id') IS NULL
BEGIN
    ALTER TABLE mom_items ADD kaarya_card_id UNIQUEIDENTIFIER NULL;
    PRINT 'mom_items: + kaarya_card_id';
END
GO


-- ============================================================
--  SECTION 8 — KAARYA SYNC PROCEDURES
-- ============================================================

-- ------------------------------------------------------------
-- usp_KSetEventBoard
-- Called when the user picks (or clears) a Kaarya board for an event.
-- @KaaryaBoardId = NULL clears the mapping.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_KSetEventBoard
    @EventId        UNIQUEIDENTIFIER,
    @KaaryaBoardId  UNIQUEIDENTIFIER = NULL,
    @KaaryaListId   UNIQUEIDENTIFIER = NULL,
    @ActorId        UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    -- Access check via existing usp_CheckEventAccess flow inlined for clarity
    IF NOT EXISTS (
        SELECT 1 FROM events e WHERE e.id = @EventId AND e.organizer_email = (
            SELECT email FROM users WHERE id = @ActorId
        )
        UNION ALL
        SELECT 1 FROM event_attendees ea WHERE ea.event_id = @EventId AND ea.email = (
            SELECT email FROM users WHERE id = @ActorId
        )
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    -- Verify the chosen board (if not NULL) is one the actor can access
    IF @KaaryaBoardId IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @KaaryaBoardId AND wm.user_id = @ActorId
    )
    BEGIN
        RAISERROR('BOARD_FORBIDDEN', 16, 1);
        RETURN;
    END

    -- Default the list to the first list of the board if not explicitly set
    DECLARE @resolvedListId UNIQUEIDENTIFIER = @KaaryaListId;
    IF @KaaryaBoardId IS NOT NULL AND @resolvedListId IS NULL
    BEGIN
        SELECT TOP 1 @resolvedListId = id
        FROM   kaarya_lists
        WHERE  board_id = @KaaryaBoardId AND is_archived = 0
        ORDER BY position ASC, created_at ASC;
    END

    UPDATE events
    SET    kaarya_board_id = @KaaryaBoardId,
           kaarya_list_id  = @resolvedListId,
           updated_at      = SYSUTCDATETIME()
    WHERE  id = @EventId;

    SELECT id, title, kaarya_board_id, kaarya_list_id FROM events WHERE id = @EventId;
END
GO


-- ------------------------------------------------------------
-- usp_KSyncMomItem
-- Upsert a Kaarya card from a single MOM item. Uses karya_mom_item_id as the
-- match key. Caller is responsible for resolving the destination list before
-- calling — typically derived from the event's kaarya_list_id.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_KSyncMomItem
    @MomItemId    UNIQUEIDENTIFIER,
    @KaaryaListId UNIQUEIDENTIFIER,
    @ActorId      UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    -- Pull the source item details
    DECLARE @eventId      UNIQUEIDENTIFIER,
            @actionItem   NVARCHAR(MAX),
            @ownerEmail   NVARCHAR(255),
            @eta          DATE,
            @status       NVARCHAR(20),
            @ownerUserId  UNIQUEIDENTIFIER;

    SELECT @actionItem = mi.action_item,
           @ownerEmail = mi.owner_email,
           @eta        = mi.eta,
           @status     = mi.status,
           @eventId    = ms.event_id
    FROM   mom_items    mi
    JOIN   mom_sessions ms ON ms.id = mi.mom_session_id
    WHERE  mi.id = @MomItemId;

    IF @eventId IS NULL
    BEGIN
        RAISERROR('MOM_ITEM_NOT_FOUND', 16, 1);
        RETURN;
    END

    -- Map owner_email → user_id (best-effort; NULL if unknown)
    SELECT @ownerUserId = id FROM users WHERE email = @ownerEmail;

    -- Validate the destination list exists and belongs to a board the actor can access
    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_lists WHERE id = @KaaryaListId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('LIST_NOT_FOUND', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    )
    BEGIN
        RAISERROR('BOARD_FORBIDDEN', 16, 1);
        RETURN;
    END

    DECLARE @cardId UNIQUEIDENTIFIER =
        (SELECT id FROM kaarya_cards WHERE karya_mom_item_id = @MomItemId);

    -- Map MOM status → Kaarya completed_at: 'completed' → set to now if not already
    DECLARE @completedAt DATETIME2 =
        CASE WHEN @status = 'completed' THEN SYSUTCDATETIME() ELSE NULL END;

    IF @cardId IS NULL
    BEGIN
        -- Insert a fresh card at the bottom of the list
        DECLARE @nextPos DECIMAL(20, 10) = ISNULL(
            (SELECT MAX(position) + 1.0 FROM kaarya_cards WHERE list_id = @KaaryaListId), 0);

        SET @cardId = NEWID();
        INSERT INTO kaarya_cards
            (id, list_id, board_id, title, position, due_date, completed_at,
             karya_event_id, karya_mom_item_id, created_by)
        VALUES
            (@cardId, @KaaryaListId, @boardId,
             LEFT(@actionItem, 500),
             @nextPos,
             CASE WHEN @eta IS NULL THEN NULL ELSE CAST(@eta AS DATETIME2) END,
             @completedAt,
             @eventId, @MomItemId, @ActorId);

        IF @ownerUserId IS NOT NULL
        BEGIN
            INSERT INTO kaarya_card_members (card_id, user_id)
            VALUES (@cardId, @ownerUserId);
        END

        INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
        VALUES (@boardId, @cardId, @ActorId, 'card_created_from_mom',
                (SELECT @MomItemId AS momItemId, @eventId AS eventId
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));
    END
    ELSE
    BEGIN
        -- Card already exists — refresh title/due/completion. Do NOT move
        -- between lists or clobber position so a user-edited board layout
        -- is preserved.
        UPDATE kaarya_cards
        SET    title         = LEFT(@actionItem, 500),
               due_date      = CASE WHEN @eta IS NULL THEN NULL ELSE CAST(@eta AS DATETIME2) END,
               -- Only set completed_at when MOM says completed; if MOM says
               -- not-completed but card was completed in Kaarya, leave it.
               completed_at  = CASE
                                 WHEN @status = 'completed' AND completed_at IS NULL THEN SYSUTCDATETIME()
                                 ELSE completed_at
                               END,
               updated_at    = SYSUTCDATETIME()
        WHERE  id = @cardId;

        INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
        VALUES (@boardId, @cardId, @ActorId, 'card_updated_from_mom');
    END

    -- Stamp the back-pointer on mom_items so the UI can show "Synced" badges fast.
    UPDATE mom_items SET kaarya_card_id = @cardId WHERE id = @MomItemId;

    SELECT id, list_id, board_id, title, due_date, completed_at,
           karya_event_id, karya_mom_item_id, created_at, updated_at
    FROM   kaarya_cards WHERE id = @cardId;
END
GO


-- ------------------------------------------------------------
-- usp_KSyncEventMom
-- Bulk: sync every MOM item in the latest session for an event onto the
-- event's configured Kaarya board. Returns the synced cards.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_KSyncEventMom
    @EventId UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @listId UNIQUEIDENTIFIER, @boardId UNIQUEIDENTIFIER;
    SELECT @boardId = kaarya_board_id, @listId = kaarya_list_id
    FROM   events WHERE id = @EventId;

    IF @boardId IS NULL
    BEGIN
        -- No board mapped — silently skip (callers treat this as "nothing to sync").
        SELECT CAST(NULL AS UNIQUEIDENTIFIER) AS id WHERE 1 = 0;
        RETURN;
    END

    IF @listId IS NULL
    BEGIN
        SELECT TOP 1 @listId = id
        FROM   kaarya_lists
        WHERE  board_id = @boardId AND is_archived = 0
        ORDER BY position ASC, created_at ASC;
    END

    IF @listId IS NULL
    BEGIN
        RAISERROR('NO_LIST_AVAILABLE', 16, 1);
        RETURN;
    END

    -- Latest MOM session for this event
    DECLARE @sessionId UNIQUEIDENTIFIER =
        (SELECT TOP 1 id FROM mom_sessions WHERE event_id = @EventId
         ORDER BY created_at DESC);

    IF @sessionId IS NULL
    BEGIN
        SELECT CAST(NULL AS UNIQUEIDENTIFIER) AS id WHERE 1 = 0;
        RETURN;
    END

    -- Iterate items
    DECLARE @itemId UNIQUEIDENTIFIER;
    DECLARE itemCursor CURSOR LOCAL FAST_FORWARD FOR
        SELECT id FROM mom_items WHERE mom_session_id = @sessionId;
    OPEN itemCursor;
    FETCH NEXT FROM itemCursor INTO @itemId;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC usp_KSyncMomItem @MomItemId = @itemId,
                              @KaaryaListId = @listId,
                              @ActorId = @ActorId;
        FETCH NEXT FROM itemCursor INTO @itemId;
    END
    CLOSE itemCursor; DEALLOCATE itemCursor;

    -- Return the synced cards for this event
    SELECT id, list_id, board_id, title, due_date, completed_at,
           karya_event_id, karya_mom_item_id, created_at, updated_at
    FROM   kaarya_cards
    WHERE  karya_event_id = @EventId
    ORDER BY position ASC;
END
GO


-- ------------------------------------------------------------
-- usp_KUnsyncMomItem
-- When a MOM item is deleted, remove its Kaarya card too.
-- (We could also leave it; but cards-without-source-MOM-item is confusing.)
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_KUnsyncMomItem
    @MomItemId UNIQUEIDENTIFIER,
    @ActorId   UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @cardId UNIQUEIDENTIFIER, @boardId UNIQUEIDENTIFIER;
    SELECT @cardId = id, @boardId = board_id
    FROM   kaarya_cards WHERE karya_mom_item_id = @MomItemId;

    IF @cardId IS NULL RETURN;

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
    VALUES (@boardId, @cardId, @ActorId, 'card_deleted_from_mom_unsync');

    DELETE FROM kaarya_cards WHERE id = @cardId;
    SELECT @cardId AS deleted_card_id;
END
GO


-- ------------------------------------------------------------
-- usp_KGetBoardLists
-- Helper for the UI's board-picker on Event Detail. Returns the lists in a
-- given board so the picker can show "[Board name] / [List name]".
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_KGetBoardLists
    @BoardId UNIQUEIDENTIFIER,
    @UserId  UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @BoardId AND wm.user_id = @UserId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    SELECT id, board_id, name, color, position
    FROM   kaarya_lists
    WHERE  board_id = @BoardId AND is_archived = 0
    ORDER BY position ASC;
END
GO


PRINT '========================================';
PRINT 'Karya ↔ Kaarya integration (Phase 3) — 4 SPs';
PRINT '========================================';
