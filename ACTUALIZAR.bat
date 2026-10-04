@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Actualizar Facturas Farmacia
echo ============================================================
echo   ACTUALIZANDO FACTURAS FARMACIA
echo   Tus claves, tu configuracion y tus facturas se conservan.
echo   Si la app esta en marcha, cierra antes su ventana.
echo ============================================================
set "ZIP=%TEMP%\facturas_actualizacion.zip"
set "TMPDIR=%TEMP%\facturas_actualizacion"
set "NUEVA="
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
echo Descargando la ultima version...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $t=''; if (Test-Path .env) { $l = Select-String -Path .env -Pattern '^GITHUB_TOKEN=(.+)$' | Select-Object -First 1; if ($l) { $t = $l.Matches[0].Groups[1].Value.Trim() } }; $h=@{'User-Agent'='facturas-farmacia'}; if ($t) { $h['Authorization']='Bearer '+$t }; Invoke-WebRequest -UseBasicParsing -Headers $h -Uri 'https://api.github.com/repos/eljanx/metadatafacturas/zipball/claude/funny-planck-sz7d17' -OutFile $env:ZIP; Expand-Archive -Force -Path $env:ZIP -DestinationPath $env:TMPDIR"
if errorlevel 1 goto :sin_acceso
for /d %%D in ("%TMPDIR%\*") do set "NUEVA=%%D"
if not defined NUEVA goto :error
echo Copiando archivos...
robocopy "%NUEVA%" "%~dp0." /E /NFL /NDL /NJH /NJS /NP /XD data node_modules .git /XF .env >nul
if errorlevel 8 goto :error
if not exist "node_modules" goto :sin_instalar
echo Actualizando componentes...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto :error
rmdir /s /q "%TMPDIR%" >nul 2>nul
del "%ZIP%" >nul 2>nul
echo.
echo ============================================================
echo   ACTUALIZADO. Ahora haz doble clic en ARRANCAR.bat
echo ============================================================
pause
exit /b 0

:sin_instalar
echo Archivos actualizados. Ahora haz doble clic en INSTALAR.bat
pause
exit /b 0

:sin_acceso
echo.
echo No he podido descargar la actualizacion. El repositorio de GitHub es privado:
echo hace falta el token de GitHub (paso 3 de INSTALAR.bat). Para ponerlo o cambiarlo,
echo ejecuta: node scripts\configurar.js
pause
exit /b 1

:error
echo.
echo Algo ha fallado. Haz una captura de esta ventana y ensenasela a Claude.
pause
exit /b 1
