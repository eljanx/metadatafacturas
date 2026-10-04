@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Instalador de Facturas Farmacia
echo ============================================================
echo   INSTALADOR DE FACTURAS FARMACIA
echo   Puede tardar unos minutos. No cierres esta ventana.
echo ============================================================
echo.

call :buscar_node
if defined NODE_OK goto :tengo_node

echo No tienes Node.js instalado (o es antiguo). Lo instalo ahora...
where winget >nul 2>nul
if errorlevel 1 goto :sin_winget
winget install -e --id OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%ProgramFiles%\nodejs;%PATH%"
call :buscar_node
if defined NODE_OK goto :tengo_node
echo.
echo Node.js se ha instalado. CIERRA esta ventana y vuelve a hacer doble clic en INSTALAR.bat
pause
exit /b 0

:sin_winget
echo.
echo No puedo instalar Node.js automaticamente en este ordenador.
echo Se abrira la pagina de descarga. Descarga la version LTS, instalala
echo y despues vuelve a hacer doble clic en INSTALAR.bat
start https://nodejs.org/es/download
pause
exit /b 1

:tengo_node
echo Node.js encontrado.
echo Descargando los componentes necesarios...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto :error
echo Componentes instalados.
node scripts\configurar.js
echo.
pause
exit /b 0

:error
echo.
echo Algo ha fallado. Haz una captura de esta ventana y ensenasela a Claude.
pause
exit /b 1

:buscar_node
set "NODE_OK="
where node >nul 2>nul
if errorlevel 1 exit /b 0
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" >nul 2>nul
if not errorlevel 1 set "NODE_OK=1"
exit /b 0
