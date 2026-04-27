-- ============================================================
--  Karya (Valuecart MOM) — Microsoft SQL Server
--  TABLE CREATION SCRIPT
--
--  Run this script ONCE on your SQL Server database.
--  All statements are idempotent (safe to re-run).
--  Execute in SQL Server Management Studio (SSMS) or sqlcmd.
-- ============================================================

-- ─── 1. departments ──────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'departments')
BEGIN
    CREATE TABLE departments (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID()      PRIMARY KEY,
        name        NVARCHAR(255)    NOT NULL,
        description NVARCHAR(MAX)    NULL,
        created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT UQ_departments_name UNIQUE (name)
    );
    PRINT 'Created table: departments';
END
GO

-- ─── 2. users ─────────────────────────────────────────────────────────────────
-- Includes all columns from base schema + migration 001 (google tokens)

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'users')
BEGIN
    CREATE TABLE users (
        id                      UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        email                   NVARCHAR(255)    NOT NULL,
        name                    NVARCHAR(255)    NOT NULL,
        password_hash           NVARCHAR(MAX)    NULL,          -- NULL for OAuth-only accounts
        google_id               NVARCHAR(255)    NULL,
        department              NVARCHAR(255)    NULL,          -- free-text display field
        avatar_url              NVARCHAR(MAX)    NULL,
        trello_member_id        NVARCHAR(255)    NULL,
        google_access_token     NVARCHAR(MAX)    NULL,
        google_refresh_token    NVARCHAR(MAX)    NULL,
        google_token_expiry     DATETIME2        NULL,
        microsoft_access_token  NVARCHAR(MAX)    NULL,
        microsoft_refresh_token NVARCHAR(MAX)    NULL,
        microsoft_token_expiry  DATETIME2        NULL,
        created_at              DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT UQ_users_email UNIQUE (email)
    );
    CREATE INDEX IX_users_email ON users (email);
    -- Filtered UNIQUE index: enforce uniqueness only for non-NULL google_id.
    -- (Plain UNIQUE in MSSQL treats NULLs as equal, blocking >1 email/password user.)
    CREATE UNIQUE INDEX UX_users_google_id ON users (google_id) WHERE google_id IS NOT NULL;
    PRINT 'Created table: users';
END
GO

-- ─── 3. user_departments (M2M) ────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'user_departments')
BEGIN
    CREATE TABLE user_departments (
        user_id       UNIQUEIDENTIFIER NOT NULL,
        department_id UNIQUEIDENTIFIER NOT NULL,
        PRIMARY KEY (user_id, department_id),
        CONSTRAINT FK_user_departments_user
            FOREIGN KEY (user_id)       REFERENCES users       (id) ON DELETE CASCADE,
        CONSTRAINT FK_user_departments_dept
            FOREIGN KEY (department_id) REFERENCES departments (id)
    );
    PRINT 'Created table: user_departments';
END
GO

-- ─── 4. events ────────────────────────────────────────────────────────────────
-- Includes migration 007 (reminder_sent_at) and migration 009 (location, source)

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'events')
BEGIN
    CREATE TABLE events (
        id                 UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        google_event_id    NVARCHAR(255)    NULL,
        title              NVARCHAR(500)    NOT NULL,
        description        NVARCHAR(MAX)    NULL,
        location           NVARCHAR(MAX)    NULL,              -- migration 009
        source             NVARCHAR(50)     NOT NULL DEFAULT 'calendar'
                               CONSTRAINT CHK_events_source
                               CHECK (source IN ('calendar','manual')),
        start_time         DATETIME2        NOT NULL,
        end_time           DATETIME2        NOT NULL,
        organizer_email    NVARCHAR(255)    NOT NULL,
        is_external        BIT              NOT NULL DEFAULT 0,
        trello_board_id    NVARCHAR(255)    NULL,
        trello_board_name  NVARCHAR(500)    NULL,
        reminder_sent_at   DATETIME2        NULL,              -- migration 007
        created_at         DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        updated_at         DATETIME2        NOT NULL DEFAULT GETUTCDATE()
    );
    CREATE INDEX IX_events_organizer  ON events (organizer_email);
    CREATE INDEX IX_events_start_time ON events (start_time);
    -- Filtered UNIQUE: a manually-created event has google_event_id = NULL and
    -- multiple of those must be allowed. Only Google-imported events get the
    -- uniqueness check.
    CREATE UNIQUE INDEX UX_events_google_event_id ON events (google_event_id)
      WHERE google_event_id IS NOT NULL;
    PRINT 'Created table: events';
