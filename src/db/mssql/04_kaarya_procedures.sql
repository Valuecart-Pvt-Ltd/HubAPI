-- ============================================================
--  Kaarya — STORED PROCEDURES (Phase 1)
--
--  Run AFTER 01_tables.sql. All procedures use CREATE OR ALTER
--  (SQL Server 2016+) — safe to re-run.
--
--  Naming: every Kaarya SP is prefixed `usp_K` to coexist with
--  HubAPI's `usp_*` procedures in the same database.
-- ============================================================


-- ============================================================
--  SECTION 1 — WORKSPACES
-- ============================================================

CREATE OR ALTER PROCEDURE usp_KGetWorkspaces
    @UserId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT w.id, w.name, w.color, w.created_by, w.created_at, w.updated_at,
           wm.role,
           (SELECT COUNT(*) FROM kaarya_boards b WHERE b.workspace_id = w.id AND b.is_archived = 0) AS board_count
    FROM   kaarya_workspaces       w
    JOIN   kaarya_workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = @UserId
    ORDER BY w.created_at ASC;
END
GO

CREATE OR ALTER PROCEDURE usp_KCreateWorkspace
    @Name      NVARCHAR(255),
    @Color     NVARCHAR(20) = '#F0841C',
    @CreatedBy UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_workspaces (id, name, color, created_by)
    VALUES (@id, @Name, @Color, @CreatedBy);

    INSERT INTO kaarya_workspace_members (workspace_id, user_id, role)
    VALUES (@id, @CreatedBy, 'owner');

    SELECT id, name, color, created_by, created_at, updated_at, 'owner' AS role, 0 AS board_count
    FROM   kaarya_workspaces WHERE id = @id;
END
GO


-- ============================================================
--  SECTION 2 — BOARDS
-- ============================================================

CREATE OR ALTER PROCEDURE usp_KGetBoards
    @WorkspaceId UNIQUEIDENTIFIER,
    @UserId      UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    -- Membership check
    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @WorkspaceId AND user_id = @UserId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    SELECT id, workspace_id, name, description, color, position, is_archived,
           created_at, updated_at,
           (SELECT COUNT(*) FROM kaarya_cards c WHERE c.board_id = b.id AND c.is_archived = 0) AS card_count
    FROM   kaarya_boards b
    WHERE  b.workspace_id = @WorkspaceId AND b.is_archived = 0
    ORDER BY b.position ASC, b.created_at ASC;
END
GO

CREATE OR ALTER PROCEDURE usp_KCreateBoard
    @WorkspaceId UNIQUEIDENTIFIER,
    @Name        NVARCHAR(255),
    @Description NVARCHAR(MAX) = NULL,
    @Color       NVARCHAR(20)  = '#1F2937',
    @UserId      UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @WorkspaceId AND user_id = @UserId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    DECLARE @nextPos INT = ISNULL(
        (SELECT MAX(position) + 1 FROM kaarya_boards WHERE workspace_id = @WorkspaceId), 0);

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_boards (id, workspace_id, name, description, color, position)
    VALUES (@id, @WorkspaceId, @Name, @Description, @Color, @nextPos);

    -- Create default lists
    INSERT INTO kaarya_lists (id, board_id, name, position, color)
    VALUES (NEWID(), @id, 'To Do',       0, '#F0841C'),
           (NEWID(), @id, 'In Progress', 1, '#F59E0B'),
           (NEWID(), @id, 'Done',        2, '#10B981');

    SELECT id, workspace_id, name, description, color, position, is_archived,
           created_at, updated_at, 0 AS card_count
    FROM   kaarya_boards WHERE id = @id;
END
GO

