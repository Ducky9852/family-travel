@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 우리 가족 여행 플래너 로컬 서버를 시작합니다...
echo 브라우저가 자동으로 열립니다 (http://127.0.0.1:8765)
start "" "http://127.0.0.1:8765"
python -m http.server 8765 --bind 127.0.0.1
pause