END
GO

-- ─── 5. event_attendees ───────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'event_attendees')
BEGIN
    CREATE TABLE event_attendees (
        event_id        UNIQUEIDENTIFIER NOT NULL,
        user_id         UNIQUEIDENTIFIER NULL,
        email           NVARCHAR(255)    NOT NULL,
        response_status NVARCHAR(20)     NOT NULL DEFAULT 'needsAction'
                            CONSTRAINT CHK_event_attendees_status
                            CHECK (response_status IN ('accepted','declined','tentative','needsAction')),
        PRIMARY KEY (event_id, email),
        CONSTRAINT FK_event_attendees_event
            FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
        CONSTRAINT FK_event_attendees_user
            FOREIGN KEY (user_id)  REFERENCES users  (id) ON DELETE SET NULL
    );
    CREATE INDEX IX_event_attendees_user  ON event_attendees (user_id);
    CREATE INDEX IX_event_attendees_email ON event_attendees (email);
    PRINT 'Created table: event_attendees';
END
GO

-- ─── 6. mom_sessions ──────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'mom_sessions')
BEGIN
    CREATE TABLE mom_sessions (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        event_id    UNIQUEIDENTIFIER NOT NULL,
        created_by  UNIQUEIDENTIFIER NOT NULL,
        status      NVARCHAR(10)     NOT NULL DEFAULT 'draft'
                        CONSTRAINT CHK_mom_sessions_status
                        CHECK (status IN ('draft','final')),
        created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        updated_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_mom_sessions_event
            FOREIGN KEY (event_id)   REFERENCES events (id) ON DELETE CASCADE,
        CONSTRAINT FK_mom_sessions_user
            FOREIGN KEY (created_by) REFERENCES users  (id)
    );
    CREATE INDEX IX_mom_sessions_event      ON mom_sessions (event_id);
    CREATE INDEX IX_mom_sessions_created_by ON mom_sessions (created_by);
    PRINT 'Created table: mom_sessions';
END
GO

