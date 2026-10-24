@echo off
setlocal EnableExtensions

rem Always run from the project root (this file lives in bin\).
cd /d "%~dp0.."

if "%~1"=="" goto usage
if "%~2"=="" goto usage

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH.
  exit /b 1
)

if not exist "tools\performance-video\make_video.py" (
  echo [ERROR] tools\performance-video\make_video.py not found.
  exit /b 1
)

rem 1) video: use the given path if it exists, otherwise look under media\input
set "VIDEO=%~1"
if not exist "%VIDEO%" set "VIDEO=media\input\%~1"

rem 2) score: use the given path if it exists, otherwise look under docs\data\scores
set "SCORE=%~2"
if not exist "%SCORE%" set "SCORE=docs\data\scores\%~2"

if not exist "%VIDEO%" (
  echo [ERROR] Video not found: %VIDEO%
  echo         Put it under media\input\ or pass a relative/absolute path.
  exit /b 1
)

if not exist "%SCORE%" (
  echo [ERROR] Score not found: %SCORE%
  echo         Available scores:
  for %%F in (docs\data\scores\*.jianpu) do echo           %%~nxF
  exit /b 1
)

rem 3) remaining args: [output] [--middle] [--top-offset N] [--robust] [--export-map PATH]
set "OUT="
set "EXTRA="

shift
shift
:parse_extra
if "%~1"=="" goto :extra_done

if /I "%~1"=="--middle" (
  set "EXTRA=%EXTRA% --middle"
  shift
  goto :parse_extra
)

if /I "%~1"=="--top-offset" (
  if "%~2"=="" (
    echo [ERROR] --top-offset requires a number.
    exit /b 1
  )
  set "EXTRA=%EXTRA% --top-offset %~2"
  shift
  shift
  goto :parse_extra
)

if /I "%~1"=="--robust" (
  set "EXTRA=%EXTRA% --robust"
  shift
  goto :parse_extra
)

if /I "%~1"=="--export-map" (
  if "%~2"=="" (
    echo [ERROR] --export-map requires a path.
    exit /b 1
  )
  set "EXTRA=%EXTRA% --export-map %~2"
  shift
  shift
  goto :parse_extra
)

if "%OUT%"=="" set "OUT=%~1"
shift
goto :parse_extra

:extra_done
rem Default to --middle only when no position flag was given.
echo %EXTRA% | findstr /I /C:"--middle" >nul
if not errorlevel 1 goto :position_ready
echo %EXTRA% | findstr /I /C:"--top-offset" >nul
if not errorlevel 1 goto :position_ready
set "EXTRA=%EXTRA% --middle"
:position_ready

if "%OUT%"=="" (
  for %%F in ("%VIDEO%") do set "OUT=media\output\%%~nF.mp4"
)

if not exist "media\output" mkdir "media\output"

echo [make-video] video: %VIDEO%
echo [make-video] score: %SCORE%
echo [make-video] out:   %OUT%
if defined EXTRA echo [make-video] args: %EXTRA%
echo.

python "tools\performance-video\make_video.py" --video "%VIDEO%" --score "%SCORE%" --out "%OUT%" %EXTRA%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [ERROR] make_video.py failed with exit code %CODE%.
  exit /b %CODE%
)

echo.
echo [DONE] %OUT%
exit /b 0

:usage
echo Usage: bin\make-video.cmd ^<video^> ^<score^> [output] [--middle] [--top-offset N] [--robust] [--export-map PATH]
echo Example: bin\make-video.cmd xiaoxingxing.mp4 little-star.jianpu --top-offset 50
echo.
echo   video:   file name under media\input\, or a relative/absolute path
echo   score:   file name under docs\data\scores\, or a relative/absolute path
echo   output:  optional, defaults to media\output\^<video-name^>.mp4
echo   --middle      put the strip in the vertical center (default if no position flag)
echo   --top-offset  distance from the top of the video in pixels
echo   --robust      force measure-anchor alignment
echo   --export-map  write note-to-time JSON for the web player
exit /b 1
