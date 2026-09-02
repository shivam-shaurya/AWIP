@echo off
title AWIP Command Centre Launcher
color 0B
echo =====================================================================
echo                AWIP: AI Workforce Intelligence Platform              
echo                  Local Workspace Dev Server Launcher                 
echo =====================================================================
echo.

:: Check if Bun is installed
where bun >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Bun package manager is already installed.
    goto :run_bun
)

echo [INFO] Bun is not detected on this system.
echo [INFO] Attempting to install Bun for Windows automatically...
echo.

:: Install Bun using official script
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"

:: Refresh Path variable for the current session
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

:: Re-verify Bun installation
where bun >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Bun was successfully installed and loaded.
    goto :run_bun
)

echo [WARNING] Bun installation was unsuccessful.
echo [INFO] Checking for Node.js/NPM fallback...
echo.

:: Check Node.js as fallback
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Neither Bun nor Node.js could be found.
    echo.
    echo Please install Bun (https://bun.sh) or Node.js (https://nodejs.org)
    echo on your computer to run the local dev server.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] NPM was not found in path.
    pause
    exit /b 1
)

echo [OK] Node.js and NPM detected. Running fallback setup...
echo.
echo Installing node dependencies (this may take a minute)...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)
echo.
echo Launching development server...
start http://localhost:8080/
call npm run dev
goto :eof

:run_bun
echo.
echo Installing dependencies using Bun...
call bun install
if %errorlevel% neq 0 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)
echo.
echo Launching development server...
start http://localhost:8080/
call bun run dev
goto :eof
