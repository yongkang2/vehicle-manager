param(
    [string]$PackageDirectory,
    [string]$ValidationDirectory = (Join-Path $HOME 'Documents\Work Files\01 Projects\VehicleManager Pre Preview')
)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$homeDirectory = Join-Path $ValidationDirectory 'program'
$data = Join-Path $ValidationDirectory 'data'
$feed = Join-Path $project 'releases\pre'
if (Test-Path (Join-Path $homeDirectory 'launcher.json')) {
    $configuration = Get-Content (Join-Path $homeDirectory 'launcher.json') -Raw | ConvertFrom-Json
    if ($configuration.channel -ne 'pre') { throw 'Choose a separate pre-release validation directory.' }
    Start-Process -FilePath (Join-Path $homeDirectory 'runtime\node.exe') -ArgumentList ('"' + (Join-Path $homeDirectory 'stable-launcher.mjs') + '"') -WorkingDirectory $homeDirectory
    Write-Host "Stable entry: $(Join-Path $homeDirectory 'Start.cmd')"
    return
}
if (-not $PackageDirectory) {
    $package = Get-ChildItem (Join-Path $project 'releases') -Directory | Where-Object { $_.Name -match '-pre\.\d+-' -and (Test-Path (Join-Path $_.FullName 'Install-Launcher.cmd')) } | Sort-Object LastWriteTime | Select-Object -First 1
    if (-not $package) { throw 'Build a stable-launcher package first.' }
    $PackageDirectory = $package.FullName
}
$names = @('VEHICLE_MANAGER_PROGRAM_DIR', 'VEHICLE_MANAGER_DATA_DIR', 'VEHICLE_MANAGER_LOCAL_UPDATE_FEED', 'PORT')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:VEHICLE_MANAGER_PROGRAM_DIR = $homeDirectory
    $env:VEHICLE_MANAGER_DATA_DIR = $data
    $env:VEHICLE_MANAGER_LOCAL_UPDATE_FEED = $feed
    $env:PORT = '0'
    & (Join-Path $PackageDirectory 'runtime\node.exe') (Join-Path $PackageDirectory 'stable-launcher.mjs') --install
    if ($LASTEXITCODE -ne 0) { throw 'Stable-launcher installation failed.' }
    Write-Host "Stable entry: $(Join-Path $homeDirectory 'Start.cmd')"
    Write-Host "Isolated data: $data"
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}