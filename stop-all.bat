@echo off
REM ===========================================================================
REM  Liangzhi SMS . Unified Portal   STOP ALL SERVICES
REM
REM  Only kills the processes listening on 8004 / 5173. Leaves MySQL running.
REM  Follows the same rules as 一键启动.bat (see its header): never look for
REM  Node.js through PATH, call system utilities by absolute path, do not patch
REM  PATH here (tools/stop.mjs does that in-process), and print Chinese while
REM  the console is still at 936.
REM ===========================================================================

setlocal EnableExtensions
cd /d "%~dp0"

title 良志学管系统 - 停止服务

set "SYS=%SystemRoot%\System32"
set "CHCP=%SYS%\chcp.com"
set "WHICH=%SYS%\where.exe"
set "NODE_EXE="
set "NODE_VER="
set "NODEDIR="

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%SystemDrive%\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=%SystemDrive%\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramData%\nvm\current\node.exe" set "NODE_EXE=%ProgramData%\nvm\current\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if not defined NODE_EXE if exist "%WHICH%" for /f "usebackq delims=" %%i in (`"%WHICH%" node 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE for /f "delims=" %%i in ('node -v 2^>nul') do if not defined NODE_EXE set "NODE_EXE=node"

if not defined NODE_EXE goto :no_node
for /f "usebackq delims=" %%v in (`"%NODE_EXE%" -v 2^>nul`) do set "NODE_VER=%%v"
if not defined NODE_VER goto :no_node

REM 只在显式需要时才由 bat 自己补 PATH（例如打包脚本要用到 tar.exe）。
REM 启动/停止脚本刻意不补 —— 交给 tools/*.mjs 在进程内补，这样「PATH 坏了」
REM 这件事才会被检测到并提示出来，而不是被 bat 悄悄掩盖。
if defined HEAL_IN_BAT set "PATH=%SYS%;%SYS%\Wbem;%SystemRoot%;%PATH%"
for %%i in ("%NODE_EXE%") do set "NODEDIR=%%~dpi"
if defined HEAL_IN_BAT if defined NODEDIR set "PATH=%NODEDIR%%PATH%"

if not exist "tools\stop.mjs" goto :no_entry

echo.
echo   正在停止 8004 / 5173 上的服务（MySQL 不动）...
echo.

if exist "%CHCP%" "%CHCP%" 65001 >nul 2>&1
"%NODE_EXE%" "tools\stop.mjs" %*
set "RC=%errorlevel%"
if exist "%CHCP%" "%CHCP%" 936 >nul 2>&1

echo.
pause
exit /b %RC%

:no_node
echo.
echo   [ERROR] Node.js not found. / 没有找到 Node.js
echo   确认装过 Node.js 的话，多半是系统 PATH 被改坏了：
echo   双击桌面「修复PATH工具」里的「一键修复PATH.bat」修好再来。
echo.
pause
exit /b 1

:no_entry
echo.
echo   [ERROR] tools\stop.mjs not found. / 找不到 tools\stop.mjs
echo   安装包可能不完整，请重新解压后再试。
echo.
pause
exit /b 1
