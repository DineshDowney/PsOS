@echo off
rem Start the psos VM and open the app.
rem
rem The URL is FIXED: Tailscale Funnel binds it to the machine name, not to the
rem IP, so it survives every reboot and the ephemeral-IP change. Nothing here
rem needs to look an address up any more.
rem
rem This script deliberately does NOT poll the app to see if it is up. Two
rem reasons, both still standing:
rem   1. Polling the URL from this laptop is an HTTP request to an external host,
rem      which set off corporate EDR once already (SIR0886312).
rem   2. Polling over SSH instead (gcloud ssh -> curl localhost) does work, but
rem      the VM's external IP changes on every boot, so PuTTY prompts for the
rem      host key every single time. Auto-accepting that unattended is a real
rem      security trade for a cosmetic gain. Evaluated 2026-07-27, rejected.
rem So: open the browser, and be honest that the first load will fail.
rem
rem Waking it from your PHONE: Google Cloud app -> Compute Engine -> psos-1 ->
rem Start. Nothing to deploy. The app comes up with the VM on its own --
rem psos.service is enabled and Tailscale Funnel is restored with it.
rem
rem Power-off: 60 min after boot, unless something holds it awake -- an import
rem queue that is still draining, you actually using the app, or Settings ->
rem Hold for 4 hours. See deploy/vm/README.md.
setlocal
set GCLOUD=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd
set PROJ=project-e8b8d084-2a42-47ca-996
set ZONE=asia-south1-a
set URL=https://psos.tail620d1e.ts.net
set STATUS=

rem Is it already up? Then the app is already answering and there is nothing to
rem warn about. Read via a temp file rather than a for/f loop: the parentheses in
rem --format="value(status)" are miserable to escape inside backticks.
set STATUSFILE=%TEMP%\psos-status.txt
call "%GCLOUD%" compute instances describe psos-1 --project=%PROJ% --zone=%ZONE% --format="value(status)" > "%STATUSFILE%" 2>nul
if exist "%STATUSFILE%" set /p STATUS=<"%STATUSFILE%"
del "%STATUSFILE%" 2>nul

if /i "%STATUS%"=="RUNNING" goto :alreadyup

echo Starting psos-1...
call "%GCLOUD%" compute instances start psos-1 --project=%PROJ% --zone=%ZONE% || goto :fail

echo.
echo VM started. The app is NOT reachable yet -- it needs about 60 seconds.
echo.
echo Opening the browser now so the tab is ready. THE FIRST LOAD WILL FAIL.
echo That is expected, not a problem. Give it a minute, then refresh.
echo.
echo   %URL%
echo.
start %URL%
goto :end

:alreadyup
echo psos-1 is already running -- the app should answer straight away.
echo   %URL%
start %URL%
goto :end

:fail
echo.
echo Failed to start the VM. Run this again, or check the GCP console.

:end
endlocal
pause
