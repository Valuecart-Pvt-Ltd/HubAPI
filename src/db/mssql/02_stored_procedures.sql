-- ============================================================
--  Karya (Valuecart MOM) — Microsoft SQL Server
--  STORED PROCEDURES SCRIPT
--
--  Run this AFTER 01_tables.sql.
--  All procedures use CREATE OR ALTER (SQL Server 2016+).
--  Safe to re-run — procedures are replaced in-place.
-- ============================================================


-- ============================================================
--  SECTION 1 — USERS / AUTH
-- ============================================================

-- ------------------------------------------------------------
-- usp_GetUserByEmail
-- Called by: JWT middleware to verify auth token
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetUserByEmail
    @Email NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, email, name, password_hash, google_id, department, avatar_url,
           trello_member_id, google_access_token, google_refresh_token, google_token_expiry,
           microsoft_access_token, microsoft_refresh_token, microsoft_token_expiry,
           created_at
    FROM   users
    WHERE  email = @Email;
END
GO

-- ------------------------------------------------------------
-- usp_GetUserById
-- Called by: requireAuth middleware
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetUserById
    @UserId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, email, name, password_hash, google_id, department, avatar_url,
           trello_member_id, google_access_token, google_refresh_token, google_token_expiry,
           microsoft_access_token, microsoft_refresh_token, microsoft_token_expiry,
           created_at
    FROM   users
    WHERE  id = @UserId;
END
GO

-- ------------------------------------------------------------
-- usp_UpsertGoogleUser
-- Called by: Google OAuth callback (login + link flows)
-- Creates a new user or updates the existing one matched by
-- google_id or email. Returns the full user row.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpsertGoogleUser
    @GoogleId     NVARCHAR(255),
    @Email        NVARCHAR(255),
    @Name         NVARCHAR(255),
    @AvatarUrl    NVARCHAR(MAX),
    @AccessToken  NVARCHAR(MAX),
    @RefreshToken NVARCHAR(MAX)  = NULL,   -- NULL on token refresh (keep existing)
    @TokenExpiry  DATETIME2      = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM users WHERE google_id = @GoogleId OR email = @Email)
    BEGIN
        UPDATE users
        SET    google_id            = @GoogleId,
               name                 = ISNULL(@Name,         name),
               avatar_url           = ISNULL(@AvatarUrl,    avatar_url),
               google_access_token  = @AccessToken,
               google_refresh_token = ISNULL(@RefreshToken, google_refresh_token),
               google_token_expiry  = @TokenExpiry
        WHERE  google_id = @GoogleId OR email = @Email;
    END
    ELSE
    BEGIN
        INSERT INTO users
            (id, email, name, google_id, avatar_url,
             google_access_token, google_refresh_token, google_token_expiry)
        VALUES
            (NEWID(), @Email, @Name, @GoogleId, @AvatarUrl,
             @AccessToken, @RefreshToken, @TokenExpiry);
    END

    SELECT id, email, name, google_id, department, avatar_url,
           google_access_token, google_refresh_token, google_token_expiry,
           created_at
    FROM   users
    WHERE  google_id = @GoogleId OR email = @Email;
END
GO

-- ------------------------------------------------------------
-- usp_LinkGoogleToUser
-- Called by: /api/auth/google/link/callback
-- Links Google account to an existing email/password user
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_LinkGoogleToUser
    @OriginalUserId UNIQUEIDENTIFIER,
    @GoogleId       NVARCHAR(255),
    @AvatarUrl      NVARCHAR(MAX),
    @AccessToken    NVARCHAR(MAX),
    @RefreshToken   NVARCHAR(MAX) = NULL,
    @TokenExpiry    DATETIME2     = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- If a different user already has this google_id, clear it first
    UPDATE users
    SET    google_id            = NULL,
           google_access_token  = NULL,
           google_refresh_token = NULL,
           google_token_expiry  = NULL
    WHERE  google_id = @GoogleId
      AND  id       != @OriginalUserId;

    -- Link to the original user
    UPDATE users
    SET    google_id            = @GoogleId,
           avatar_url           = ISNULL(@AvatarUrl,    avatar_url),
           google_access_token  = @AccessToken,
           google_refresh_token = ISNULL(@RefreshToken, google_refresh_token),
           google_token_expiry  = @TokenExpiry
    WHERE  id = @OriginalUserId;

    SELECT id, email, name, google_id, department, avatar_url,
           google_access_token, google_refresh_token, google_token_expiry,
           created_at
    FROM   users
    WHERE  id = @OriginalUserId;
END
GO

-- ------------------------------------------------------------
-- usp_UpdateGoogleTokens
-- Called by: OAuth2 token refresh (tokens event on google client)
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpdateGoogleTokens
    @UserId      UNIQUEIDENTIFIER,
    @AccessToken NVARCHAR(MAX),
    @TokenExpiry DATETIME2 = NULL
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE users
    SET    google_access_token = @AccessToken,
           google_token_expiry = @TokenExpiry
    WHERE  id = @UserId;
END
GO

-- ------------------------------------------------------------
-- usp_RegisterUser
-- Called by: POST /api/auth/register (email+password signup)
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_RegisterUser
    @Email        NVARCHAR(255),
    @Name         NVARCHAR(255),
    @PasswordHash NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM users WHERE email = @Email)
    BEGIN
        RAISERROR('EMAIL_TAKEN', 16, 1);
        RETURN;
    END

    DECLARE @NewId UNIQUEIDENTIFIER = NEWID();
    INSERT INTO users (id, email, name, password_hash)
    VALUES (@NewId, @Email, @Name, @PasswordHash);

    SELECT id, email, name, department, avatar_url, created_at
    FROM   users
    WHERE  id = @NewId;
END
GO

-- ------------------------------------------------------------
-- usp_UpdateUserProfile
-- Called by: PATCH /api/users/profile
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpdateUserProfile
    @UserId     UNIQUEIDENTIFIER,
    @Name       NVARCHAR(255)  = NULL,
    @Department NVARCHAR(255)  = NULL,
    @AvatarUrl  NVARCHAR(MAX)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE users
    SET    name       = ISNULL(@Name,       name),
           department = ISNULL(@Department, department),
           avatar_url = ISNULL(@AvatarUrl,  avatar_url)
    WHERE  id = @UserId;

    SELECT id, email, name, department, avatar_url, created_at
    FROM   users WHERE id = @UserId;
