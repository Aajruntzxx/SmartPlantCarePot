@echo off
title PotPintar Backend Server
cd /d "%~dp0backend"

echo ====================================================
echo             MEMULAI SERVER POTPINTAR                
echo ====================================================
echo.
echo Pastikan modul MySQL di XAMPP Control Panel sudah di-START (Hijau).
echo.

set "PATH=%PATH%;C:\Program Files\nodejs"

if not exist node_modules (
    echo Menginstal paket dependencies...
    call npm.cmd install
)

echo Memulai server...
echo Buka browser di: http://localhost:3000
echo Tekan Ctrl+C untuk menghentikan server.
echo.

call node server.js
if %errorlevel% neq 0 (
    echo.
    echo ====================================================
    echo [PERHATIAN] Server berhenti atau gagal terhubung.
    echo 1. Buka XAMPP Control Panel, klik tombol START pada MySQL.
    echo 2. Pastikan database 'potpintar_db' sudah ada.
    echo ====================================================
    pause
)