CREATE OR ALTER PROCEDURE usp_KGetBoardDetail
    @BoardId UNIQUEIDENTIFIER,
    @UserId  UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @workspaceId UNIQUEIDENTIFIER =
        (SELECT workspace_id FROM kaarya_boards WHERE id = @BoardId);

    IF @workspaceId IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @workspaceId AND user_id = @UserId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    -- 1. Board
    SELECT id, workspace_id, name, description, color, position, is_archived,
           created_at, updated_at
    FROM   kaarya_boards WHERE id = @BoardId;

    -- 2. Lists
    SELECT id, board_id, name, color, position
    FROM   kaarya_lists
    WHERE  board_id = @BoardId AND is_archived = 0
    ORDER BY position ASC;

    -- 3. Cards (lightweight)
    SELECT c.id, c.list_id, c.title, c.description, c.position, c.priority, c.status,
           c.due_date, c.completed_at, c.karya_event_id, c.karya_mom_item_id,
           c.created_by, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM kaarya_card_comments cc WHERE cc.card_id = c.id) AS comment_count,
           (SELECT COUNT(*) FROM kaarya_card_tasks    ct WHERE ct.card_id = c.id) AS task_count,
           (SELECT COUNT(*) FROM kaarya_card_tasks    ct WHERE ct.card_id = c.id AND ct.is_completed = 1) AS task_done_count,
           (SELECT cm.user_id AS userId FROM kaarya_card_members cm WHERE cm.card_id = c.id FOR JSON PATH) AS members_json,
           (SELECT l.id AS id, l.name AS name, l.color AS color
              FROM kaarya_card_labels cl JOIN kaarya_labels l ON l.id = cl.label_id
              WHERE cl.card_id = c.id FOR JSON PATH) AS labels_json
    FROM   kaarya_cards c
    WHERE  c.board_id = @BoardId AND c.is_archived = 0
    ORDER BY c.position ASC;

    -- 4. Labels
    SELECT id, board_id, name, color FROM kaarya_labels WHERE board_id = @BoardId;
END
GO


-- ============================================================
--  SECTION 3 — CARDS
-- ============================================================

CREATE OR ALTER PROCEDURE usp_KCreateCard
    @ListId      UNIQUEIDENTIFIER,
    @Title       NVARCHAR(500),
    @Description NVARCHAR(MAX) = NULL,
    @Priority    NVARCHAR(20)  = NULL,
    @DueDate     DATETIME2     = NULL,
    @CreatedBy   UNIQUEIDENTIFIER,
    -- Phase 3 hooks (Karya may pass these on MOM-driven creates)
    @KaryaEventId    UNIQUEIDENTIFIER = NULL,
    @KaryaMomItemId  UNIQUEIDENTIFIER = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_lists WHERE id = @ListId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('LIST_NOT_FOUND', 16, 1);
        RETURN;
    END

    -- Membership check via the workspace
    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @CreatedBy
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    DECLARE @nextPos DECIMAL(20, 10) = ISNULL(
        (SELECT MAX(position) + 1.0 FROM kaarya_cards WHERE list_id = @ListId), 0);

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_cards (id, list_id, board_id, title, description, position,
                              priority, due_date, created_by,
                              karya_event_id, karya_mom_item_id)
    VALUES (@id, @ListId, @boardId, @Title, @Description, @nextPos,
            @Priority, @DueDate, @CreatedBy,
            @KaryaEventId, @KaryaMomItemId);

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
    VALUES (@boardId, @id, @CreatedBy, 'card_created',
            (SELECT @Title AS title FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));

    SELECT id, list_id, board_id, title, description, position, priority, status,
           due_date, completed_at, karya_event_id, karya_mom_item_id,
           created_by, created_at, updated_at
    FROM   kaarya_cards WHERE id = @id;
END
GO

CREATE OR ALTER PROCEDURE usp_KUpdateCard
    @CardId      UNIQUEIDENTIFIER,
    @ActorId     UNIQUEIDENTIFIER,
    @Title       NVARCHAR(500) = NULL,
    @Description NVARCHAR(MAX) = NULL,
    @Priority    NVARCHAR(20)  = NULL,
    @Status      NVARCHAR(50)  = NULL,
    @DueDate     DATETIME2     = NULL,
    @ClearDueDate BIT          = 0
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    UPDATE kaarya_cards
    SET    title       = ISNULL(@Title,       title),
           description = ISNULL(@Description, description),
           priority    = ISNULL(@Priority,    priority),
           status      = ISNULL(@Status,      status),
           due_date    = CASE WHEN @ClearDueDate = 1 THEN NULL
                              ELSE ISNULL(@DueDate, due_date) END,
           updated_at  = SYSUTCDATETIME()
    WHERE  id = @CardId;

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
    VALUES (@boardId, @CardId, @ActorId, 'card_updated');

    SELECT id, list_id, board_id, title, description, position, priority, status,
           due_date, completed_at, karya_event_id, karya_mom_item_id,
           created_by, created_at, updated_at
    FROM   kaarya_cards WHERE id = @CardId;
END
GO

