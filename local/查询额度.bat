@echo off
rem Codex quota checker launcher. Keep this file ASCII-only so it renders
rem correctly under any console codepage; Chinese output comes from node.js.
chcp 65001 >nul
node "%~dp0codex-quota.js" %*
echo.
pause