END
GO

-- ------------------------------------------------------------
-- usp_UpdateMicrosoftTokens
-- Called by: Microsoft OAuth callback
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpdateMicrosoftTokens
    @UserId       UNIQUEIDENTIFIER,
    @AccessToken  NVARCHAR(MAX),
    @RefreshToken NVARCHAR(MAX) = NULL,
    @TokenExpiry  DATETIME2     = NULL
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE users
    SET    microsoft_access_token  = @AccessToken,
           microsoft_refresh_token = ISNULL(@RefreshToken, microsoft_refresh_token),
           microsoft_token_expiry  = @TokenExpiry
    WHERE  id = @UserId;
END
GO


-- ============================================================
--  SECTION 2 — EVENTS
-- ============================================================

-- ------------------------------------------------------------
-- usp_GetEventList
-- Called by: GET /api/events
-- Returns paginated events for a user (organizer or attendee)
-- with attendees and departments as JSON strings.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetEventList
    @UserEmail NVARCHAR(255),
    @Page      INT = 1,
    @PageSize  INT = 25
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Offset INT = (@Page - 1) * @PageSize;

    -- Total count
    SELECT COUNT(DISTINCT e.id) AS total
    FROM   events e
    LEFT JOIN event_attendees ea ON ea.event_id = e.id
    WHERE  e.organizer_email = @UserEmail OR ea.email = @UserEmail;

    -- Paged result set
    SELECT
        e.id,
        e.google_event_id,
        e.title,
        e.description,
        e.location,
        e.start_time,
        e.end_time,
        e.organizer_email,
        e.is_external,
        e.trello_board_id,
        e.trello_board_name,
        e.created_at,
        e.updated_at,
        -- Attendees as JSON array
        (SELECT ea2.email,
                ISNULL(u2.name, ea2.email)      AS name,
                ea2.response_status              AS responseStatus,
                u2.department
         FROM   event_attendees ea2
         LEFT JOIN users u2 ON u2.email = ea2.email
         WHERE  ea2.event_id = e.id
         FOR JSON PATH)                          AS attendees_json,
        -- Departments as JSON array
        (SELECT DISTINCT tm.trello_board_name AS department
         FROM   trello_mappings tm
         WHERE  tm.user_email = e.organizer_email
         FOR JSON PATH)                          AS departments_json,
        -- Latest MOM session
        lm.id           AS mom_session_id,
        lm.status       AS mom_status
    FROM events e
    LEFT JOIN (
        SELECT DISTINCT ms.id, ms.event_id, ms.status,
               ROW_NUMBER() OVER (PARTITION BY ms.event_id ORDER BY ms.created_at DESC) AS rn
        FROM mom_sessions ms
    ) lm ON lm.event_id = e.id AND lm.rn = 1
    WHERE e.id IN (
        SELECT id        FROM events         WHERE organizer_email = @UserEmail
        UNION
        SELECT event_id  FROM event_attendees WHERE email = @UserEmail
    )
    ORDER BY e.start_time ASC
    OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;
END
GO

-- ------------------------------------------------------------
-- usp_GetEventDetail
-- Called by: GET /api/events/:eventId
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetEventDetail
    @EventId   UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    -- Check access
    IF NOT EXISTS (
        SELECT 1 FROM events         WHERE id = @EventId AND organizer_email = @UserEmail
        UNION ALL
        SELECT 1 FROM event_attendees WHERE event_id = @EventId AND email = @UserEmail
    )
    BEGIN
        -- Return empty; caller checks row count to determine 403 vs 404
        SELECT 0 AS has_access;
        RETURN;
    END

    SELECT 1 AS has_access;

    SELECT
        e.id,
        e.google_event_id,
        e.title,
        e.description,
        e.location,
        e.start_time,
        e.end_time,
        e.organizer_email,
        e.is_external,
        e.trello_board_id,
        e.trello_board_name,
        e.created_at,
        e.updated_at,
        (SELECT ea2.email,
                ISNULL(u2.name, ea2.email) AS name,
                ea2.response_status        AS responseStatus,
                u2.department
         FROM   event_attendees ea2
         LEFT JOIN users u2 ON u2.email = ea2.email
         WHERE  ea2.event_id = e.id
         FOR JSON PATH) AS attendees_json,
        lm.id     AS mom_session_id,
        lm.status AS mom_status
    FROM events e
    LEFT JOIN (
        SELECT ms.id, ms.event_id, ms.status,
               ROW_NUMBER() OVER (PARTITION BY ms.event_id ORDER BY ms.created_at DESC) AS rn
        FROM mom_sessions ms
    ) lm ON lm.event_id = e.id AND lm.rn = 1
    WHERE e.id = @EventId;

    -- MOM items (if session exists)
    SELECT mi.id, mi.serial_number, mi.category, mi.action_item,
           mi.owner_email, mi.eta, mi.status, mi.trello_card_id, mi.trello_board_id
    FROM   mom_items mi
    JOIN   mom_sessions ms ON ms.id = mi.mom_session_id
    WHERE  ms.event_id = @EventId
      AND  ms.id = (
               SELECT TOP 1 id FROM mom_sessions
               WHERE event_id = @EventId
               ORDER BY created_at DESC
           )
    ORDER BY mi.serial_number ASC;
END
GO

