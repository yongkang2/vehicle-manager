@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" launcher.mjs
) else (
  where node.exe >nul 2>&1
  if errorlevel 1 goto missing_node
  node.exe launcher.mjs
)
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Node.js 24 or the bundled runtime is missing.
:failed
echo Startup failed. See the error and full log paths above.
echo Launcher log: "%~dp0launcher.log"
echo Default service log: "%LOCALAPPDATA%\VehicleManager\data\startup.log"
echo A configured VEHICLE_MANAGER_DATA_DIR overrides the default service log folder.
pause
exit /b 1