CREATE OR ALTER PROCEDURE usp_KMoveCard
    @CardId       UNIQUEIDENTIFIER,
    @ActorId      UNIQUEIDENTIFIER,
    @TargetListId UNIQUEIDENTIFIER,
    @Position     DECIMAL(20, 10)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    -- Validate the target list belongs to the same board
    IF NOT EXISTS (
        SELECT 1 FROM kaarya_lists WHERE id = @TargetListId AND board_id = @boardId
    )
    BEGIN
        RAISERROR('LIST_NOT_IN_BOARD', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    UPDATE kaarya_cards
    SET    list_id    = @TargetListId,
           position   = @Position,
           updated_at = SYSUTCDATETIME()
    WHERE  id = @CardId;

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
    VALUES (@boardId, @CardId, @ActorId, 'card_moved',
            (SELECT @TargetListId AS toListId FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));

    SELECT id, list_id, board_id, title, description, position, priority, status,
           due_date, completed_at, karya_event_id, karya_mom_item_id,
           created_by, created_at, updated_at
    FROM   kaarya_cards WHERE id = @CardId;
END
GO

CREATE OR ALTER PROCEDURE usp_KCompleteCard
    @CardId   UNIQUEIDENTIFIER,
    @ActorId  UNIQUEIDENTIFIER,
    @Done     BIT
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    UPDATE kaarya_cards
    SET    completed_at = CASE WHEN @Done = 1 THEN SYSUTCDATETIME() ELSE NULL END,
           updated_at   = SYSUTCDATETIME()
    WHERE  id = @CardId;

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
    VALUES (@boardId, @CardId, @ActorId,
            CASE WHEN @Done = 1 THEN 'card_completed' ELSE 'card_reopened' END);

    SELECT id, list_id, board_id, title, completed_at, updated_at
    FROM   kaarya_cards WHERE id = @CardId;
END
GO

CREATE OR ALTER PROCEDURE usp_KDeleteCard
    @CardId  UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    -- Activity entry must be inserted BEFORE the card is deleted (FK cascade
    -- on cards has ON DELETE CASCADE for child tables; activity has no FK on
    -- card_id so the row survives, but card_id will reference a vanished
    -- card. That's intentional — we want history.)
    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
    VALUES (@boardId, @CardId, @ActorId, 'card_deleted');

    DELETE FROM kaarya_cards WHERE id = @CardId;

    SELECT @CardId AS deleted_card_id;
END
GO


-- ============================================================
--  SECTION 4 — LISTS
-- ============================================================

CREATE OR ALTER PROCEDURE usp_KCreateList
    @BoardId UNIQUEIDENTIFIER,
    @Name    NVARCHAR(255),
    @Color   NVARCHAR(20) = '#6B7280',
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @BoardId AND wm.user_id = @ActorId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    DECLARE @nextPos INT = ISNULL(
        (SELECT MAX(position) + 1 FROM kaarya_lists WHERE board_id = @BoardId), 0);

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_lists (id, board_id, name, color, position)
    VALUES (@id, @BoardId, @Name, @Color, @nextPos);

    SELECT id, board_id, name, color, position FROM kaarya_lists WHERE id = @id;
END
GO


-- ============================================================
--  SECTION 5 — COMMENTS
-- ============================================================

CREATE OR ALTER PROCEDURE usp_KAddCardComment
    @CardId   UNIQUEIDENTIFIER,
    @AuthorId UNIQUEIDENTIFIER,
    @Body     NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);

    IF @boardId IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_card_comments (id, card_id, author_id, body)
    VALUES (@id, @CardId, @AuthorId, @Body);

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type)
    VALUES (@boardId, @CardId, @AuthorId, 'comment_added');

    SELECT id, card_id, author_id, body, created_at
    FROM   kaarya_card_comments WHERE id = @id;
END
GO

CREATE OR ALTER PROCEDURE usp_KGetCardComments
    @CardId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, card_id, author_id, body, created_at
    FROM   kaarya_card_comments
    WHERE  card_id = @CardId
    ORDER BY created_at ASC;
END
GO


-- ============================================================
--  SECTION 6 — ACTIVITY
-- ============================================================

CREATE OR ALTER PROCEDURE usp_KGetBoardActivity
    @BoardId UNIQUEIDENTIFIER,
    @Limit   INT = 50
AS
BEGIN
    SET NOCOUNT ON;
    SELECT TOP (@Limit) id, board_id, card_id, actor_id, event_type, details, created_at
    FROM   kaarya_activity
    WHERE  board_id = @BoardId
    ORDER BY created_at DESC;
END
GO


PRINT '========================================';
PRINT 'Kaarya stored procedures (Phase 1) — 13 SPs';
PRINT '========================================';
