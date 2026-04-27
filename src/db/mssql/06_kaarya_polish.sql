-- ============================================================
--  Phase 4b — Kaarya polish
--    • Recurring cards (schema + advance-on-complete logic)
--    • Card-detail aggregator SP (one round-trip for the modal)
--    • Subtask + member CRUD SPs
--    • Board analytics aggregator
--
--  Idempotent — safe to re-run. Run AFTER 04_kaarya_procedures.sql.
-- ============================================================


-- ─── 1. kaarya_card_recurrence ───────────────────────────────────────────────
-- One row per recurring card. When the card is marked complete we use
-- usp_KCompleteCard's advance logic (defined further down) to roll
-- next_due_at forward and reset completed_at.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_card_recurrence')
BEGIN
    CREATE TABLE kaarya_card_recurrence (
        card_id            UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        frequency          NVARCHAR(20)     NOT NULL  -- 'daily' | 'weekly' | 'monthly'
                              CONSTRAINT CHK_kcr_freq CHECK (frequency IN ('daily','weekly','monthly')),
        interval_count     INT              NOT NULL DEFAULT 1
                              CONSTRAINT CHK_kcr_interval CHECK (interval_count BETWEEN 1 AND 365),
        next_due_at        DATETIME2        NULL,
        last_completed_at  DATETIME2        NULL,
        completion_count   INT              NOT NULL DEFAULT 0,
        created_at         DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kcr_card
            FOREIGN KEY (card_id) REFERENCES kaarya_cards (id) ON DELETE CASCADE
    );
    PRINT 'Created table: kaarya_card_recurrence';
END
GO


-- ─── 2. usp_KGetCardDetail ───────────────────────────────────────────────────
-- One round-trip for the Card Detail modal: card row + comments + tasks +
-- members + labels + recurrence. Returns 5 recordsets.

CREATE OR ALTER PROCEDURE usp_KGetCardDetail
    @CardId UNIQUEIDENTIFIER,
    @UserId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    -- Access check via workspace membership
    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_cards            c
        JOIN   kaarya_boards           b  ON b.id = c.board_id
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  c.id = @CardId AND wm.user_id = @UserId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    -- 1. Card row + recurrence (LEFT JOIN so non-recurring cards still return)
    SELECT c.id, c.list_id, c.board_id, c.title, c.description, c.position,
           c.priority, c.status, c.due_date, c.completed_at, c.is_archived,
           c.karya_event_id, c.karya_mom_item_id,
           c.created_by, c.created_at, c.updated_at,
           r.frequency        AS recurrence_frequency,
           r.interval_count   AS recurrence_interval,
           r.next_due_at      AS recurrence_next_due_at,
           r.last_completed_at AS recurrence_last_completed_at,
           r.completion_count AS recurrence_completion_count
    FROM   kaarya_cards c
    LEFT JOIN kaarya_card_recurrence r ON r.card_id = c.id
    WHERE  c.id = @CardId;

    -- 2. Comments
    SELECT id, card_id, author_id, body, created_at
    FROM   kaarya_card_comments
    WHERE  card_id = @CardId
    ORDER BY created_at ASC;

    -- 3. Tasks (checklist items)
    SELECT id, card_id, text, is_completed, completed_at, position
    FROM   kaarya_card_tasks
    WHERE  card_id = @CardId
    ORDER BY position ASC, id ASC;

    -- 4. Members
    SELECT cm.user_id, u.name, u.email, u.avatar_url
    FROM   kaarya_card_members cm
    LEFT JOIN users u ON u.id = cm.user_id
    WHERE  cm.card_id = @CardId;

    -- 5. Labels
    SELECT l.id, l.board_id, l.name, l.color
    FROM   kaarya_card_labels cl
    JOIN   kaarya_labels l ON l.id = cl.label_id
    WHERE  cl.card_id = @CardId;
END
GO


