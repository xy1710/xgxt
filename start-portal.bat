@echo off
REM ===========================================================================
REM  Liangzhi SMS . Unified Portal   START  (thin wrapper, kept for compat)
REM
REM  This file used to be an independent copy of the launcher, which meant two
REM  places to keep in sync. It now simply forwards to 一键启动.bat, so both
REM  entries always behave identically -- including the Node.js detection that
REM  must not depend on PATH (see the header of 一键启动.bat).
REM ===========================================================================

setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0一键启动.bat" goto :no_main

call "%~dp0一键启动.bat" %*
exit /b %errorlevel%

:no_main
echo.
echo   [ERROR] 一键启动.bat not found. / 找不到 一键启动.bat
echo   它与本文件应放在同一个文件夹里，请重新解压安装包。
echo.
pause
exit /b 1
