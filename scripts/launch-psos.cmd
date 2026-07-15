@echo off
rem ---------------------------------------------------------------
rem Personal Stylist OS launcher
rem Starts the dev server (if not already running) and opens the app
rem in a Chrome app window. Safe to run repeatedly.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0.."

rem Is the server already up?
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://localhost:3000/api/settings' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting Personal Stylist OS server...
  start "psos server" /min cmd /c "npm run dev"
)

rem Wait for the server to answer (up to ~90s for first compile)
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(90); while((Get-Date) -lt $deadline){ try { Invoke-WebRequest -Uri 'http://localhost:3000/api/settings' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 800 } }; exit 1"
if errorlevel 1 (
  echo Server did not come up in time. Check the "psos server" window for errors.
  pause
  exit /b 1
)

rem Open in Chrome app-mode (no tabs/address bar); fall back to default browser.
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME (
  start "" "%CHROME%" --app=http://localhost:3000
) else (
  start "" http://localhost:3000
)
endlocal