-- ------------------------------------------------------------
-- usp_CreateEvent
-- Called by: POST /api/events
-- Inserts event + attendees, returns full event row.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_CreateEvent
    @Title          NVARCHAR(500),
    @Description    NVARCHAR(MAX)  = NULL,
    @Location       NVARCHAR(MAX)  = NULL,
    @StartTime      DATETIME2,
    @EndTime        DATETIME2,
    @OrganizerEmail NVARCHAR(255),
    @IsExternal     BIT            = 0,
    @AttendeeEmails NVARCHAR(MAX)  = NULL   -- JSON array: ["a@b.com","c@d.com"]
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        DECLARE @EventId UNIQUEIDENTIFIER = NEWID();

        INSERT INTO events
            (id, title, description, location, start_time, end_time,
             organizer_email, is_external, source)
        VALUES
            (@EventId, @Title, @Description, @Location, @StartTime, @EndTime,
             @OrganizerEmail, @IsExternal, 'manual');

        -- Insert organizer as accepted attendee
        INSERT INTO event_attendees (event_id, user_id, email, response_status)
        SELECT @EventId,
               (SELECT id FROM users WHERE email = @OrganizerEmail),
               @OrganizerEmail,
               'accepted'
        WHERE NOT EXISTS (
            SELECT 1 FROM event_attendees
            WHERE event_id = @EventId AND email = @OrganizerEmail
        );

        -- Insert other attendees from JSON array
        IF @AttendeeEmails IS NOT NULL AND LEN(@AttendeeEmails) > 2
        BEGIN
            INSERT INTO event_attendees (event_id, user_id, email, response_status)
            SELECT @EventId,
                   (SELECT id FROM users WHERE email = j.email),
                   j.email,
                   'needsAction'
            FROM   OPENJSON(@AttendeeEmails)
                   WITH (email NVARCHAR(255) '$') AS j
            WHERE  j.email != @OrganizerEmail
              AND  NOT EXISTS (
                       SELECT 1 FROM event_attendees
                       WHERE event_id = @EventId AND email = j.email
                   );
        END

        COMMIT TRANSACTION;

        -- Return created event
        EXEC usp_GetEventDetail @EventId = @EventId, @UserEmail = @OrganizerEmail;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- ------------------------------------------------------------
-- usp_UpdateEvent
-- Called by: PATCH /api/events/:eventId
-- Only updates fields that are passed (NULL = no change).
-- Use @ForceNull* flags to explicitly set a field to NULL.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpdateEvent
    @EventId         UNIQUEIDENTIFIER,
    @UserEmail       NVARCHAR(255),
    @Title           NVARCHAR(500) = NULL,
    @Description     NVARCHAR(MAX) = NULL,
    @SetDescNull     BIT           = 0,    -- 1 = set description to NULL
    @Location        NVARCHAR(MAX) = NULL,
    @SetLocationNull BIT           = 0,    -- 1 = set location to NULL
    @StartTime       DATETIME2     = NULL,
    @EndTime         DATETIME2     = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- Access check
    IF NOT EXISTS (
        SELECT 1 FROM events         WHERE id = @EventId AND organizer_email = @UserEmail
        UNION ALL
        SELECT 1 FROM event_attendees WHERE event_id = @EventId AND email = @UserEmail
    )
    BEGIN
        IF EXISTS (SELECT 1 FROM events WHERE id = @EventId)
            RAISERROR('FORBIDDEN', 16, 1);
        ELSE
            RAISERROR('NOT_FOUND', 16, 1);
        RETURN;
    END

    UPDATE events
    SET
        title       = CASE WHEN @Title       IS NOT NULL THEN @Title       ELSE title       END,
        description = CASE WHEN @SetDescNull = 1         THEN NULL
                           WHEN @Description IS NOT NULL THEN @Description ELSE description END,
        location    = CASE WHEN @SetLocationNull = 1     THEN NULL
                           WHEN @Location  IS NOT NULL   THEN @Location    ELSE location    END,
        start_time  = CASE WHEN @StartTime  IS NOT NULL  THEN @StartTime   ELSE start_time  END,
        end_time    = CASE WHEN @EndTime    IS NOT NULL   THEN @EndTime    ELSE end_time    END,
        updated_at  = GETUTCDATE()
    WHERE id = @EventId;

    -- Return updated event
    SELECT
        e.id, e.google_event_id, e.title, e.description, e.location,
        e.start_time, e.end_time, e.organizer_email, e.is_external,
        e.trello_board_id, e.trello_board_name, e.created_at, e.updated_at,
        (SELECT ea.email, ISNULL(u.name, ea.email) AS name,
                ea.response_status AS responseStatus, u.department
         FROM   event_attendees ea
         LEFT JOIN users u ON u.email = ea.email
         WHERE  ea.event_id = e.id
         FOR JSON PATH) AS attendees_json
    FROM  events e
    WHERE e.id = @EventId;
END
GO

-- ------------------------------------------------------------
-- usp_GetNextEvent
-- Called by: GET /api/events/:eventId/next
-- Returns nearest future event with same title after current event ends.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetNextEvent
    @EventId   UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Title   NVARCHAR(500);
    DECLARE @EndTime DATETIME2;

    SELECT @Title = title, @EndTime = end_time
    FROM   events WHERE id = @EventId;

    IF @Title IS NULL
    BEGIN
        RAISERROR('NOT_FOUND', 16, 1); RETURN;
    END

    SELECT TOP 1
        e.id, e.google_event_id, e.title, e.description, e.location,
        e.start_time, e.end_time, e.organizer_email, e.is_external,
        e.trello_board_id, e.trello_board_name, e.created_at, e.updated_at,
        (SELECT ea2.email, ISNULL(u2.name, ea2.email) AS name,
                ea2.response_status AS responseStatus, u2.department
         FROM   event_attendees ea2
         LEFT JOIN users u2 ON u2.email = ea2.email
         WHERE  ea2.event_id = e.id
         FOR JSON PATH) AS attendees_json
    FROM  events e
    WHERE e.id        != @EventId
      AND LOWER(e.title) = LOWER(@Title)
      AND e.start_time   > @EndTime
      AND e.start_time   > GETUTCDATE()
      AND e.id IN (
          SELECT id       FROM events          WHERE organizer_email = @UserEmail
          UNION
          SELECT event_id FROM event_attendees WHERE email = @UserEmail
      )
    ORDER BY e.start_time ASC;
END
GO

