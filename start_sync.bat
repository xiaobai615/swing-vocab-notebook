@echo off
rem swing vocab sync helper - serves the app on localhost and proxies WebDAV
setlocal
set PY=python
where python >nul 2>nul || set PY=D:\ABC\python.exe
echo Starting swing vocab sync helper...
"%PY%" tools\sync_server.py
pause
