@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8080/index.module.html
    py -m http.server 8080
    goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8080/index.module.html
    python -m http.server 8080
    goto :eof
)
echo No se encontro Python. Abre index.html directamente con doble clic.
pause
