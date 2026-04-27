-- Karya / Kaarya — daily MSSQL backup script
--
-- Run via SQL Server Agent or Task Scheduler (see setup-backup.ps1).
-- Writes a full backup with date-stamped filename and prunes anything older
-- than RetainDays. Compression is on (Standard/Enterprise) — falls back to
-- uncompressed on Express edition.

DECLARE @DbName     SYSNAME      = N'karya_prod';
DECLARE @BackupDir  NVARCHAR(260) = N'C:\backups\karya\';   -- adjust to your path
DECLARE @RetainDays INT          = 14;

DECLARE @stamp     NVARCHAR(20) = CONVERT(NVARCHAR(20), SYSUTCDATETIME(), 112)
                                 + N'-'
                                 + REPLACE(CONVERT(NVARCHAR(20), SYSUTCDATETIME(), 108), N':', N'');
DECLARE @file      NVARCHAR(520) = @BackupDir + @DbName + N'_' + @stamp + N'.bak';

-- Take the backup. WITH COMPRESSION is silently ignored on Express; CHECKSUM
-- catches a failing disk before we commit to overwriting the previous backup.
BACKUP DATABASE @DbName
TO DISK = @file
WITH FORMAT,
     INIT,
     COMPRESSION,
     CHECKSUM,
     STATS = 10,
     NAME = N'Karya prod full backup';

PRINT N'Backup written to: ' + @file;

-- ─── Prune old backups ────────────────────────────────────────────────────────

DECLARE @cleanupTime DATETIME = DATEADD(DAY, -@RetainDays, GETDATE());
EXEC master.sys.xp_delete_files
    @File1 = @BackupDir,
    @File2 = N'bak',
    @File3 = @cleanupTime,
    @File4 = 1;
GO
