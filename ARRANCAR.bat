@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Facturas Farmacia - NO CIERRES ESTA VENTANA
if not exist "node_modules" goto :sin_instalar
if not exist ".env" goto :sin_instalar
echo ============================================================
echo   FACTURAS FARMACIA EN MARCHA
echo   - Se abre en el navegador: http://localhost:3000
echo   - Deja esta ventana abierta (puedes minimizarla).
echo   - Las facturas se procesan solas mientras este abierta.
echo   - Para pararlo, cierra esta ventana.
echo ============================================================
start "" /min powershell -NoProfile -Command "Start-Sleep 4; Start-Process 'http://localhost:3000'"
:bucle
node --disable-warning=ExperimentalWarning --env-file-if-exists=.env server\index.js
echo.
echo La app se ha detenido. Se reinicia sola en 15 segundos...
timeout /t 15 >nul
goto :bucle

:sin_instalar
echo Primero haz doble clic en INSTALAR.bat
pause
