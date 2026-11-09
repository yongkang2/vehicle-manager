param([switch]$CheckOnly, [string]$ConfigRoot = (Join-Path $env:LOCALAPPDATA 'VehicleManagerAI'))
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $ConfigRoot 'gateway.json') -Raw | ConvertFrom-Json
$headers = @{ Authorization = 'Bearer ' + @($settings.deviceTokens)[0] }
if (!$CheckOnly) {
  $project = Split-Path -Parent $PSScriptRoot
  $application = if (Test-Path -LiteralPath (Join-Path $project 'app/dist-server')) { Join-Path $project 'app' } else { $project }
  $entry = Join-Path $application 'dist-server/server/ai-gateway-main.js'
  if (!(Test-Path -LiteralPath $entry)) { throw 'AI build is missing. Run npm run build first.' }
  $node = Join-Path $project 'runtime/node.exe'
  if (!(Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
  $stateFile = Join-Path $ConfigRoot 'gateway-process.json'
  if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($state.entry)) { throw 'Gateway is already running. Stop-AI-Gateway.cmd before restarting or changing its key.' }
  }
  $names = @('DEEPSEEK_API_KEY','VEHICLE_AI_DEVICE_TOKENS','VEHICLE_AI_DATA_DIR','VEHICLE_AI_DAILY_LIMIT','VEHICLE_AI_PORT')
  $previous = @{}
  foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  $secure = Import-Clixml -LiteralPath (Join-Path $ConfigRoot 'provider-key.xml')
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $env:VEHICLE_AI_DEVICE_TOKENS = @($settings.deviceTokens) -join ','
    $env:VEHICLE_AI_DATA_DIR = $ConfigRoot
    $env:VEHICLE_AI_DAILY_LIMIT = [string]$settings.dailyLimit
    $env:VEHICLE_AI_PORT = [string]$settings.port
    $child = Start-Process -FilePath $node -ArgumentList @('"' + $entry + '"') -WorkingDirectory $application -WindowStyle Hidden -RedirectStandardOutput (Join-Path $ConfigRoot 'gateway.log') -RedirectStandardError (Join-Path $ConfigRoot 'gateway-error.log') -PassThru
    @{ pid = $child.Id; entry = $entry } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  }
  Start-Sleep -Milliseconds 800
}
try {
  $status = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $settings.port + '/v1/status') -Headers $headers -TimeoutSec 20
  if ($status.ready) { Write-Output 'Gateway and provider are ready.' } else { throw 'Unexpected gateway status.' }
} catch {
  $code = 'AI_GATEWAY_UNREACHABLE'
  if ($_.ErrorDetails.Message) {
    try { $body = $_.ErrorDetails.Message | ConvertFrom-Json; if ($body.error -in @('AI_PROVIDER_AUTH','AI_PROVIDER_BALANCE','AI_MODEL_UNAVAILABLE','AI_PROVIDER_UNAVAILABLE','UNAUTHORIZED')) { $code = $body.error } } catch {}
  }
  Write-Output ('AI status: ' + $code + '. Check the local service configuration; no recognition was requested.')
  exit 1
}