-- ------------------------------------------------------------
-- usp_BulkUpsertCalendarEvents
-- Called by: calendar sync service
-- Uses a temp table to receive events, then MERGE into events table.
-- Pass events as JSON array of objects.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_BulkUpsertCalendarEvents
    @EventsJson NVARCHAR(MAX)   -- JSON array of event objects
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        -- Parse JSON into temp table
        SELECT
            j.google_event_id,
            j.title,
            j.description,
            CAST(j.start_time AS DATETIME2) AS start_time,
            CAST(j.end_time   AS DATETIME2) AS end_time,
            j.organizer_email,
            CAST(j.is_external AS BIT)      AS is_external,
            j.trello_board_id,
            j.trello_board_name
        INTO #TempEvents
        FROM OPENJSON(@EventsJson) WITH (
            google_event_id   NVARCHAR(255) '$.googleEventId',
            title             NVARCHAR(500) '$.title',
            description       NVARCHAR(MAX) '$.description',
            start_time        NVARCHAR(50)  '$.startTime',
            end_time          NVARCHAR(50)  '$.endTime',
            organizer_email   NVARCHAR(255) '$.organizerEmail',
            is_external       NVARCHAR(5)   '$.isExternal',
            trello_board_id   NVARCHAR(255) '$.trelloBoardId',
            trello_board_name NVARCHAR(500) '$.trelloBoardName'
        ) AS j;

        -- MERGE into events
        MERGE events AS target
        USING #TempEvents AS src
        ON    target.google_event_id = src.google_event_id
        WHEN MATCHED THEN
            UPDATE SET
                title             = src.title,
                description       = src.description,
                start_time        = src.start_time,
                end_time          = src.end_time,
                is_external       = src.is_external,
                trello_board_id   = ISNULL(src.trello_board_id,   target.trello_board_id),
                trello_board_name = ISNULL(src.trello_board_name, target.trello_board_name),
                updated_at        = GETUTCDATE()
        WHEN NOT MATCHED THEN
            INSERT (id, google_event_id, title, description, start_time, end_time,
                    organizer_email, is_external, trello_board_id, trello_board_name)
            VALUES (NEWID(), src.google_event_id, src.title, src.description,
                    src.start_time, src.end_time, src.organizer_email, src.is_external,
                    src.trello_board_id, src.trello_board_name);

        DROP TABLE #TempEvents;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF OBJECT_ID('tempdb..#TempEvents') IS NOT NULL DROP TABLE #TempEvents;
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- ------------------------------------------------------------
-- usp_BulkUpsertAttendees
-- Called by: calendar sync, after usp_BulkUpsertCalendarEvents
-- Receives attendees as JSON array.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_BulkUpsertAttendees
    @AttendeesJson NVARCHAR(MAX)   -- JSON: [{"eventId":"...","email":"...","status":"..."}]
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        SELECT
            CAST(j.event_id AS UNIQUEIDENTIFIER) AS event_id,
            j.email,
            j.response_status
        INTO #TempAttendees
        FROM OPENJSON(@AttendeesJson) WITH (
            event_id        NVARCHAR(36)  '$.eventId',
            email           NVARCHAR(255) '$.email',
            response_status NVARCHAR(20)  '$.responseStatus'
        ) AS j;

        MERGE event_attendees AS target
        USING (
            SELECT ta.event_id, ta.email, ta.response_status,
                   u.id AS user_id
            FROM   #TempAttendees ta
            LEFT JOIN users u ON u.email = ta.email
        ) AS src
        ON target.event_id = src.event_id AND target.email = src.email
        WHEN MATCHED THEN
            UPDATE SET
                user_id         = ISNULL(src.user_id, target.user_id),
                response_status = src.response_status
        WHEN NOT MATCHED THEN
            INSERT (event_id, user_id, email, response_status)
            VALUES (src.event_id, src.user_id, src.email, src.response_status);

        DROP TABLE #TempAttendees;
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF OBJECT_ID('tempdb..#TempAttendees') IS NOT NULL DROP TABLE #TempAttendees;
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- ------------------------------------------------------------
-- usp_GetUsersForCalendarSync
-- Called by: cron job to fetch all users with Google tokens
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetUsersForCalendarSync
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, email, google_access_token, google_refresh_token, google_token_expiry
    FROM   users
    WHERE  google_refresh_token IS NOT NULL;
END
GO

-- ------------------------------------------------------------
-- usp_GetUpcomingMeetingsForReminder
-- Called by: daily reminder cron (08:00)
-- Returns events starting in 48-72h window, reminder not yet sent.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetUpcomingMeetingsForReminder
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        e.id,
        e.title,
        e.start_time,
        e.end_time,
        e.organizer_email,
        (SELECT ea.email
         FROM   event_attendees ea
         WHERE  ea.event_id = e.id
         FOR JSON PATH) AS attendees_json
    FROM events e
    WHERE e.start_time >= DATEADD(HOUR, 48, GETUTCDATE())
      AND e.start_time <  DATEADD(HOUR, 72, GETUTCDATE())
      AND e.reminder_sent_at IS NULL;
END
GO

-- ------------------------------------------------------------
-- usp_MarkReminderSent
-- Called by: after sendReminderEmail succeeds
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_MarkReminderSent
    @EventId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE events SET reminder_sent_at = GETUTCDATE() WHERE id = @EventId;
END
GO


-- ============================================================
--  SECTION 3 — CONFERENCE ROOMS
-- ============================================================

-- ------------------------------------------------------------
-- usp_GetRooms
-- Called by: GET /api/events/rooms
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetRooms
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, name, email, description, capacity, building, floor_label, created_at
    FROM   conference_rooms
    ORDER BY name ASC;
END
GO

-- ------------------------------------------------------------
-- usp_UpsertRoom
-- Called by: POST /api/events/rooms
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpsertRoom
    @Name        NVARCHAR(255),
    @Email       NVARCHAR(255),
    @Description NVARCHAR(MAX) = '',
    @Capacity    INT           = NULL,
    @Building    NVARCHAR(255) = NULL,
    @FloorLabel  NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    MERGE conference_rooms AS target
    USING (SELECT LOWER(@Email) AS email) AS src
    ON    target.email = src.email
    WHEN MATCHED THEN
        UPDATE SET
            name        = @Name,
            description = @Description,
            capacity    = @Capacity,
            building    = @Building,
            floor_label = @FloorLabel
    WHEN NOT MATCHED THEN
        INSERT (id, name, email, description, capacity, building, floor_label)
        VALUES (NEWID(), @Name, LOWER(@Email), @Description, @Capacity, @Building, @FloorLabel);

    SELECT id, name, email, description, capacity, building, floor_label
    FROM   conference_rooms
    WHERE  email = LOWER(@Email);
