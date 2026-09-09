# Load .env into this PowerShell session and put the venv on PATH.
#
# Dot-source it, or the variables vanish with the child scope:
#     . .\scripts\env.ps1
#
# PowerShell has no `export` and no `source`; this is the equivalent of
# `set -a; source ../.env; set +a` from bash.
#
# Kept strictly ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI
# unless the file carries a UTF-8 BOM, so a stray non-ASCII character here
# corrupts the parse in ways that look nothing like the real cause.

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envFile = Join-Path $root '.env'

if (-not (Test-Path $envFile)) {
    Write-Host "no .env at $envFile" -ForegroundColor Yellow
    Write-Host "create one with: node scripts/new-burner.mjs >> ../.env"
    return
}

Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '') { return }
    if ($line.StartsWith('#')) { return }
    if (-not $line.Contains('=')) { return }
    $i = $line.IndexOf('=')
    $k = $line.Substring(0, $i).Trim()
    $v = ($line.Substring($i + 1) -split '\s+#')[0].Trim()
    if ($k) { Set-Item -Path ("env:" + $k) -Value $v }
}

$venv = Join-Path $root '.venv\Scripts'
if (Test-Path $venv) {
    $env:PATH = $venv + ';' + $env:PATH
}

# Live settlement, not mock. PAYMENT_MODE=x402-mock in .env is for the tests.
Remove-Item env:PAYMENT_MODE -ErrorAction SilentlyContinue

$env:NO_COLOR = '1'
if (-not $env:SIBYL_MEMORY_DB) {
    $env:SIBYL_MEMORY_DB = 'C:\tmp\airtight\memory.db'
}
New-Item -ItemType Directory -Force -Path (Split-Path $env:SIBYL_MEMORY_DB) | Out-Null

Write-Host "AIRTIGHT env loaded" -ForegroundColor Green
Write-Host ("  payTo   " + $env:X402_PAY_TO)
Write-Host ("  settler " + $env:FACILITATOR_ADDRESS + "  (gas only)")
Write-Host ("  buyer   " + $env:DEMO_BUYER_ADDRESS)
Write-Host ("  memory  " + $env:SIBYL_MEMORY_DB)
Write-Host ("  mode    live, real USDC on " + $env:X402_NETWORK)
