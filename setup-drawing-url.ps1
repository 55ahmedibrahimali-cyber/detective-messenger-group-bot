$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$envFile = Join-Path $PSScriptRoot ".env"
$lines = if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile -Encoding UTF8
} else {
  @()
}

function Fail($message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

$tailscale = $env:TAILSCALE_PATH
$configuredPathLine = $lines |
  Where-Object { $_ -match '^\s*TAILSCALE_PATH\s*=' } |
  Select-Object -First 1
if (-not $tailscale -and $configuredPathLine -match '^\s*TAILSCALE_PATH\s*=\s*(.+?)\s*$') {
  $tailscale = $Matches[1].Trim().Trim('"').Trim("'")
}
if ($tailscale -and -not (Test-Path -LiteralPath $tailscale)) {
  $tailscale = $null
}
if (-not $tailscale) {
  $command = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($command) { $tailscale = $command.Source }
}
if (-not $tailscale) {
  foreach ($candidate in @(
    "C:\Program Files\Tailscale\tailscale.exe",
    "C:\Program Files (x86)\Tailscale\tailscale.exe"
  )) {
    if (Test-Path -LiteralPath $candidate) {
      $tailscale = $candidate
      break
    }
  }
}
if (-not $tailscale) {
  Fail "Tailscale CLI not found. Install Tailscale, sign in, then run this script again."
}

$port = 3000
$httpsPort = 443
if ($lines.Count -gt 0) {
  $spyPortLine = $lines |
    Where-Object { $_ -match '^\s*SPY_IMAGE_PORT\s*=\s*(\d+)' } |
    Select-Object -First 1
  $plainPortLine = $lines |
    Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)' } |
    Select-Object -First 1
  $funnelPortLine = $lines |
    Where-Object { $_ -match '^\s*TAILSCALE_FUNNEL_PORT\s*=\s*(\d+)' } |
    Select-Object -First 1
  if ($spyPortLine -match '=\s*(\d+)') { $port = [int]$Matches[1] }
  elseif ($plainPortLine -match '=\s*(\d+)') { $port = [int]$Matches[1] }
  if ($funnelPortLine -match '=\s*(\d+)') {
    $httpsPort = [int]$Matches[1]
  }
}
if ($httpsPort -notin @(443, 8443, 10000)) {
  Fail "TAILSCALE_FUNNEL_PORT must be 443, 8443, or 10000."
}

$statusOutput = (& $tailscale funnel status --json 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Fail "Tailscale Funnel status failed. Open Tailscale and sign in before retrying."
}
$status = $null
if ($statusOutput -and $statusOutput -ne "No serve config") {
  try { $status = $statusOutput | ConvertFrom-Json }
  catch { Fail "Could not read Tailscale Funnel status: $statusOutput" }
}

$target = "http://127.0.0.1:$port"
$route = $null
if ($status -and $status.Web) {
  $route = $status.Web.PSObject.Properties |
    Where-Object { $_.Name -match (":$httpsPort$") } |
    Select-Object -First 1
}
if ($route) {
  $rootHandler = $null
  if ($route.Value.Handlers) {
    $rootHandler = $route.Value.Handlers.PSObject.Properties["/"]
  }
  $existingTarget = if ($rootHandler) { $rootHandler.Value.Proxy } else { $null }
  if ($existingTarget -ne $target) {
    Fail "Tailscale Funnel port $httpsPort is already assigned to another service. Change TAILSCALE_FUNNEL_PORT or remove that route before continuing."
  }
}

Write-Host "Enabling persistent Funnel on HTTPS port $httpsPort -> $target"
& $tailscale funnel --bg "--https=$httpsPort" $target
if ($LASTEXITCODE -ne 0) {
  Fail "Tailscale Funnel setup failed. Enable HTTPS, MagicDNS, and Funnel in your tailnet, then retry."
}

$statusOutput = (& $tailscale funnel status --json 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail "Could not read the configured Tailscale Funnel status." }
try { $status = $statusOutput | ConvertFrom-Json }
catch { Fail "Could not parse Tailscale Funnel status: $statusOutput" }
$route = $status.Web.PSObject.Properties |
  Where-Object { $_.Name -match (":$httpsPort$") } |
  Select-Object -First 1
if (-not $route) { Fail "No Funnel route was found on HTTPS port $httpsPort." }

$address = $route.Name
if ($httpsPort -eq 443) { $address = $address -replace ":$httpsPort$", "" }
$baseUrl = "https://$address"
Write-Host "Public base URL: $baseUrl" -ForegroundColor Green

if (Test-Path -LiteralPath $envFile) {
  $backupPath = "$envFile.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
  Copy-Item -LiteralPath $envFile -Destination $backupPath
  $lines = Get-Content -LiteralPath $envFile -Encoding UTF8
} else {
  $backupPath = $null
  $lines = @()
}
$found = $false
$lines = @($lines | ForEach-Object {
  if ($_ -match '^\s*SPY_IMAGE_PUBLIC_BASE_URL\s*=') {
    $found = $true
    "SPY_IMAGE_PUBLIC_BASE_URL=$baseUrl"
  } else {
    $_
  }
})
if (-not $found) { $lines += "SPY_IMAGE_PUBLIC_BASE_URL=$baseUrl" }
$content = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
$encoding = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($envFile, $content, $encoding)

if ($backupPath) { Write-Host ".env updated. Backup: $backupPath" }
else { Write-Host ".env created." }
try {
  $response = Invoke-WebRequest `
    -Uri "$baseUrl/draw/probe-healthcheck" `
    -UseBasicParsing `
    -TimeoutSec 8
  if ($response.StatusCode -eq 204) {
    Write-Host "Drawing server is reachable (HTTP 204)." -ForegroundColor Green
  } else {
    Write-Host "The server returned HTTP $($response.StatusCode); start the bot and verify the link." -ForegroundColor Yellow
  }
} catch {
  Write-Host "The route is configured; start the bot and verify reachability. $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host "Restart the bot so it loads the new .env value."