END
GO

-- ------------------------------------------------------------
-- usp_DeleteRoom
-- Called by: DELETE /api/events/rooms/:roomEmail
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_DeleteRoom
    @Email NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM conference_rooms WHERE email = LOWER(@Email);
END
GO


-- ============================================================
--  SECTION 4 — MOM SESSIONS
-- ============================================================

-- ------------------------------------------------------------
-- usp_CheckEventAccess
-- Shared helper — returns 1 row if user can access the event.
-- Returns isOrganizer flag so callers can check edit rights.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_CheckEventAccess
    @EventId   UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        CASE WHEN e.organizer_email = @UserEmail THEN 1 ELSE 0 END AS is_organizer,
        CASE WHEN EXISTS (
            SELECT 1 FROM event_attendees ea
            WHERE ea.event_id = e.id AND ea.email = @UserEmail
        ) THEN 1 ELSE 0 END AS is_attendee
    FROM events e
    WHERE e.id = @EventId;
END
GO

-- ------------------------------------------------------------
-- usp_GetMOMSession
-- Called by: GET /api/mom/:eventId
-- Returns latest session + items. Returns empty if none exists.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetMOMSession
    @EventId   UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    -- Access check
    EXEC usp_CheckEventAccess @EventId = @EventId, @UserEmail = @UserEmail;

    -- Session
    SELECT TOP 1
        ms.id, ms.event_id, ms.status, ms.created_at, ms.updated_at
    FROM mom_sessions ms
    WHERE ms.event_id = @EventId
    ORDER BY ms.created_at DESC;

    -- Items for that session
    SELECT mi.id, mi.serial_number, mi.category, mi.action_item,
           mi.owner_email, mi.eta, mi.status, mi.trello_card_id, mi.trello_board_id
    FROM   mom_items mi
    WHERE  mi.mom_session_id = (
               SELECT TOP 1 id FROM mom_sessions
               WHERE event_id = @EventId
               ORDER BY created_at DESC
           )
    ORDER BY mi.serial_number ASC;
END
GO

-- ------------------------------------------------------------
-- usp_SaveMOMSession
-- Called by: POST /api/mom
-- Creates or updates a MOM session and replaces all items
-- atomically. Returns session + saved items.
-- @ItemsJson: JSON array of item objects.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_SaveMOMSession
    @EventId    UNIQUEIDENTIFIER,
    @Status     NVARCHAR(10),       -- 'draft' | 'final'
    @UserId     UNIQUEIDENTIFIER,
    @ItemsJson  NVARCHAR(MAX)       -- JSON array of items
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        DECLARE @SessionId       UNIQUEIDENTIFIER;
        DECLARE @IsNew           BIT = 0;
        DECLARE @WasAlreadyFinal BIT = 0;
        DECLARE @PrevStatus      NVARCHAR(10) = 'draft';

        -- Get or create session
        SELECT TOP 1
            @SessionId  = id,
            @PrevStatus = status
        FROM mom_sessions
        WHERE event_id = @EventId
        ORDER BY created_at DESC;

        IF @SessionId IS NOT NULL
        BEGIN
            SET @WasAlreadyFinal = CASE WHEN @PrevStatus = 'final' THEN 1 ELSE 0 END;
            UPDATE mom_sessions
            SET    status = @Status, updated_at = GETUTCDATE()
            WHERE  id = @SessionId;
        END
        ELSE
        BEGIN
            SET @SessionId = NEWID();
            SET @IsNew     = 1;
            INSERT INTO mom_sessions (id, event_id, status, created_by)
            VALUES (@SessionId, @EventId, @Status, @UserId);
        END

        -- Replace all items
        DELETE FROM mom_items WHERE mom_session_id = @SessionId;

        INSERT INTO mom_items
            (id, mom_session_id, serial_number, category, action_item,
             owner_email, eta, status, trello_board_id)
        SELECT
            NEWID(),
            @SessionId,
            ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS serial_number,
            ISNULL(j.category, ''),
            ISNULL(j.action_item, ''),
            NULLIF(j.owner_email, ''),
            CASE WHEN j.eta IS NULL OR j.eta = '' THEN NULL ELSE CAST(j.eta AS DATE) END,
            ISNULL(j.status, 'pending'),
            NULLIF(j.trello_board_id, '')
        FROM OPENJSON(@ItemsJson) WITH (
            category       NVARCHAR(255) '$.category',
            action_item    NVARCHAR(MAX) '$.actionItem',
            owner_email    NVARCHAR(255) '$.ownerEmail',
            eta            NVARCHAR(20)  '$.eta',
            status         NVARCHAR(20)  '$.status',
            trello_board_id NVARCHAR(255) '$.trelloBoardId'
        ) AS j;

        COMMIT TRANSACTION;

        -- Return control flags
        SELECT @SessionId AS session_id, @IsNew AS is_new, @WasAlreadyFinal AS was_already_final;

        -- Return session
        SELECT id, event_id, status, created_at, updated_at
        FROM   mom_sessions WHERE id = @SessionId;

        -- Return items
        SELECT id, serial_number, category, action_item,
               owner_email, eta, status, trello_card_id, trello_board_id
        FROM   mom_items
        WHERE  mom_session_id = @SessionId
        ORDER BY serial_number ASC;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- ------------------------------------------------------------
-- usp_UpdateMOMItem
-- Called by: PATCH /api/mom/item/:itemId
-- Partial update — only supplied fields are changed.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpdateMOMItem
    @ItemId      UNIQUEIDENTIFIER,
    @UserEmail   NVARCHAR(255),
    @Status      NVARCHAR(20)  = NULL,
    @Category    NVARCHAR(255) = NULL,
    @ActionItem  NVARCHAR(MAX) = NULL,
    @OwnerEmail  NVARCHAR(255) = NULL,
    @SetOwnerNull BIT          = 0,
    @Eta         NVARCHAR(20)  = NULL,
    @SetEtaNull  BIT           = 0
