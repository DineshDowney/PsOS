@echo off
rem Stop the psos VM (only disk cost while stopped, ~$2/mo).
set GCLOUD=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd
call "%GCLOUD%" compute instances stop psos-1 --project=project-e8b8d084-2a42-47ca-996 --zone=asia-south1-a
echo psos-1 stopped.
pause
