-- ============================================================
--  Kaarya — Microsoft SQL Server
--  TABLE CREATION SCRIPT
--
--  Run this ONCE on your SQL Server database.
--  All statements are idempotent (safe to re-run).
--
--  Naming: every Kaarya table is prefixed `kaarya_` so it can coexist
--  with HubAPI's tables in the same physical database (recommended for
--  Phase 1 — single connection, single backup, simpler ops).
-- ============================================================

-- ─── 1. kaarya_workspaces ─────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_workspaces')
BEGIN
    CREATE TABLE kaarya_workspaces (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        name        NVARCHAR(255)    NOT NULL,
        color       NVARCHAR(20)     NOT NULL DEFAULT '#F0841C',
        created_by  UNIQUEIDENTIFIER NOT NULL,                   -- soft-FK to HubAPI users
        created_at  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_kaarya_workspaces_created_by ON kaarya_workspaces (created_by);
    PRINT 'Created table: kaarya_workspaces';
END
GO

-- ─── 2. kaarya_workspace_members ──────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_workspace_members')
BEGIN
    CREATE TABLE kaarya_workspace_members (
        workspace_id  UNIQUEIDENTIFIER NOT NULL,
        user_id       UNIQUEIDENTIFIER NOT NULL,
        role          NVARCHAR(20)     NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
        joined_at     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_kaarya_workspace_members PRIMARY KEY (workspace_id, user_id),
        CONSTRAINT FK_kwm_workspace
            FOREIGN KEY (workspace_id) REFERENCES kaarya_workspaces (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_workspace_members_user ON kaarya_workspace_members (user_id);
    PRINT 'Created table: kaarya_workspace_members';
END
GO

-- ─── 3. kaarya_boards ─────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_boards')
BEGIN
    CREATE TABLE kaarya_boards (
        id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        workspace_id  UNIQUEIDENTIFIER NOT NULL,
        name          NVARCHAR(255)    NOT NULL,
        description   NVARCHAR(MAX)    NULL,
        color         NVARCHAR(20)     NOT NULL DEFAULT '#1F2937',
        position      INT              NOT NULL DEFAULT 0,
        is_archived   BIT              NOT NULL DEFAULT 0,
        created_at    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kaarya_boards_workspace
            FOREIGN KEY (workspace_id) REFERENCES kaarya_workspaces (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_boards_workspace ON kaarya_boards (workspace_id, position);
    PRINT 'Created table: kaarya_boards';
END
GO

-- ─── 4. kaarya_lists  (the "columns" of a kanban board) ───────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_lists')
BEGIN
    CREATE TABLE kaarya_lists (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        board_id    UNIQUEIDENTIFIER NOT NULL,
        name        NVARCHAR(255)    NOT NULL,
        color       NVARCHAR(20)     NOT NULL DEFAULT '#6B7280',
        position    INT              NOT NULL DEFAULT 0,
        is_archived BIT              NOT NULL DEFAULT 0,
        created_at  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kaarya_lists_board
            FOREIGN KEY (board_id) REFERENCES kaarya_boards (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_lists_board ON kaarya_lists (board_id, position);
    PRINT 'Created table: kaarya_lists';
END
GO

-- ─── 5. kaarya_labels ─────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_labels')
BEGIN
    CREATE TABLE kaarya_labels (
        id        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        board_id  UNIQUEIDENTIFIER NOT NULL,
        name      NVARCHAR(100)    NOT NULL,
        color     NVARCHAR(20)     NOT NULL DEFAULT '#6B7280',
        CONSTRAINT FK_kaarya_labels_board
            FOREIGN KEY (board_id) REFERENCES kaarya_boards (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_labels_board ON kaarya_labels (board_id);
    PRINT 'Created table: kaarya_labels';
END
GO

-- ─── 6. kaarya_cards ──────────────────────────────────────────────────────────
-- `position` is a DECIMAL so cards can be re-ordered without renumbering
-- the whole list (insert halfway between neighbours).

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_cards')
BEGIN
    CREATE TABLE kaarya_cards (
        id                UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        list_id           UNIQUEIDENTIFIER NOT NULL,
        board_id          UNIQUEIDENTIFIER NOT NULL,             -- denormalized
        title             NVARCHAR(500)    NOT NULL,
        description       NVARCHAR(MAX)    NULL,
        position          DECIMAL(20, 10)  NOT NULL DEFAULT 0,
        priority          NVARCHAR(20)     NULL,                 -- 'low' | 'medium' | 'high'
        status            NVARCHAR(50)     NULL,
        due_date          DATETIME2        NULL,
        completed_at      DATETIME2        NULL,
        is_archived       BIT              NOT NULL DEFAULT 0,
        -- Provenance from Karya MOM (Phase 3 cross-link)
        karya_event_id    UNIQUEIDENTIFIER NULL,
        karya_mom_item_id UNIQUEIDENTIFIER NULL,
        created_by        UNIQUEIDENTIFIER NOT NULL,
        created_at        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kaarya_cards_list
            FOREIGN KEY (list_id) REFERENCES kaarya_lists (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_cards_list_pos      ON kaarya_cards (list_id, position);
    CREATE INDEX IX_kaarya_cards_board         ON kaarya_cards (board_id);
    CREATE INDEX IX_kaarya_cards_due_date      ON kaarya_cards (due_date) WHERE due_date IS NOT NULL;
    CREATE INDEX IX_kaarya_cards_karya_mom     ON kaarya_cards (karya_mom_item_id) WHERE karya_mom_item_id IS NOT NULL;
    PRINT 'Created table: kaarya_cards';
END
GO

-- ─── 7. kaarya_card_members ───────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_card_members')
BEGIN
    CREATE TABLE kaarya_card_members (
        card_id  UNIQUEIDENTIFIER NOT NULL,
        user_id  UNIQUEIDENTIFIER NOT NULL,                       -- soft-FK to HubAPI users
        added_at DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_kaarya_card_members PRIMARY KEY (card_id, user_id),
        CONSTRAINT FK_kaarya_card_members_card
            FOREIGN KEY (card_id) REFERENCES kaarya_cards (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_card_members_user ON kaarya_card_members (user_id);
    PRINT 'Created table: kaarya_card_members';
END
GO

-- ─── 8. kaarya_card_labels ────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_card_labels')
BEGIN
    -- NOTE: only the card FK uses CASCADE — MSSQL forbids multiple cascade
    -- paths leading to the same table (label.board_id → board.id is also a
    -- cascade chain). When a label is deleted, application code must DELETE
    -- from kaarya_card_labels first.
    CREATE TABLE kaarya_card_labels (
        card_id  UNIQUEIDENTIFIER NOT NULL,
        label_id UNIQUEIDENTIFIER NOT NULL,
        CONSTRAINT PK_kaarya_card_labels PRIMARY KEY (card_id, label_id),
        CONSTRAINT FK_kaarya_card_labels_card
            FOREIGN KEY (card_id)  REFERENCES kaarya_cards  (id) ON DELETE CASCADE,
        CONSTRAINT FK_kaarya_card_labels_label
            FOREIGN KEY (label_id) REFERENCES kaarya_labels (id) ON DELETE NO ACTION
    );
    PRINT 'Created table: kaarya_card_labels';
END
GO

-- ─── 9. kaarya_card_comments ──────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_card_comments')
BEGIN
    CREATE TABLE kaarya_card_comments (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        card_id     UNIQUEIDENTIFIER NOT NULL,
        author_id   UNIQUEIDENTIFIER NOT NULL,                     -- soft-FK to HubAPI users
        body        NVARCHAR(MAX)    NOT NULL,
        created_at  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kaarya_card_comments_card
            FOREIGN KEY (card_id) REFERENCES kaarya_cards (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_card_comments_card ON kaarya_card_comments (card_id, created_at);
    PRINT 'Created table: kaarya_card_comments';
END
GO

-- ─── 10. kaarya_card_tasks  (checklist subtasks) ──────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_card_tasks')
BEGIN
    CREATE TABLE kaarya_card_tasks (
        id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        card_id      UNIQUEIDENTIFIER NOT NULL,
        text         NVARCHAR(1000)   NOT NULL,
        is_completed BIT              NOT NULL DEFAULT 0,
        completed_at DATETIME2        NULL,
        position     INT              NOT NULL DEFAULT 0,
        CONSTRAINT FK_kaarya_card_tasks_card
            FOREIGN KEY (card_id) REFERENCES kaarya_cards (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_card_tasks_card ON kaarya_card_tasks (card_id, position);
    PRINT 'Created table: kaarya_card_tasks';
END
GO

-- ─── 11. kaarya_activity ──────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'kaarya_activity')
BEGIN
    CREATE TABLE kaarya_activity (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        board_id    UNIQUEIDENTIFIER NOT NULL,
        card_id     UNIQUEIDENTIFIER NULL,
        actor_id    UNIQUEIDENTIFIER NOT NULL,
        event_type  NVARCHAR(50)     NOT NULL,                     -- 'card_created' | 'card_moved' | 'card_completed' | 'comment_added' | ...
        details     NVARCHAR(MAX)    NULL,                         -- JSON payload
        created_at  DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_kaarya_activity_board
            FOREIGN KEY (board_id) REFERENCES kaarya_boards (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_kaarya_activity_board    ON kaarya_activity (board_id, created_at DESC);
    CREATE INDEX IX_kaarya_activity_card     ON kaarya_activity (card_id) WHERE card_id IS NOT NULL;
    PRINT 'Created table: kaarya_activity';
END
GO

PRINT '========================================';
PRINT 'Kaarya schema (Phase 1) — 11 tables';
PRINT '========================================';
