@echo off
cd /d "%~dp0"
"runtime\node.exe" stable-launcher.mjs --install
if errorlevel 1 pause