AS
BEGIN
    SET NOCOUNT ON;

    -- Fetch item + access check in one query
    DECLARE @SessionId      UNIQUEIDENTIFIER;
    DECLARE @OrgEmail       NVARCHAR(255);
    DECLARE @IsAttendee     BIT = 0;
    DECLARE @OldStatus      NVARCHAR(20);
    DECLARE @OldActionItem  NVARCHAR(MAX);
    DECLARE @TrelloCardId   NVARCHAR(255);
    DECLARE @TrelloBoardId  NVARCHAR(255);

    SELECT
        @SessionId     = ms.id,
        @OrgEmail      = e.organizer_email,
        @IsAttendee    = CAST(CASE WHEN EXISTS (
                             SELECT 1 FROM event_attendees ea
                             WHERE ea.event_id = e.id AND ea.email = @UserEmail
                         ) THEN 1 ELSE 0 END AS BIT),
        @OldStatus     = mi.status,
        @OldActionItem = mi.action_item,
        @TrelloCardId  = mi.trello_card_id,
        @TrelloBoardId = mi.trello_board_id
    FROM  mom_items mi
    JOIN  mom_sessions ms ON ms.id = mi.mom_session_id
    JOIN  events e         ON e.id  = ms.event_id
    WHERE mi.id = @ItemId;

    IF @SessionId IS NULL
    BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    IF @OrgEmail != @UserEmail AND @IsAttendee = 0
    BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    UPDATE mom_items
    SET
        status      = CASE WHEN @Status      IS NOT NULL THEN @Status      ELSE status      END,
        category    = CASE WHEN @Category    IS NOT NULL THEN @Category    ELSE category    END,
        action_item = CASE WHEN @ActionItem  IS NOT NULL THEN LTRIM(RTRIM(@ActionItem)) ELSE action_item END,
        owner_email = CASE WHEN @SetOwnerNull = 1        THEN NULL
                          WHEN @OwnerEmail  IS NOT NULL  THEN @OwnerEmail  ELSE owner_email END,
        eta         = CASE WHEN @SetEtaNull  = 1         THEN NULL
                          WHEN @Eta         IS NOT NULL  THEN CAST(@Eta AS DATE) ELSE eta  END,
        updated_at  = GETUTCDATE()
    WHERE id = @ItemId;

    -- Return updated item + context for Trello/activity caller
    SELECT mi.id, mi.serial_number, mi.category, mi.action_item,
           mi.owner_email, mi.eta, mi.status, mi.trello_card_id, mi.trello_board_id,
           @SessionId     AS mom_session_id,
           @OldStatus     AS old_status,
           @OldActionItem AS old_action_item,
           @TrelloCardId  AS trello_card_id_hint
    FROM   mom_items mi WHERE mi.id = @ItemId;
END
GO

-- ------------------------------------------------------------
-- usp_DeleteMOMItem
-- Called by: DELETE /api/mom/item/:itemId
-- Removes item and re-sequences remaining items in the session.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_DeleteMOMItem
    @ItemId    UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        DECLARE @SessionId     UNIQUEIDENTIFIER;
        DECLARE @OrgEmail      NVARCHAR(255);
        DECLARE @IsAttendee    BIT = 0;
        DECLARE @TrelloCardId  NVARCHAR(255);
        DECLARE @ActionItem    NVARCHAR(MAX);

        SELECT
            @SessionId    = ms.id,
            @OrgEmail     = e.organizer_email,
            @IsAttendee   = CAST(CASE WHEN EXISTS (
                                SELECT 1 FROM event_attendees ea
                                WHERE ea.event_id = e.id AND ea.email = @UserEmail
                            ) THEN 1 ELSE 0 END AS BIT),
            @TrelloCardId = mi.trello_card_id,
            @ActionItem   = mi.action_item
        FROM  mom_items mi
        JOIN  mom_sessions ms ON ms.id = mi.mom_session_id
        JOIN  events e         ON e.id  = ms.event_id
        WHERE mi.id = @ItemId;

        IF @SessionId IS NULL
        BEGIN ROLLBACK; RAISERROR('NOT_FOUND', 16, 1); RETURN; END

        IF @OrgEmail != @UserEmail AND @IsAttendee = 0
        BEGIN ROLLBACK; RAISERROR('FORBIDDEN', 16, 1); RETURN; END

        -- Delete the item (cascades to mom_item_comments)
        DELETE FROM mom_items WHERE id = @ItemId;

        -- Re-sequence remaining items
        WITH Numbered AS (
            SELECT id,
                   ROW_NUMBER() OVER (ORDER BY serial_number ASC) AS new_serial
            FROM   mom_items
            WHERE  mom_session_id = @SessionId
        )
        UPDATE mi
        SET    mi.serial_number = n.new_serial
        FROM   mom_items mi
        JOIN   Numbered  n  ON n.id = mi.id;

        COMMIT TRANSACTION;

        -- Return context for caller (Trello archiving, activity log)
        SELECT @ItemId        AS id,
               @SessionId     AS mom_session_id,
               @TrelloCardId  AS trello_card_id,
               @ActionItem    AS action_item;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- ------------------------------------------------------------
-- usp_SearchMOM
-- Called by: GET /api/mom/search?q=keyword
-- Full-text search across action_item and category.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_SearchMOM
    @UserEmail NVARCHAR(255),
    @Query     NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Like NVARCHAR(257) = N'%' + @Query + N'%';

    SELECT TOP 100
        mi.id, mi.serial_number, mi.category, mi.action_item,
        mi.owner_email, mi.eta, mi.status, mi.trello_card_id, mi.trello_board_id,
        ms.id     AS mom_session_id,
        ms.status AS session_status,
        e.id      AS event_id,
        e.title   AS event_title,
        e.start_time AS event_start
    FROM  mom_items mi
    JOIN  mom_sessions ms ON ms.id = mi.mom_session_id
    JOIN  events e         ON e.id  = ms.event_id
    WHERE (
        e.organizer_email = @UserEmail
        OR EXISTS (
            SELECT 1 FROM event_attendees ea
            WHERE ea.event_id = e.id AND ea.email = @UserEmail
        )
    )
    AND (
        mi.action_item LIKE @Like
        OR mi.category LIKE @Like
    )
    ORDER BY e.start_time DESC, mi.serial_number ASC;
END
GO

