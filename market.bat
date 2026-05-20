@echo off
title 市场行情仪表盘
cd /d "%~dp0"

echo Starting Python API Server...
start "PythonAPI" "%~dp0senior-analyst\venv\Scripts\python.exe" "%~dp0senior-analyst\api_server.py"

echo Waiting for Python API to be ready...
:wait
timeout /t 1 /nobreak >nul
curl -s http://127.0.0.1:8765/api/health >nul 2>&1
if errorlevel 1 goto wait

echo Starting Market Dashboard...
start "" http://127.0.0.1:8080
node server.js
pause
