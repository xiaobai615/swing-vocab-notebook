@echo off
chcp 65001 >nul
title 英语生词本 - 手机局域网访问服务器
echo ============================================
echo  英语生词本 - 局域网服务器
echo  手机连接本机同一 Wi-Fi 后，在手机浏览器打开：
echo   http://本机IP:8000
echo   (IP 见下方 "本机局域网 IP")
echo  按 Ctrl+C 或关闭本窗口即可停止服务
echo ============================================
echo.

REM 显示本机局域网 IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    echo 本机局域网 IP: %%a
)
echo.

REM 启动静态服务器（web 目录）
cd /d "%~dp0web"
python -m http.server 8000 --bind 0.0.0.0
pause