-- ─── 3. Recurrence config (set / clear) ──────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KSetCardRecurrence
    @CardId         UNIQUEIDENTIFIER,
    @ActorId        UNIQUEIDENTIFIER,
    @Frequency      NVARCHAR(20),
    @IntervalCount  INT = 1,
    @NextDueAt      DATETIME2 = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    ) BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    -- Default next_due_at to the card's due_date if caller didn't supply one
    IF @NextDueAt IS NULL
        SET @NextDueAt = (SELECT due_date FROM kaarya_cards WHERE id = @CardId);

    MERGE kaarya_card_recurrence AS target
    USING (VALUES (@CardId, @Frequency, @IntervalCount, @NextDueAt)) AS src (card_id, frequency, interval_count, next_due_at)
       ON target.card_id = src.card_id
    WHEN MATCHED THEN UPDATE SET
        frequency      = src.frequency,
        interval_count = src.interval_count,
        next_due_at    = src.next_due_at
    WHEN NOT MATCHED THEN INSERT (card_id, frequency, interval_count, next_due_at)
        VALUES (src.card_id, src.frequency, src.interval_count, src.next_due_at);

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
    VALUES (@boardId, @CardId, @ActorId, 'recurrence_set');

    SELECT card_id, frequency, interval_count, next_due_at, last_completed_at, completion_count
    FROM   kaarya_card_recurrence WHERE card_id = @CardId;
END
GO

CREATE OR ALTER PROCEDURE usp_KClearCardRecurrence
    @CardId  UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);
    DELETE FROM kaarya_card_recurrence WHERE card_id = @CardId;
    IF @boardId IS NOT NULL
        INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
        VALUES (@boardId, @CardId, @ActorId, 'recurrence_cleared');
END
GO


-- ─── 4. Override usp_KCompleteCard to advance recurrence ─────────────────────
-- Replaces the version from 04_kaarya_procedures.sql.

CREATE OR ALTER PROCEDURE usp_KCompleteCard
    @CardId   UNIQUEIDENTIFIER,
    @ActorId  UNIQUEIDENTIFIER,
    @Done     BIT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    DECLARE @recFreq NVARCHAR(20), @recInterval INT, @recNextDue DATETIME2;
    SELECT @recFreq = frequency, @recInterval = interval_count, @recNextDue = next_due_at
    FROM   kaarya_card_recurrence WHERE card_id = @CardId;

    IF @Done = 1 AND @recFreq IS NOT NULL
    BEGIN
        -- Recurring card → advance instead of marking complete.
        DECLARE @newNextDue DATETIME2 = @recNextDue;
        IF @newNextDue IS NULL SET @newNextDue = SYSUTCDATETIME();
        SET @newNextDue =
            CASE @recFreq
                WHEN 'daily'   THEN DATEADD(DAY,   @recInterval, @newNextDue)
                WHEN 'weekly'  THEN DATEADD(WEEK,  @recInterval, @newNextDue)
                WHEN 'monthly' THEN DATEADD(MONTH, @recInterval, @newNextDue)
            END;

        UPDATE kaarya_card_recurrence
        SET    next_due_at       = @newNextDue,
               last_completed_at = SYSUTCDATETIME(),
               completion_count  = completion_count + 1
        WHERE  card_id = @CardId;

        UPDATE kaarya_cards
        SET    due_date     = @newNextDue,
               completed_at = NULL,           -- recurring stays open
               updated_at   = SYSUTCDATETIME()
        WHERE  id = @CardId;

        INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
        VALUES (@boardId, @CardId, @ActorId, 'recurring_completed',
                (SELECT @newNextDue AS nextDueAt FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));
    END
    ELSE
    BEGIN
        UPDATE kaarya_cards
        SET    completed_at = CASE WHEN @Done = 1 THEN SYSUTCDATETIME() ELSE NULL END,
               updated_at   = SYSUTCDATETIME()
        WHERE  id = @CardId;

        INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
        VALUES (@boardId, @CardId, @ActorId,
                CASE WHEN @Done = 1 THEN 'card_completed' ELSE 'card_reopened' END);
    END

    SELECT id, list_id, board_id, title, completed_at, due_date, updated_at
    FROM   kaarya_cards WHERE id = @CardId;
END
GO


-- ─── 5. Subtask CRUD ─────────────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KAddCardTask
    @CardId  UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER,
    @Text    NVARCHAR(1000)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    DECLARE @nextPos INT = ISNULL(
        (SELECT MAX(position) + 1 FROM kaarya_card_tasks WHERE card_id = @CardId), 0);

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_card_tasks (id, card_id, text, position)
    VALUES (@id, @CardId, @Text, @nextPos);

    SELECT id, card_id, text, is_completed, completed_at, position
    FROM   kaarya_card_tasks WHERE id = @id;
END
GO