-- ------------------------------------------------------------
-- usp_GetPreviousMOM
-- Called by: GET /api/mom/previous/:eventId
-- Returns most recent finalized MOM from same-titled event.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetPreviousMOM
    @EventId   UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Title NVARCHAR(500);
    SELECT @Title = title FROM events WHERE id = @EventId;

    IF @Title IS NULL
    BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    DECLARE @PrevSessionId UNIQUEIDENTIFIER;
    DECLARE @PrevEventId   UNIQUEIDENTIFIER;
    DECLARE @PrevStart     DATETIME2;

    SELECT TOP 1
        @PrevSessionId = ms.id,
        @PrevEventId   = e.id,
        @PrevStart     = e.start_time
    FROM  mom_sessions ms
    JOIN  events e ON e.id = ms.event_id
    WHERE e.title   = @Title
      AND e.id     != @EventId
      AND ms.status = 'final'
    ORDER BY e.start_time DESC;

    IF @PrevSessionId IS NULL
    BEGIN
        SELECT NULL AS session_id; RETURN;
    END

    SELECT @PrevSessionId AS session_id, @PrevEventId AS event_id, @PrevStart AS event_start;

    SELECT id, serial_number, category, action_item,
           owner_email, eta, status, trello_card_id, trello_board_id
    FROM   mom_items
    WHERE  mom_session_id = @PrevSessionId
    ORDER BY serial_number ASC;
END
GO

-- ------------------------------------------------------------
-- usp_GetMOMActivity
-- Called by: GET /api/mom/:eventId/activity
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetMOMActivity
    @EventId   UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    EXEC usp_CheckEventAccess @EventId = @EventId, @UserEmail = @UserEmail;

    SELECT TOP 50
        al.id, al.actor_email, al.event_type, al.details, al.created_at
    FROM  mom_activity_log al
    JOIN  mom_sessions ms ON ms.id = al.session_id
    WHERE ms.event_id = @EventId
    ORDER BY al.created_at DESC;
END
GO

-- ------------------------------------------------------------
-- usp_LogMOMActivity
-- Called by: any route that modifies a MOM session/item
-- Non-fatal — errors should be caught by caller.
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_LogMOMActivity
    @SessionId  UNIQUEIDENTIFIER,
    @ActorEmail NVARCHAR(255),
    @EventType  NVARCHAR(50),
    @Details    NVARCHAR(MAX) = NULL   -- JSON string
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO mom_activity_log (id, session_id, actor_email, event_type, details)
    VALUES (NEWID(), @SessionId, @ActorEmail, @EventType, @Details);
END
GO


-- ============================================================
--  SECTION 5 — MOM ITEM COMMENTS
-- ============================================================

-- ------------------------------------------------------------
-- usp_GetItemComments
-- Called by: GET /api/mom/item/:itemId/comments
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetItemComments
    @ItemId    UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;

    -- Access check
    IF NOT EXISTS (
        SELECT 1
        FROM  mom_items mi
        JOIN  mom_sessions ms ON ms.id = mi.mom_session_id
        JOIN  events e         ON e.id  = ms.event_id
        WHERE mi.id = @ItemId
          AND (
              e.organizer_email = @UserEmail
              OR EXISTS (
                  SELECT 1 FROM event_attendees ea
                  WHERE ea.event_id = e.id AND ea.email = @UserEmail
              )
          )
    )
    BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    SELECT id, author_email, author_name, comment, created_at
    FROM   mom_item_comments
    WHERE  mom_item_id = @ItemId
    ORDER BY created_at ASC;
END
GO

-- ------------------------------------------------------------
-- usp_AddItemComment
-- Called by: POST /api/mom/item/:itemId/comment
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_AddItemComment
    @ItemId    UNIQUEIDENTIFIER,
    @UserEmail NVARCHAR(255),
    @Comment   NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    -- Access check + resolve author name
    DECLARE @OrgEmail   NVARCHAR(255);
    DECLARE @IsAttendee BIT = 0;
    DECLARE @AuthorName NVARCHAR(255);

    SELECT
        @OrgEmail    = e.organizer_email,
        @IsAttendee  = CAST(CASE WHEN EXISTS (
                           SELECT 1 FROM event_attendees ea
                           WHERE ea.event_id = e.id AND ea.email = @UserEmail
                       ) THEN 1 ELSE 0 END AS BIT),
        @AuthorName  = ISNULL(u.name, @UserEmail)
    FROM  mom_items mi
    JOIN  mom_sessions ms ON ms.id = mi.mom_session_id
    JOIN  events e         ON e.id  = ms.event_id
    LEFT JOIN users u      ON u.email = @UserEmail
    WHERE mi.id = @ItemId;

    IF @OrgEmail IS NULL
    BEGIN RAISERROR('NOT_FOUND', 16, 1); RETURN; END

    IF @OrgEmail != @UserEmail AND @IsAttendee = 0
    BEGIN RAISERROR('FORBIDDEN', 16, 1); RETURN; END

    DECLARE @CommentId UNIQUEIDENTIFIER = NEWID();
    INSERT INTO mom_item_comments (id, mom_item_id, author_email, author_name, comment)
    VALUES (@CommentId, @ItemId, @UserEmail, @AuthorName, LTRIM(RTRIM(@Comment)));

    SELECT id, author_email, author_name, comment, created_at
    FROM   mom_item_comments
    WHERE  id = @CommentId;
END
GO


-- ============================================================
--  SECTION 6 — TRELLO MAPPINGS
-- ============================================================

-- ------------------------------------------------------------
-- usp_GetTrelloMappings
-- Called by: GET /api/trello/mappings
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetTrelloMappings
    @UserEmail NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, user_email, trello_board_id, trello_board_name,
           trello_list_id, department_id, is_primary
    FROM   trello_mappings
    WHERE  user_email = @UserEmail
    ORDER BY is_primary DESC, trello_board_name ASC;
END
GO

-- ------------------------------------------------------------
-- usp_UpsertTrelloMapping
-- Called by: POST /api/trello/mappings
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpsertTrelloMapping
    @UserEmail       NVARCHAR(255),
    @BoardId         NVARCHAR(255),
    @BoardName       NVARCHAR(500),
    @ListId          NVARCHAR(255) = NULL,
    @DepartmentId    UNIQUEIDENTIFIER = NULL,
    @IsPrimary       BIT = 0
