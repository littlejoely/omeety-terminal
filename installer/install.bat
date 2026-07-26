@echo off
REM Omeety Terminal installer - cmd entry, runs install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
