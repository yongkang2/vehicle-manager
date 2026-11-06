@echo off
setlocal
set "VEHICLE_MANAGER_SHORTCUT_ROOT=%~dp0"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $root = $env:VEHICLE_MANAGER_SHORTCUT_ROOT; $shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Vehicle Manager.lnk')); $link.TargetPath = Join-Path $root 'Vehicle Manager.exe'; $link.WorkingDirectory = $root; $link.IconLocation = (Join-Path $root 'vehicle-manager.ico') + ',0'; $link.Description = 'Start Vehicle Manager'; $link.Save()"
if errorlevel 1 (
  echo Could not create the desktop shortcut.
  pause
  exit /b 1
)
echo Vehicle Manager desktop shortcut created.
exit /b 0
