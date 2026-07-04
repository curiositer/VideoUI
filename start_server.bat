@echo off
chcp 65001 >nul
title Parking Display Server

cd /d "%~dp0"

:: Activate virtual environment
if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
)

echo [%date% %time%] Starting Parking Display Server...
python server.py --port 8080 --parkid-a 20210001 --parkid-b 20210002

:: If server exits, log and pause (keep window open for debugging)
echo [%date% %time%] Server stopped unexpectedly.
pause
