-- ============================================================
--  Phase 4c/4d — Board polish
--    • Workspace user lookup (for card-member picker)
--    • Card member CRUD
--    • Board label CRUD
--    • Card label CRUD
--
--  Idempotent. Run AFTER 06_kaarya_polish.sql.
-- ============================================================


-- ─── 1. Users in a workspace (for card-member picker) ────────────────────────

CREATE OR ALTER PROCEDURE usp_KGetWorkspaceUsers
    @WorkspaceId UNIQUEIDENTIFIER,
    @UserId      UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    -- Caller must be a member of the workspace
    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @WorkspaceId AND user_id = @UserId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    SELECT u.id, u.name, u.email, u.avatar_url, u.department,
           wm.role
    FROM   kaarya_workspace_members wm
    JOIN   users u ON u.id = wm.user_id
    WHERE  wm.workspace_id = @WorkspaceId
    ORDER BY u.name ASC;
END
GO


-- ─── 2. Card members ─────────────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KAddCardMember
    @CardId   UNIQUEIDENTIFIER,
    @UserId   UNIQUEIDENTIFIER,
    @ActorId  UNIQUEIDENTIFIER
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

    -- The assignee must also be a workspace member (otherwise UI showing a stranger
    -- as assignee would be confusing)
    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @UserId
    ) BEGIN RAISERROR('USER_NOT_IN_WORKSPACE', 16, 1); RETURN; END

    IF NOT EXISTS (SELECT 1 FROM kaarya_card_members WHERE card_id = @CardId AND user_id = @UserId)
    BEGIN
        INSERT INTO kaarya_card_members (card_id, user_id) VALUES (@CardId, @UserId);
        INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
        VALUES (@boardId, @CardId, @ActorId, 'member_added',
                (SELECT @UserId AS userId FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));
    END

    SELECT u.id AS user_id, u.name, u.email, u.avatar_url
    FROM   kaarya_card_members cm
    JOIN   users u ON u.id = cm.user_id
    WHERE  cm.card_id = @CardId AND cm.user_id = @UserId;
END
GO

CREATE OR ALTER PROCEDURE usp_KRemoveCardMember
    @CardId   UNIQUEIDENTIFIER,
    @UserId   UNIQUEIDENTIFIER,
    @ActorId  UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    DELETE FROM kaarya_card_members WHERE card_id = @CardId AND user_id = @UserId;

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
    VALUES (@boardId, @CardId, @ActorId, 'member_removed',
            (SELECT @UserId AS userId FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));
END
GO


-- ─── 3. Board labels (the catalog) ───────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KGetBoardLabels
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

    SELECT id, board_id, name, color
    FROM   kaarya_labels
    WHERE  board_id = @BoardId
    ORDER BY name ASC;
END
GO

CREATE OR ALTER PROCEDURE usp_KCreateLabel
    @BoardId UNIQUEIDENTIFIER,
    @Name    NVARCHAR(100),
    @Color   NVARCHAR(20),
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @BoardId AND wm.user_id = @ActorId
    ) BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_labels (id, board_id, name, color)
    VALUES (@id, @BoardId, @Name, @Color);

    SELECT id, board_id, name, color FROM kaarya_labels WHERE id = @id;
END
GO

CREATE OR ALTER PROCEDURE usp_KDeleteLabel
    @LabelId UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_labels WHERE id = @LabelId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    ) BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    -- kaarya_card_labels has FK NO ACTION on label_id; clean up first.
    DELETE FROM kaarya_card_labels WHERE label_id = @LabelId;
    DELETE FROM kaarya_labels      WHERE id = @LabelId;
END
GO


-- ─── 4. Card-to-label assignments ────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KAddCardLabel
    @CardId  UNIQUEIDENTIFIER,
    @LabelId UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_cards WHERE id = @CardId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    -- Label must belong to the same board
    IF NOT EXISTS (SELECT 1 FROM kaarya_labels WHERE id = @LabelId AND board_id = @boardId)
    BEGIN
        RAISERROR('LABEL_NOT_IN_BOARD', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    ) BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    IF NOT EXISTS (SELECT 1 FROM kaarya_card_labels WHERE card_id = @CardId AND label_id = @LabelId)
    BEGIN
        INSERT INTO kaarya_card_labels (card_id, label_id) VALUES (@CardId, @LabelId);
    END

    SELECT l.id, l.board_id, l.name, l.color
    FROM   kaarya_labels l WHERE l.id = @LabelId;
END
GO

CREATE OR ALTER PROCEDURE usp_KRemoveCardLabel
    @CardId  UNIQUEIDENTIFIER,
    @LabelId UNIQUEIDENTIFIER,
    @ActorId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM kaarya_card_labels WHERE card_id = @CardId AND label_id = @LabelId;
END
GO


PRINT '========================================';
PRINT 'Kaarya Phase 4c/4d — board polish SPs';
PRINT '========================================';
