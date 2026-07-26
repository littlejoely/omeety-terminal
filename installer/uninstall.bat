@echo off
REM Omeety Terminal uninstaller - cmd entry, runs uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
