@echo off
echo ================================================
echo   HifiGuard - Build Script
echo ================================================
echo.

:: Verifier Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python n'est pas installe ou pas dans le PATH.
    pause & exit /b 1
)

:: Verifier Node
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas installe ou pas dans le PATH.
    pause & exit /b 1
)

echo [1/4] Installation des dependances Python...
pip install pyinstaller soundcard numpy scipy pycaw comtypes --quiet
if errorlevel 1 ( echo [ERREUR] pip install a echoue. & pause & exit /b 1 )

echo [2/4] Compilation du daemon Python en .exe (PyInstaller)...
pyinstaller --onefile --noconsole --name hifiguard --distpath daemon/dist daemon/hifiguard.py --clean
if errorlevel 1 ( echo [ERREUR] PyInstaller a echoue. & pause & exit /b 1 )

echo [3/4] Installation des dependances Node...
npm install --quiet
if errorlevel 1 ( echo [ERREUR] npm install a echoue. & pause & exit /b 1 )

echo [4/4] Build Electron (installeur + portable)...
npm run build
if errorlevel 1 ( echo [ERREUR] electron-builder a echoue. & pause & exit /b 1 )

echo.
echo ================================================
echo   Build termine ! Fichiers dans : dist/
echo   - HifiGuard Setup 1.0.0.exe  (installeur)
echo   - HifiGuard-1.0.0-portable.exe  (portable)
echo ================================================
pause
