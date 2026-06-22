# Safe-Market-Maker external process watchdog.
# Runs as a Windows Scheduled Task (or by hand) every N minutes:
# 1. Confirms the UI server on http://127.0.0.1:8789/ responds with 200 within 8s
# 2. Confirms a node process whose CommandLine matches "ui --port 8789" is running
# 3. Writes one line per check to .safe-mm/watchdog.log (rotated weekly)
# 4. On failure, ALSO appends to .safe-mm/watchdog-alerts.log so a human can see the issue at a glance
#
# Deliberately does NOT auto-restart the bot — that's the user's call (they may be in the middle of
# something or want to investigate). The script's job is to record + flag.

$ErrorActionPreference = 'Stop'
$BotDir = 'C:\Users\Administrator\Documents\New project 3\safe-market-maker'
$LogFile = Join-Path $BotDir '.safe-mm\watchdog.log'
$AlertFile = Join-Path $BotDir '.safe-mm\watchdog-alerts.log'
$Url = 'http://127.0.0.1:8789/'

function Append-Log($file, $line) {
    try {
        $dir = Split-Path -Parent $file
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $file -Value $line -Encoding UTF8
    } catch { }
}

$ts = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
$uiOk = $false; $uiStatus = ''; $procOk = $false; $procPid = ''

try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    $uiOk = ($resp.StatusCode -eq 200)
    $uiStatus = "$($resp.StatusCode)"
} catch {
    $uiStatus = "ERR:$($_.Exception.Message.Substring(0,[Math]::Min(80,$_.Exception.Message.Length)))"
}

try {
    $bot = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -like '*ui --port 8789*' } | Select-Object -First 1
    if ($bot) { $procOk = $true; $procPid = "$($bot.ProcessId)" }
} catch { }

$status = if ($uiOk -and $procOk) { 'OK' } else { 'FAIL' }
$line = "$ts $status uiHttp=$uiStatus procPid=$procPid"
Append-Log $LogFile $line
if ($status -eq 'FAIL') {
    Append-Log $AlertFile $line
}

# Rotate watchdog.log weekly (truncate when > 1MB)
try {
    if ((Get-Item $LogFile -ErrorAction SilentlyContinue).Length -gt 1MB) {
        Move-Item $LogFile ($LogFile + '.prev') -Force
    }
} catch { }

Write-Output $line
exit $(if ($status -eq 'OK') { 0 } else { 1 })
