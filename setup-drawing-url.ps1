$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$drawingConfigPath = Join-Path $PSScriptRoot "games\drawing\config.json"
$spyConfigPath = Join-Path $PSScriptRoot "games\spy\config.json"

function Fail($message) {
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Read-Config($filePath) {
  if (-not (Test-Path -LiteralPath $filePath)) {
    Fail "Configuration file not found: $filePath"
  }
  try {
    return Get-Content -LiteralPath $filePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Fail "Could not read configuration file: $filePath"
  }
}

function Get-ConfigValue($config, $name, $fallback) {
  $property = $config.PSObject.Properties[$name]
  if ($property -and $null -ne $property.Value -and [string]$property.Value -ne "") {
    return [string]$property.Value
  }
  return $fallback
}

$drawingConfig = Read-Config $drawingConfigPath
$spyConfig = Read-Config $spyConfigPath

$tailscale = $env:TAILSCALE_PATH
$tailscale = Get-ConfigValue $drawingConfig "TAILSCALE_PATH" $tailscale
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
$portValue = $env:SPY_IMAGE_PORT
if (-not $portValue) { $portValue = $env:PORT }
if (-not $portValue) { $portValue = Get-ConfigValue $spyConfig "SPY_IMAGE_PORT" "3000" }
if ($portValue -match '^\d+$') { $port = [int]$portValue }
$httpsPortValue = Get-ConfigValue $drawingConfig "TAILSCALE_FUNNEL_PORT" "443"
if ($env:TAILSCALE_FUNNEL_PORT) { $httpsPortValue = $env:TAILSCALE_FUNNEL_PORT }
if ($httpsPortValue -match '^\d+$') { $httpsPort = [int]$httpsPortValue }
else { $httpsPort = 443 }
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

$backupPath = "$spyConfigPath.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
Copy-Item -LiteralPath $spyConfigPath -Destination $backupPath
$property = $spyConfig.PSObject.Properties["SPY_IMAGE_PUBLIC_BASE_URL"]
if ($property) {
  $property.Value = $baseUrl
} else {
  $spyConfig | Add-Member -MemberType NoteProperty -Name "SPY_IMAGE_PUBLIC_BASE_URL" -Value $baseUrl
}
$content = ($spyConfig | ConvertTo-Json -Depth 100) + [Environment]::NewLine
$encoding = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($spyConfigPath, $content, $encoding)

Write-Host "games/spy/config.json updated. Backup: $backupPath"
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
Write-Host "Restart the bot so it loads the new configuration value."
