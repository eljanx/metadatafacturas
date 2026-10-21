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
:descargar
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; $t=''; if (Test-Path .env) { $l = Select-String -Path .env -Pattern '^GITHUB_TOKEN=(.+)$' | Select-Object -First 1; if ($l) { $t = $l.Matches[0].Groups[1].Value.Trim() } }; $h=@{'User-Agent'='facturas-farmacia'}; if ($t) { $h['Authorization']='Bearer '+$t }; try { Invoke-WebRequest -UseBasicParsing -Headers $h -Uri 'https://api.github.com/repos/eljanx/metadatafacturas/zipball/claude/funny-planck-sz7d17' -OutFile $env:ZIP } catch { if ($t) { exit 3 } else { exit 2 } }; Expand-Archive -Force -Path $env:ZIP -DestinationPath $env:TMPDIR"
if errorlevel 3 goto :token_malo
if errorlevel 2 goto :pedir_token
if errorlevel 1 goto :error
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

:pedir_token
echo.
echo El repositorio de GitHub es PRIVADO y no hay token guardado (o no hay internet).
echo Crea un token de solo lectura en GitHub:
echo   github.com ^> Settings ^> Developer settings ^> Personal access tokens ^> Fine-grained tokens
echo   Repository access: solo "metadatafacturas"  /  Permissions ^> Contents: Read-only
goto :preguntar_token

:token_malo
echo.
echo GitHub ha rechazado el token guardado (caducado, mal copiado o sin acceso a este repositorio).
echo Crea uno nuevo: Fine-grained token, solo "metadatafacturas", Contents: Read-only.

:preguntar_token
set "TOKEN="
set /p "TOKEN=Pega el token de GitHub (Intro para cancelar): "
if "%TOKEN%"=="" goto :sin_acceso
if exist ".env" powershell -NoProfile -Command "(Get-Content .env | Where-Object { $_ -notmatch '^GITHUB_TOKEN=' }) | Set-Content -Encoding ascii .env"
>>.env echo GITHUB_TOKEN=%TOKEN%
echo Token guardado en .env. Reintentando...
goto :descargar

:sin_acceso
echo.
echo No se ha actualizado. Puedes volver a intentarlo cuando tengas el token.
pause
exit /b 1

:error
echo.
echo Algo ha fallado. Haz una captura de esta ventana y ensenasela a Claude.
pause
exit /b 1
