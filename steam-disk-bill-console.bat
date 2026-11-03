@echo off
cd /d "%~dp0"
if exist "D:\Programs\nodejs\node.exe" (
    "D:\Programs\nodejs\node.exe" src\server.mjs
) else (
    node src\server.mjs
)
pause
