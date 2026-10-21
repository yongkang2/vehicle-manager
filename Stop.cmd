@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" launcher.mjs --stop
) else (
  node.exe launcher.mjs --stop
)
if errorlevel 1 pause