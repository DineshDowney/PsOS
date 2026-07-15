@echo off
rem Start the psos VM, wait for the app, print (and open) the fresh URL.
rem The VM auto-powers-off 3 hours after boot (psos-autostop.service).
setlocal enabledelayedexpansion
set GCLOUD=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd
set PROJ=project-e8b8d084-2a42-47ca-996
set ZONE=asia-south1-a

echo Starting psos-1 (auto-off in 3h)...
call "%GCLOUD%" compute instances start psos-1 --project=%PROJ% --zone=%ZONE% || goto :fail

for /f "delims=" %%i in ('call "%GCLOUD%" compute instances describe psos-1 --project^=%PROJ% --zone^=%ZONE% --format^="value(networkInterfaces[0].accessConfigs[0].natIP)"') do set IP=%%i
echo VM IP: !IP!

echo Waiting for the app (up to ~2 min)...
for /l %%n in (1,1,24) do (
  curl -s -o nul -m 4 http://!IP!:3000/api/items && goto :up
  timeout /t 5 /nobreak > nul
)
echo App did not respond yet - give it another minute, then open http://!IP!:3000
goto :end

:up
echo App is UP: http://!IP!:3000
start http://!IP!:3000
goto :end

:fail
echo Failed to start the VM. Run this script again or check GCP console.

:end
endlocal
pause
