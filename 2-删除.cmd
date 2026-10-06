@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === BREACH remove ===
echo.
echo Restores zcode.cjs and AGENTS.md to stock, then wipes all backups.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0breach.ps1" remove %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" goto OK
echo ============================================================
echo FAILED - exit code %RC%. Read the output above.
echo Nothing is silently ignored; the restore did not complete.
echo ============================================================
goto END
:OK
echo ============================================================
echo Done. Relaunch ZCode to load the original bundle.
echo ============================================================
:END
pause
