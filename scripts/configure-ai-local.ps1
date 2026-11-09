param([string]$ConfigRoot = (Join-Path $env:LOCALAPPDATA 'VehicleManagerAI'), [string]$ClientDirectory = (Join-Path $env:LOCALAPPDATA 'VehicleManager'), [switch]$UseSavedKey)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $ConfigRoot /inheritance:r /grant:r "$($identity):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the local AI configuration directory.' }
$keyFile = Join-Path $ConfigRoot 'provider-key.xml'
if ($UseSavedKey) {
  if (!(Test-Path -LiteralPath $keyFile)) { throw 'No saved provider key. Run Configure-AI.cmd first.' }
} else {
  $key = Read-Host 'DeepSeek API key (stored encrypted for this Windows user)' -AsSecureString
  if ($key.Length -lt 10) { throw 'The API key is empty or incomplete.' }
  $key | Export-Clixml -LiteralPath $keyFile
}
$gatewayFile = Join-Path $ConfigRoot 'gateway.json'
if (Test-Path -LiteralPath $gatewayFile) {
  $gateway = Get-Content -LiteralPath $gatewayFile -Raw | ConvertFrom-Json
} else {
  $random = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($random) } finally { $generator.Dispose() }
  $token = -join ($random | ForEach-Object { $_.ToString('x2') })
  $gateway = @{ port = 4420; dailyLimit = 20; deviceTokens = @($token) }
  $gateway | ConvertTo-Json | Set-Content -LiteralPath $gatewayFile -Encoding UTF8
}
if ($gateway.port -ne 4420 -or @($gateway.deviceTokens).Count -lt 1) { throw 'The saved gateway is not a local-trial configuration.' }
New-Item -ItemType Directory -Force -Path $ClientDirectory | Out-Null
$clientFile = Join-Path $ClientDirectory 'ai-client.json'
@{ gatewayUrl = 'http://127.0.0.1:4420'; deviceToken = @($gateway.deviceTokens)[0] } | ConvertTo-Json | Set-Content -LiteralPath $clientFile -Encoding UTF8
& icacls.exe $clientFile /inheritance:r /grant:r "$($identity):F" '*S-1-5-18:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the local client credential.' }
Write-Output 'Local AI configured. Start-AI-Gateway.cmd starts the service. The provider key is not included in client configuration.'
