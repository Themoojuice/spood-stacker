@echo off
setlocal
title Spood Stacker
cd /d "%~dp0"

rem ---- find Python (the py launcher first, then python) ----
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY goto :nopython

rem ---- first run: install the two libraries the stacker needs ----
%PY% -c "import cv2, numpy" >nul 2>&1
if errorlevel 1 (
  echo.
  echo  First run: installing OpenCV and NumPy. This takes a minute...
  %PY% -m pip install --user opencv-python numpy
  if errorlevel 1 goto :pipfail
)

echo.
echo  ===== Spood Stacker =====
echo  Each batch: drag in a folder, one photo, or several photos (Ctrl-click
echo  them in Explorer, then drag), and press Enter. Results open when done.
echo  Folder  -^>  saved beside it as  ^<folder^>_stacked.png and .jpg
echo  Photos  -^>  saved in a "stacked" folder next to them
echo  Both keep the photos' date, location and camera (for iNaturalist).

rem anything dropped onto the icon is stacked first, then the window waits for more
%PY% "%~dp0stacker.py" --loop --open %*
goto :end

:nopython
echo.
echo  Python is not installed (or not on PATH).
echo  Install it from https://www.python.org/downloads/ and tick
echo  "Add python.exe to PATH" on the first screen, then try again.
goto :end

:pipfail
echo.
echo  Installing OpenCV failed. Check the internet connection and try again.

:end
echo.
echo  Press any key to close this window.
pause >nul
