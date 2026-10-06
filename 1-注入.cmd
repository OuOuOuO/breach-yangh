@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === BREACH install ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0breach.ps1" install %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" goto OK
echo ============================================================
echo FAILED - exit code %RC%. Read the output above.
echo ============================================================
goto END
:OK
echo ============================================================
echo Done. Fully quit ZCode and relaunch it to load the changes.
echo Add -Restart next time to do that automatically.
echo ============================================================
:END
pause
