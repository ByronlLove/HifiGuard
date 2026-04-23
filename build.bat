@echo off
echo ================================================
echo   HifiGuard - Build Script
echo ================================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    pause & exit /b 1
)

:: Check Node
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    pause & exit /b 1
)

:: --- VIRTUAL ENVIRONMENT FOR ISOLATION ---
if not exist "venv" (
    echo [INFO] Creating virtual environment for isolation...
    python -m venv venv
)
call .\venv\Scripts\activate
:: -----------------------------------------

echo [1/4] Installing Python dependencies...
pip install pyinstaller soundcard sounddevice numpy scipy pycaw comtypes --quiet
if errorlevel 1 ( echo [ERROR] pip install failed. & pause & exit /b 1 )

echo [2/4] Compiling Python daemon to .exe (PyInstaller)...
python -m PyInstaller --onefile --noconsole --name hifiguard-daemon --distpath daemon daemon/hifiguard.py --clean
if errorlevel 1 ( echo [ERROR] PyInstaller failed. & pause & exit /b 1 )

:: Nettoyage des dossiers temporaires de PyInstaller
if exist "build" rd /s /q build
if exist "hifiguard-daemon.spec" del /q hifiguard-daemon.spec

echo [3/4] Installing Node dependencies...
call npm install --quiet
if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )

echo [4/4] Building Electron (installer + portable)...
call npm run build
if errorlevel 1 ( echo [ERROR] electron-builder failed. & pause & exit /b 1 )

echo.
echo ================================================
echo   Build complete! Files in: dist/
echo   - HifiGuard-Setup-1.1.2.exe  (installer)
echo   - HifiGuard-1.1.2-portable.exe  (portable)
echo ================================================
pause
