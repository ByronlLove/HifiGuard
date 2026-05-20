#!/bin/bash

echo "[1/4] Creating Python virtual environment..."
python3 -m venv venv
source venv/bin/activate

echo "[2/4] Installing Python dependencies..."
pip install pyinstaller soundcard sounddevice numpy scipy

echo "[3/4] Compiling the Linux daemon..."
python3 -m PyInstaller --onefile --name hifiguard-daemon --distpath daemon daemon/hifiguard.py --clean

echo "[4/4] Building the Electron AppImage..."
npm install
npm run build -- --linux

echo "Build complete! The AppImage is in the dist/ folder"
