@echo off
rem Start the psos VM and open the app.
rem
rem The URL is FIXED: Tailscale Funnel binds it to the machine name, not to the
rem IP, so it survives every reboot and the ephemeral-IP change. Nothing here
rem needs to look an address up any more.
rem
rem This script deliberately does NOT poll the app to see if it is up. Doing that
rem from this laptop means an HTTP request to an external host, which set off
rem corporate EDR once already (SIR0886312). The browser opening a moment early
rem is a refresh; a security incident is not.
rem
rem Power-off: 60 min after boot, unless something holds it awake -- an import
rem queue that is still draining, you actually using the app, or Settings ->
rem Hold for 4 hours. See deploy/vm/README.md.
setlocal
set GCLOUD=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd
set PROJ=project-e8b8d084-2a42-47ca-996
set ZONE=asia-south1-a
set URL=https://psos.tail620d1e.ts.net

echo Starting psos-1...
call "%GCLOUD%" compute instances start psos-1 --project=%PROJ% --zone=%ZONE% || goto :fail

echo.
echo VM started. The app needs ~60-90s to boot.
echo   %URL%
echo.
start %URL%
goto :end

:fail
echo Failed to start the VM. Run this again, or check the GCP console.

:end
endlocal
pause
