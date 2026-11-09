param([string]$ConfigRoot = (Join-Path $env:LOCALAPPDATA 'VehicleManagerAI'))
$ErrorActionPreference = 'Stop'
$file = Join-Path $ConfigRoot 'gateway-process.json'
if (!(Test-Path -LiteralPath $file)) { Write-Output 'No local gateway process recorded.'; exit 0 }
$state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue
if ($process) {
  if (!$process.CommandLine -or !$process.CommandLine.Contains($state.entry) -or [IO.Path]::GetFileName($process.ExecutablePath) -ne 'node.exe') { throw 'The recorded process cannot be verified. Refusing to stop it.' }
  Stop-Process -Id $state.pid
}
Remove-Item -LiteralPath $file
Write-Output 'Local AI gateway stopped.'