CREATE OR ALTER PROCEDURE usp_KToggleCardTask
    @TaskId  UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER,
    @Done    BIT
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE kaarya_card_tasks
    SET    is_completed = @Done,
           completed_at = CASE WHEN @Done = 1 THEN SYSUTCDATETIME() ELSE NULL END
    WHERE  id = @TaskId;

    SELECT id, card_id, text, is_completed, completed_at, position
    FROM   kaarya_card_tasks WHERE id = @TaskId;
END
GO

CREATE OR ALTER PROCEDURE usp_KDeleteCardTask
    @TaskId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM kaarya_card_tasks WHERE id = @TaskId;
    SELECT @TaskId AS deleted_task_id;
END
GO


-- ─── 6. Board analytics aggregator ───────────────────────────────────────────
-- One SP, several recordsets — keeps the analytics page to a single fetch.

CREATE OR ALTER PROCEDURE usp_KGetBoardAnalytics
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
    ) BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    -- 1. Headline stats
    SELECT
        SUM(CASE WHEN is_archived = 0                                 THEN 1 ELSE 0 END) AS total_cards,
        SUM(CASE WHEN is_archived = 0 AND completed_at IS NULL
                  AND due_date IS NOT NULL AND due_date < SYSUTCDATETIME() THEN 1 ELSE 0 END) AS overdue_count,
        SUM(CASE WHEN completed_at IS NOT NULL
                  AND completed_at >= DATEADD(DAY, -7,  SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS completed_7d,
        SUM(CASE WHEN completed_at IS NOT NULL
                  AND completed_at >= DATEADD(DAY, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS completed_30d,
        SUM(CASE WHEN is_archived = 0 AND completed_at IS NULL
                  AND due_date IS NOT NULL
                  AND due_date BETWEEN SYSUTCDATETIME() AND DATEADD(DAY, 7, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS due_this_week
    FROM   kaarya_cards
    WHERE  board_id = @BoardId;

    -- 2. By priority (open cards only)
    SELECT ISNULL(priority, 'unset') AS priority, COUNT(*) AS card_count
    FROM   kaarya_cards
    WHERE  board_id = @BoardId AND is_archived = 0 AND completed_at IS NULL
    GROUP BY ISNULL(priority, 'unset');

    -- 3. By list (open cards only — column distribution)
    SELECT l.id AS list_id, l.name, l.color, COUNT(c.id) AS card_count
    FROM   kaarya_lists  l
    LEFT JOIN kaarya_cards c ON c.list_id = l.id AND c.is_archived = 0 AND c.completed_at IS NULL
    WHERE  l.board_id = @BoardId AND l.is_archived = 0
    GROUP BY l.id, l.name, l.color, l.position
    ORDER BY l.position ASC;

    -- 4. Top assignees (by open cards)
    SELECT TOP 10
           cm.user_id,
           u.name,
           u.email,
           SUM(CASE WHEN c.is_archived = 0 AND c.completed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN c.completed_at IS NOT NULL
                     AND c.completed_at >= DATEADD(DAY, -30, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS completed_30d
    FROM   kaarya_card_members cm
    JOIN   kaarya_cards c ON c.id = cm.card_id
    LEFT JOIN users u    ON u.id = cm.user_id
    WHERE  c.board_id = @BoardId
    GROUP BY cm.user_id, u.name, u.email
    ORDER BY open_count DESC;

    -- 5. Completion timeline — last 30 days, one row per day
    ;WITH days AS (
        SELECT 0 AS n
        UNION ALL SELECT n + 1 FROM days WHERE n < 29
    )
    SELECT CAST(DATEADD(DAY, -d.n, CAST(SYSUTCDATETIME() AS DATE)) AS DATE) AS day,
           COUNT(c.id) AS completed_count
    FROM   days d
    LEFT JOIN kaarya_cards c
      ON c.board_id     = @BoardId
     AND c.completed_at >= CAST(DATEADD(DAY, -d.n,     CAST(SYSUTCDATETIME() AS DATE)) AS DATETIME2)
     AND c.completed_at <  CAST(DATEADD(DAY, -d.n + 1, CAST(SYSUTCDATETIME() AS DATE)) AS DATETIME2)
    GROUP BY d.n
    ORDER BY day ASC
    OPTION (MAXRECURSION 31);
END
GO


PRINT '========================================';
PRINT 'Kaarya Phase 4b — recurrence + detail + analytics SPs';
PRINT '========================================';
