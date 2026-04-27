-- ============================================================
--  Phase 6 — workspace invitations + list reorder
--
--  Idempotent. Run AFTER 07_kaarya_board_polish.sql.
-- ============================================================


-- ─── 1. kaarya_workspace_invitations ─────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_workspace_invitations')
BEGIN
    CREATE TABLE kaarya_workspace_invitations (
        id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        workspace_id  UNIQUEIDENTIFIER NOT NULL,
        email         NVARCHAR(255)    NOT NULL,
        role          NVARCHAR(20)     NOT NULL DEFAULT 'member'
                          CONSTRAINT CHK_kwi_role CHECK (role IN ('member','admin')),
        token         NVARCHAR(100)    NOT NULL UNIQUE,
        invited_by    UNIQUEIDENTIFIER NOT NULL,
        accepted_at   DATETIME2        NULL,
        accepted_by   UNIQUEIDENTIFIER NULL,
        revoked_at    DATETIME2        NULL,
        expires_at    DATETIME2        NOT NULL,
        created_at    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kwi_workspace
            FOREIGN KEY (workspace_id) REFERENCES kaarya_workspaces (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kwi_workspace      ON kaarya_workspace_invitations (workspace_id);
    CREATE INDEX IX_kwi_email_pending  ON kaarya_workspace_invitations (email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;
    PRINT 'Created table: kaarya_workspace_invitations';
END
GO


-- ─── 2. usp_KCreateInvitation ────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KCreateInvitation
    @WorkspaceId UNIQUEIDENTIFIER,
    @Email       NVARCHAR(255),
    @Role        NVARCHAR(20) = 'member',
    @Token       NVARCHAR(100),
    @ExpiresAt   DATETIME2,
    @ActorId     UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @WorkspaceId AND user_id = @ActorId
          AND  role IN ('owner', 'admin')
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    -- If the email already corresponds to a workspace member, reject.
    IF EXISTS (
        SELECT 1 FROM kaarya_workspace_members wm
        JOIN   users u ON u.id = wm.user_id
        WHERE  wm.workspace_id = @WorkspaceId AND u.email = @Email
    )
    BEGIN
        RAISERROR('ALREADY_MEMBER', 16, 1);
        RETURN;
    END

    -- Revoke any existing pending invite for the same email in this workspace
    -- so we don't accumulate duplicates.
    UPDATE kaarya_workspace_invitations
    SET    revoked_at = SYSUTCDATETIME()
    WHERE  workspace_id = @WorkspaceId
      AND  email        = @Email
      AND  accepted_at IS NULL
      AND  revoked_at  IS NULL;

    DECLARE @id UNIQUEIDENTIFIER = NEWID();
    INSERT INTO kaarya_workspace_invitations
        (id, workspace_id, email, role, token, invited_by, expires_at)
    VALUES
        (@id, @WorkspaceId, @Email, @Role, @Token, @ActorId, @ExpiresAt);

    SELECT id, workspace_id, email, role, token, invited_by, expires_at, created_at
    FROM   kaarya_workspace_invitations WHERE id = @id;
END
GO


-- ─── 3. usp_KAcceptInvitation ────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KAcceptInvitation
    @Token  NVARCHAR(100),
    @UserId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @inv_id      UNIQUEIDENTIFIER,
            @workspace   UNIQUEIDENTIFIER,
            @role        NVARCHAR(20),
            @email       NVARCHAR(255),
            @expires_at  DATETIME2,
            @accepted_at DATETIME2,
            @revoked_at  DATETIME2;

    SELECT @inv_id      = id,
           @workspace   = workspace_id,
           @role        = role,
           @email       = email,
           @expires_at  = expires_at,
           @accepted_at = accepted_at,
           @revoked_at  = revoked_at
    FROM   kaarya_workspace_invitations
    WHERE  token = @Token;

    IF @inv_id IS NULL          BEGIN RAISERROR('INVITATION_NOT_FOUND', 16, 1); RETURN; END
    IF @accepted_at IS NOT NULL BEGIN RAISERROR('ALREADY_ACCEPTED', 16, 1); RETURN; END
    IF @revoked_at  IS NOT NULL BEGIN RAISERROR('REVOKED', 16, 1); RETURN; END
    IF @expires_at < SYSUTCDATETIME() BEGIN RAISERROR('EXPIRED', 16, 1); RETURN; END

    -- Verify the JWT user's email matches the invited email — prevents one
    -- person from accepting on behalf of another.
    DECLARE @user_email NVARCHAR(255) = (SELECT email FROM users WHERE id = @UserId);
    IF @user_email IS NULL OR LOWER(@user_email) <> LOWER(@email)
    BEGIN
        RAISERROR('EMAIL_MISMATCH', 16, 1);
        RETURN;
    END

    -- Add to membership (or no-op if somehow already a member)
    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @workspace AND user_id = @UserId
    )
    BEGIN
        INSERT INTO kaarya_workspace_members (workspace_id, user_id, role)
        VALUES (@workspace, @UserId, @role);
    END

    UPDATE kaarya_workspace_invitations
    SET    accepted_at = SYSUTCDATETIME(),
           accepted_by = @UserId
    WHERE  id = @inv_id;

    -- Return the workspace so the UI can route to it
    SELECT w.id, w.name, w.color FROM kaarya_workspaces w WHERE w.id = @workspace;
END
GO


-- ─── 4. usp_KListInvitations ─────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KListInvitations
    @WorkspaceId UNIQUEIDENTIFIER,
    @ActorId     UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @WorkspaceId AND user_id = @ActorId
    )
    BEGIN
        RAISERROR('FORBIDDEN', 16, 1);
        RETURN;
    END

    SELECT id, workspace_id, email, role, invited_by,
           accepted_at, revoked_at, expires_at, created_at,
           CASE
             WHEN accepted_at IS NOT NULL THEN 'accepted'
             WHEN revoked_at  IS NOT NULL THEN 'revoked'
             WHEN expires_at  <  SYSUTCDATETIME() THEN 'expired'
             ELSE 'pending'
           END AS status
    FROM   kaarya_workspace_invitations
    WHERE  workspace_id = @WorkspaceId
    ORDER BY created_at DESC;
END
GO


-- ─── 5. usp_KRevokeInvitation ────────────────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KRevokeInvitation
    @InvitationId UNIQUEIDENTIFIER,
    @ActorId      UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @workspace UNIQUEIDENTIFIER =
        (SELECT workspace_id FROM kaarya_workspace_invitations WHERE id = @InvitationId);
    IF @workspace IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    IF NOT EXISTS (
        SELECT 1 FROM kaarya_workspace_members
        WHERE  workspace_id = @workspace AND user_id = @ActorId
          AND  role IN ('owner', 'admin')
    )
    BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    UPDATE kaarya_workspace_invitations
    SET    revoked_at = SYSUTCDATETIME()
    WHERE  id = @InvitationId AND accepted_at IS NULL AND revoked_at IS NULL;
END
GO


-- ─── 6. usp_KMoveList — column reordering ────────────────────────────────────

CREATE OR ALTER PROCEDURE usp_KMoveList
    @ListId   UNIQUEIDENTIFIER,
    @Position INT,
    @ActorId  UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @boardId UNIQUEIDENTIFIER =
        (SELECT board_id FROM kaarya_lists WHERE id = @ListId);
    IF @boardId IS NULL BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    IF NOT EXISTS (
        SELECT 1
        FROM   kaarya_boards            b
        JOIN   kaarya_workspace_members wm ON wm.workspace_id = b.workspace_id
        WHERE  b.id = @boardId AND wm.user_id = @ActorId
    ) BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    UPDATE kaarya_lists SET position = @Position WHERE id = @ListId;

    INSERT INTO kaarya_activity (board_id, card_id, actor_id, event_type, details)
    VALUES (@boardId, NULL, @ActorId, 'list_moved',
            (SELECT @ListId AS listId, @Position AS position
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER));

    SELECT id, board_id, name, color, position FROM kaarya_lists WHERE id = @ListId;
END
GO


PRINT '========================================';
PRINT 'Kaarya Phase 6 — invitations + list reorder';
PRINT '========================================';
