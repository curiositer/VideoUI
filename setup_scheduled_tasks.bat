@echo off
cd /d "%~dp0"

rem Check admin privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Please right-click this file and "Run as administrator".
    pause
    exit /b 1
)

set "PYTHON=%~dp0.venv\Scripts\python.exe"
set "LAUNCH=%~dp0tools\launch.py"
set "STOP=%~dp0tools\stop.py"
set "START_LOG=%~dp0logs\scheduled_start.log"
set "STOP_LOG=%~dp0logs\scheduled_stop.log"

echo ===== Parking Display - Scheduled Task Setup =====
echo.
echo Python : %PYTHON%
echo Launch : %LAUNCH%
echo Stop   : %STOP%
echo.
echo Creating scheduled tasks...

rem Daily at 05:30 - Start
schtasks /Create /TN "ParkingDisplay_Start" /TR "cmd /c \"\"%PYTHON%\" \"%LAUNCH%\" --log-file \"%START_LOG%\"\"" /SC DAILY /ST 05:30 /F
if %errorlevel% neq 0 (
    echo [ERROR] Failed to create ParkingDisplay_Start
    pause
    exit /b 1
)

rem Daily at 15:30 - Stop
schtasks /Create /TN "ParkingDisplay_Stop" /TR "cmd /c \"\"%PYTHON%\" \"%STOP%\" --log-file \"%STOP_LOG%\"\"" /SC DAILY /ST 15:30 /F
if %errorlevel% neq 0 (
    echo [ERROR] Failed to create ParkingDisplay_Stop
    pause
    exit /b 1
)

echo.
echo [OK] Scheduled tasks created successfully.
echo.
schtasks /Query /TN "ParkingDisplay_Start"
schtasks /Query /TN "ParkingDisplay_Stop"

echo.
echo ============================================
echo  NOTES:
echo    1. Tasks run only when current user is logged on.
echo       (PC must be powered on and logged in; auto-login recommended)
echo    2. Log files: logs\scheduled_start.log
echo                  logs\scheduled_stop.log
echo    3. If PC is off/sleeping at 05:30, task will be skipped.
echo       Fix: Disable sleep in Power Options, and in Task Scheduler
echo       GUI, check "Run task as soon as possible after a scheduled start is missed"
echo    4. To remove tasks:
echo       schtasks /Delete /TN "ParkingDisplay_Start" /F
echo       schtasks /Delete /TN "ParkingDisplay_Stop" /F
echo    5. To test manually:
echo       schtasks /Run /TN "ParkingDisplay_Start"
echo       schtasks /Run /TN "ParkingDisplay_Stop"
echo ============================================
pause
