@echo off
REM Classroom camera: keeps live face recognition running all day.
REM If the script stops for any reason (crash, camera unplugged too long), it restarts after 5 seconds.
REM Close this window to stop it. Add "--headless" below to run without the video window.
REM For several cameras, add them below separated by commas, for example: python face_live.py live --cameras 0,1
cd /d "%~dp0"
:loop
python face_live.py live
echo [%date% %time%] face_live.py stopped, restarting in 5 seconds... (close this window to stop)
timeout /t 5 /nobreak >nul
goto loop