AS
BEGIN
    SET NOCOUNT ON;

    -- If setting as primary, clear other primary flags for this user
    IF @IsPrimary = 1
    BEGIN
        UPDATE trello_mappings
        SET    is_primary = 0
        WHERE  user_email = @UserEmail;
    END

    MERGE trello_mappings AS target
    USING (SELECT @UserEmail AS user_email, @BoardId AS board_id) AS src
    ON    target.user_email = src.user_email AND target.trello_board_id = src.board_id
    WHEN MATCHED THEN
        UPDATE SET
            trello_board_name = @BoardName,
            trello_list_id    = ISNULL(@ListId, trello_list_id),
            department_id     = ISNULL(@DepartmentId, department_id),
            is_primary        = @IsPrimary
    WHEN NOT MATCHED THEN
        INSERT (id, user_email, trello_board_id, trello_board_name, trello_list_id, department_id, is_primary)
        VALUES (NEWID(), @UserEmail, @BoardId, @BoardName, @ListId, @DepartmentId, @IsPrimary);

    SELECT id, user_email, trello_board_id, trello_board_name,
           trello_list_id, department_id, is_primary
    FROM   trello_mappings
    WHERE  user_email = @UserEmail AND trello_board_id = @BoardId;
END
GO

-- ------------------------------------------------------------
-- usp_DeleteTrelloMapping
-- Called by: DELETE /api/trello/mappings/:boardId
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_DeleteTrelloMapping
    @UserEmail NVARCHAR(255),
    @BoardId   NVARCHAR(255)
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM trello_mappings
    WHERE  user_email = @UserEmail AND trello_board_id = @BoardId;
END
GO


-- ============================================================
--  SECTION 7 — WEBHOOK SETTINGS
-- ============================================================

-- ------------------------------------------------------------
-- usp_GetWebhookSettings
-- Called by: GET /api/webhooks/settings
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetWebhookSettings
    @UserId UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, user_id, provider, enabled, webhook_key, created_at, updated_at
    FROM   webhook_settings
    WHERE  user_id = @UserId;
END
GO

-- ------------------------------------------------------------
-- usp_UpsertWebhookSetting
-- Called by: POST/PATCH /api/webhooks/settings
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_UpsertWebhookSetting
    @UserId   UNIQUEIDENTIFIER,
    @Provider NVARCHAR(50),
    @Enabled  BIT
AS
BEGIN
    SET NOCOUNT ON;

    MERGE webhook_settings AS target
    USING (SELECT @UserId AS user_id, @Provider AS provider) AS src
    ON    target.user_id = src.user_id AND target.provider = src.provider
    WHEN MATCHED THEN
        UPDATE SET enabled = @Enabled, updated_at = GETUTCDATE()
    WHEN NOT MATCHED THEN
        INSERT (user_id, provider, enabled, webhook_key)
        VALUES (@UserId, @Provider, @Enabled, NEWID());

    SELECT id, user_id, provider, enabled, webhook_key, created_at, updated_at
    FROM   webhook_settings
    WHERE  user_id = @UserId AND provider = @Provider;
END
GO

-- ------------------------------------------------------------
-- usp_GetWebhookByKey
-- Called by: webhook endpoint to verify inbound webhooks
-- ------------------------------------------------------------
CREATE OR ALTER PROCEDURE usp_GetWebhookByKey
    @WebhookKey UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT ws.id, ws.user_id, ws.provider, ws.enabled, ws.webhook_key,
           u.email AS user_email
    FROM   webhook_settings ws
    JOIN   users u ON u.id = ws.user_id
    WHERE  ws.webhook_key = @WebhookKey;
END
GO


-- ============================================================
--  SUMMARY
-- ============================================================

PRINT '========================================';
PRINT 'Stored procedures created:';
PRINT '  SECTION 1 — Users/Auth (8 SPs)';
PRINT '    usp_GetUserByEmail';
PRINT '    usp_GetUserById';
PRINT '    usp_UpsertGoogleUser';
PRINT '    usp_LinkGoogleToUser';
PRINT '    usp_UpdateGoogleTokens';
PRINT '    usp_RegisterUser';
PRINT '    usp_UpdateUserProfile';
PRINT '    usp_UpdateMicrosoftTokens';
PRINT '  SECTION 2 — Events (9 SPs)';
PRINT '    usp_GetEventList';
PRINT '    usp_GetEventDetail';
PRINT '    usp_CreateEvent';
PRINT '    usp_UpdateEvent';
PRINT '    usp_GetNextEvent';
PRINT '    usp_BulkUpsertCalendarEvents';
PRINT '    usp_BulkUpsertAttendees';
PRINT '    usp_GetUsersForCalendarSync';
PRINT '    usp_GetUpcomingMeetingsForReminder';
PRINT '    usp_MarkReminderSent';
PRINT '  SECTION 3 — Conference Rooms (3 SPs)';
PRINT '    usp_GetRooms';
PRINT '    usp_UpsertRoom';
PRINT '    usp_DeleteRoom';
PRINT '  SECTION 4 — MOM Sessions (9 SPs)';
PRINT '    usp_CheckEventAccess';
PRINT '    usp_GetMOMSession';
PRINT '    usp_SaveMOMSession';
PRINT '    usp_UpdateMOMItem';
PRINT '    usp_DeleteMOMItem';
PRINT '    usp_SearchMOM';
PRINT '    usp_GetPreviousMOM';
PRINT '    usp_GetMOMActivity';
PRINT '    usp_LogMOMActivity';
PRINT '  SECTION 5 — Comments (2 SPs)';
PRINT '    usp_GetItemComments';
PRINT '    usp_AddItemComment';
PRINT '  SECTION 6 — Trello (3 SPs)';
PRINT '    usp_GetTrelloMappings';
PRINT '    usp_UpsertTrelloMapping';
PRINT '    usp_DeleteTrelloMapping';
PRINT '  SECTION 7 — Webhooks (3 SPs)';
PRINT '    usp_GetWebhookSettings';
PRINT '    usp_UpsertWebhookSetting';
PRINT '    usp_GetWebhookByKey';
PRINT '========================================';
PRINT 'Total: 37 stored procedures';
PRINT '========================================';
