# AI Agent Session Center - Hook relay (Windows)
# Reads hook JSON from stdin, enriches with process/env info, POSTs to dashboard server
# Runs in background, fails silently if server is not running

$ErrorActionPreference = 'SilentlyContinue'
$input_json = [Console]::In.ReadToEnd()

if (-not $input_json) { exit 0 }

# Gather environment info
$claude_pid = (Get-Process -Id $PID).Parent.Id  # Parent of PowerShell = Claude process
$vscode_pid = $env:VSCODE_PID
$term_program = $env:TERM_PROGRAM
$wt_session = $env:WT_SESSION           # Windows Terminal session GUID
$wt_profile = $env:WT_PROFILE_ID        # Windows Terminal profile ID
$conemu_pid = $env:ConEmuPID            # ConEmu/Cmder PID
$term = $env:TERM

# Build enrichment object
$enrich = @{
    claude_pid = if ($claude_pid) { [int]$claude_pid } else { $null }
    term_program = if ($term_program) { $term_program } else { $null }
    vscode_pid = if ($vscode_pid) { [int]$vscode_pid } else { $null }
    term = if ($term) { $term } else { $null }
    tab_id = if ($wt_session) { "wt:$wt_session" } elseif ($conemu_pid) { "conemu:$conemu_pid" } else { $null }
    wt_profile = if ($wt_profile) { $wt_profile } else { $null }
}

# Merge enrichment into the hook JSON
try {
    $data = $input_json | ConvertFrom-Json
    foreach ($key in $enrich.Keys) {
        if ($null -ne $enrich[$key]) {
            $data | Add-Member -NotePropertyName $key -NotePropertyValue $enrich[$key] -Force
        }
    }
    $enriched = $data | ConvertTo-Json -Compress -Depth 10
} catch {
    $enriched = $input_json
}

# ---- Tab title management ----
# Keep the terminal tab/window title set to "Claude: <project>" so the dashboard can find it.
# On SessionStart: resolve project name and cache to temp file.
# On every other event: read cache and refresh the title.
# Uses console title (works on Windows Terminal, ConEmu, cmd, PowerShell, VS Code, JetBrains).
# Works in all terminals including VS Code and JetBrains integrated terminals.
try {
    $hookEvent = ($input_json | ConvertFrom-Json).hook_event_name
    $sessionId = ($input_json | ConvertFrom-Json).session_id
} catch {
    $hookEvent = $null
    $sessionId = $null
}

$cacheDir = "$env:TEMP\claude-tab-titles"
if ($sessionId) {
    $cacheFile = "$cacheDir\$sessionId"

    if ($hookEvent -eq 'SessionStart') {
        # Resolve project name from cwd in JSON or from Claude process cwd
        $project = $null
        try {
            $cwd = ($input_json | ConvertFrom-Json).cwd
            if ($cwd) { $project = Split-Path $cwd -Leaf }
        } catch {}
        if (-not $project -and $claude_pid) {
            try {
                $proc = Get-Process -Id $claude_pid -ErrorAction Stop
                $project = Split-Path $proc.Path -Leaf
                # Try to get actual working directory via CIM
                $wmiProc = Get-CimInstance Win32_Process -Filter "ProcessId=$claude_pid" -ErrorAction Stop
                if ($wmiProc.CommandLine -match '([A-Z]:\\[^\s"]+)') {
                    $possiblePath = $Matches[1]
                    if (Test-Path $possiblePath -PathType Container) {
                        $project = Split-Path $possiblePath -Leaf
                    }
                }
            } catch {}
        }
        if ($project) {
            if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
            $project | Out-File -FilePath $cacheFile -Encoding utf8 -NoNewline
        }
    } elseif ($hookEvent -eq 'SessionEnd') {
        # Clean up
        if (Test-Path $cacheFile) { Remove-Item $cacheFile -Force }
    } else {
        # Read cached project name
        $project = $null
        if (Test-Path $cacheFile) { $project = Get-Content $cacheFile -Raw -ErrorAction SilentlyContinue }
    }

    # Set/refresh the console window title on every event (except SessionEnd)
    if ($hookEvent -ne 'SessionEnd' -and $project) {
        $Host.UI.RawUI.WindowTitle = "Claude: $project"
    }
}

# Deliver to dashboard via file-based MQ (primary) or HTTP (fallback)
$mqDir = "$env:TEMP\claude-session-center"
$mqFile = "$mqDir\queue.jsonl"

if (Test-Path $mqDir -PathType Container) {
    # File-based MQ: atomic append via .NET StreamWriter (no process spawn)
    try {
        $fs = [System.IO.File]::Open($mqFile,
            [System.IO.FileMode]::Append,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite)
        $writer = New-Object System.IO.StreamWriter($fs)
        $writer.WriteLine($enriched)
        $writer.Flush()
        $writer.Close()
        $fs.Close()
    } catch {
        # Fall through to HTTP on file error
        try {
            $job = Start-Job -ScriptBlock {
                param($body)
                try {
                    Invoke-RestMethod -Uri 'http://localhost:3333/api/hooks' `
                        -Method POST `
                        -ContentType 'application/json' `
                        -Body $body `
                        -TimeoutSec 5 | Out-Null
                } catch {}
            } -ArgumentList $enriched
        } catch {}
    }
} else {
    # Fallback: HTTP POST when MQ dir doesn't exist (server not started yet)
    try {
        $job = Start-Job -ScriptBlock {
            param($body)
            try {
                Invoke-RestMethod -Uri 'http://localhost:3333/api/hooks' `
                    -Method POST `
                    -ContentType 'application/json' `
                    -Body $body `
                    -TimeoutSec 5 | Out-Null
            } catch {}
        } -ArgumentList $enriched
    } catch {}
}

exit 0
