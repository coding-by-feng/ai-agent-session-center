# Claude Session Command Center - Hook relay (Windows)
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

# POST to dashboard server (fire-and-forget)
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
    # Don't wait for the job
} catch {}

exit 0
