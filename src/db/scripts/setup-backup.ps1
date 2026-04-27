# Set up a Windows Scheduled Task that runs the backup.sql nightly.
# Run once, elevated. Adjust paths and credentials before running.

$ErrorActionPreference = 'Stop'

# ─── Settings ─────────────────────────────────────────────────────────────────
$BackupDir   = 'C:\backups\karya'
$ScriptPath  = "$PSScriptRoot\backup.sql"
$LogPath     = "$BackupDir\backup.log"
$SqlInstance = '.'           # local default instance; e.g. '.\SQLEXPRESS' or 'srv\named'
$RunAtTime   = '02:30'        # 24h, server local time
$TaskName    = 'Karya nightly backup'

# ─── Prerequisites ────────────────────────────────────────────────────────────
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
    Write-Host "Created $BackupDir"
}

# Ensure the SQL Server service account has write access to the backup dir.
# (When running as sqlcmd -E with the service account's identity, it needs
#  this; when running with a SQL login that has BACKUP DATABASE permission,
#  the service account still writes the file.)
$svc = Get-WmiObject -Class Win32_Service -Filter "Name='MSSQLSERVER'"
if ($svc) {
    $acct = $svc.StartName
    Write-Host "MSSQLSERVER runs as: $acct"
    icacls $BackupDir /grant "${acct}:(M)" | Out-Null
}

# ─── Build the action ─────────────────────────────────────────────────────────
# We invoke sqlcmd -E (Windows auth as the task's principal) to run backup.sql.
# Output appended to a log file for postmortem.
$cmd      = 'sqlcmd.exe'
$argList  = "-E -S `"$SqlInstance`" -i `"$ScriptPath`" -o `"$LogPath`" -b"

$action  = New-ScheduledTaskAction  -Execute $cmd -Argument $argList
$trigger = New-ScheduledTaskTrigger -Daily -At $RunAtTime
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable:$false `
                                          -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# Replace any existing task with the same name (idempotent re-runs)
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
                       -Action $action `
                       -Trigger $trigger `
                       -Principal $principal `
                       -Settings $settings | Out-Null

Write-Host "Scheduled '$TaskName' to run daily at $RunAtTime"
Write-Host "Logs:  $LogPath"
Write-Host ""
Write-Host "Test now:  Start-ScheduledTask -TaskName '$TaskName'"
