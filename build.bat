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

echo [1/5] Installing Python dependencies...
pip install pyinstaller soundcard sounddevice numpy scipy pycaw comtypes --quiet
if errorlevel 1 ( echo [ERROR] pip install failed. & pause & exit /b 1 )

echo [2/5] Compiling Python daemon to .exe (PyInstaller)...
python -m PyInstaller --onefile --noconsole --name hifiguard-daemon --distpath daemon/dist daemon/hifiguard.py --clean
if errorlevel 1 ( echo [ERROR] PyInstaller failed. & pause & exit /b 1 )

echo [3/5] Auditing and fixing Node vulnerabilities...
call npm audit fix --quiet
if errorlevel 1 ( echo [WARNING] npm audit fix encountered issues, continuing build... )

echo [4/5] Installing Node dependencies...
call npm install --quiet
if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )

echo [5/5] Building Electron (installer + portable)...
call npm run build
if errorlevel 1 ( echo [ERROR] electron-builder failed. & pause & exit /b 1 )

echo.
echo ================================================
echo   Build complete! Files in: dist/
echo   - HifiGuard-Setup-1.0.0.exe  (installer)
echo   - HifiGuard-1.0.0-portable.exe  (portable)
echo ================================================
pause