-- ─── 7. mom_items ─────────────────────────────────────────────────────────────
-- Includes migration 006 (trello_checklist_item_id)

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'mom_items')
BEGIN
    CREATE TABLE mom_items (
        id                      UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        mom_session_id          UNIQUEIDENTIFIER NOT NULL,
        serial_number           INT              NOT NULL,
        category                NVARCHAR(255)    NOT NULL,
        action_item             NVARCHAR(MAX)    NOT NULL,
        owner_email             NVARCHAR(255)    NULL,
        eta                     DATE             NULL,
        status                  NVARCHAR(20)     NOT NULL DEFAULT 'pending'
                                    CONSTRAINT CHK_mom_items_status
                                    CHECK (status IN ('pending','in-progress','completed')),
        trello_card_id          NVARCHAR(255)    NULL,
        trello_board_id         NVARCHAR(255)    NULL,
        trello_checklist_item_id NVARCHAR(255)   NULL,          -- migration 006
        kaarya_card_id          UNIQUEIDENTIFIER NULL,           -- Phase 3 back-pointer (also ALTERed in 05)
        created_at              DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        updated_at              DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT UQ_mom_items_session_serial UNIQUE (mom_session_id, serial_number),
        CONSTRAINT FK_mom_items_session
            FOREIGN KEY (mom_session_id) REFERENCES mom_sessions (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_mom_items_session     ON mom_items (mom_session_id);
    CREATE INDEX IX_mom_items_owner_email ON mom_items (owner_email);
    CREATE INDEX IX_mom_items_trello_card ON mom_items (trello_card_id);
    PRINT 'Created table: mom_items';
END
GO

-- ─── 8. (removed) trello_mappings ─────────────────────────────────────────────
-- Trello integration was removed in Phase 0; replaced by the Kaarya app.
-- Legacy `trello_*` columns on users/events/mom_items are kept for migration
-- safety but are no longer written to.

-- ─── 9. webhook_settings ──────────────────────────────────────────────────────
-- Migration 003

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'webhook_settings')
BEGIN
    CREATE TABLE webhook_settings (
        id          INT              NOT NULL IDENTITY(1,1) PRIMARY KEY,
        user_id     UNIQUEIDENTIFIER NOT NULL,
        provider    NVARCHAR(50)     NOT NULL,                 -- 'readai' | 'fireflies'
        enabled     BIT              NOT NULL DEFAULT 0,
        webhook_key UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        updated_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT UQ_webhook_settings_user_provider
            UNIQUE (user_id, provider),
        CONSTRAINT FK_webhook_settings_user
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_webhook_settings_key ON webhook_settings (webhook_key);
    PRINT 'Created table: webhook_settings';
END
GO

-- ─── 10. mom_activity_log ─────────────────────────────────────────────────────
-- Migration 004

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'mom_activity_log')
BEGIN
    CREATE TABLE mom_activity_log (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        session_id  UNIQUEIDENTIFIER NOT NULL,
        actor_email NVARCHAR(255)    NOT NULL,
        event_type  NVARCHAR(50)     NOT NULL
                        CONSTRAINT CHK_mom_activity_event_type
                        CHECK (event_type IN (
                            'mom_created','mom_finalized','status_changed',
                            'trello_synced','item_edited','item_deleted'
                        )),
        details     NVARCHAR(MAX)    NULL,                     -- JSON string
        created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_mom_activity_session
            FOREIGN KEY (session_id) REFERENCES mom_sessions (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_mom_activity_session ON mom_activity_log (session_id);
    CREATE INDEX IX_mom_activity_created ON mom_activity_log (created_at DESC);
    PRINT 'Created table: mom_activity_log';
END
GO

-- ─── 11. mom_item_comments ────────────────────────────────────────────────────
-- Migration 008

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'mom_item_comments')
BEGIN
    CREATE TABLE mom_item_comments (
        id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        mom_item_id  UNIQUEIDENTIFIER NOT NULL,
        author_email NVARCHAR(255)    NOT NULL,
        author_name  NVARCHAR(255)    NOT NULL DEFAULT '',
        comment      NVARCHAR(MAX)    NOT NULL,
        created_at   DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT CHK_mom_item_comments_notempty
            CHECK (LEN(LTRIM(RTRIM(comment))) > 0),
        CONSTRAINT FK_mom_item_comments_item
            FOREIGN KEY (mom_item_id) REFERENCES mom_items (id) ON DELETE CASCADE
    );
    CREATE INDEX IX_mom_item_comments_item   ON mom_item_comments (mom_item_id);
    CREATE INDEX IX_mom_item_comments_author ON mom_item_comments (author_email);
    PRINT 'Created table: mom_item_comments';
END
GO

-- ─── 12. conference_rooms ─────────────────────────────────────────────────────
-- Migration 010

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'conference_rooms')
BEGIN
    CREATE TABLE conference_rooms (
        id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        name        NVARCHAR(255)    NOT NULL,
        email       NVARCHAR(255)    NOT NULL,                 -- Google Calendar resource email
        description NVARCHAR(MAX)    NOT NULL DEFAULT '',
        capacity    INT              NULL,
        building    NVARCHAR(255)    NULL,
        floor_label NVARCHAR(100)    NULL,
        created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT UQ_conference_rooms_email UNIQUE (email)
    );
    CREATE INDEX IX_conference_rooms_name ON conference_rooms (name);
    PRINT 'Created table: conference_rooms';
END
GO

PRINT '========================================';
PRINT 'All tables created successfully.';
PRINT '========================================';
