@echo off
cd /d "%~dp0"
node --use-system-ca server.mjs
if errorlevel 1 pause
