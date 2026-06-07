@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Please install Node.js 20 or newer first.
  pause
  exit /b 1
)

if not exist dist\index.html (
  echo The dist folder is missing. Please run npm run build before packaging this app.
  pause
  exit /b 1
)

echo Starting AI English Speaking Coach...
echo Open http://127.0.0.1:8787 in your browser.
echo.
node server\index.mjs
pause
