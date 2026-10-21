@echo off
REM ===========================================================================
REM  Liangzhi SMS . Unified Portal   ONE-CLICK START
REM
REM  Hardened 2026-10-15.  Please read this header before editing the file.
REM
REM  WHY IT IS WRITTEN THIS WAY
REM    The old version detected Node.js with `where node`. On this machine the
REM    machine-level PATH had been corrupted:
REM        %SystemRoot%\system32       had become   %S  +  stemRoot%\system32
REM        C:\Program Files\nodejs\    had become   C   +  \Program Files\nodejs\
REM    i.e. a stray semicolon had been inserted in the middle, so
REM    C:\Windows\System32 was effectively no longer on PATH.
REM    where.exe lives in System32 -- with System32 gone, `where` itself is
REM    unresolvable, the probe returned errorlevel 1, and this launcher printed
REM    "Node.js not found" while Node.js was installed and perfectly usable.
REM
REM  FOUR RULES -- please keep them while editing:
REM    [1] Never look for Node.js through PATH. Probe the known install
REM        directories with a plain `if exist` first.
REM    [2] Call system utilities by ABSOLUTE path: "%SystemRoot%\System32\xxx".
REM    [3] This file deliberately does NOT patch PATH -- if it did, the
REM        "PATH is broken" condition would be silently hidden instead of
REM        reported. tools/start.mjs re-adds the missing system directories
REM        inside the Node process (session-local, registry untouched) and
REM        prints a clear warning, so npm / netstat / taskkill work again for
REM        its child processes.
REM    [4] Text encoding: this file is stored as GBK (the machine's ANSI code
REM        page is 936 on Chinese Windows), so the Chinese below must be
REM        printed while the console is still at 936. The console is switched
REM        to UTF-8 (65001) only for the moments Node runs -- Node writes UTF-8
REM        -- and switched straight back afterwards, otherwise these messages
REM        turn into garbage. -> If you need to save this file, save it as
REM        ANSI/GBK, not as UTF-8.
REM ===========================================================================

setlocal EnableExtensions
cd /d "%~dp0"

title 良志学管系统 - 一键启动

REM --- find Node.js without trusting PATH -----------------------------------
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

if not exist "tools\start.mjs" goto :no_entry

echo.
echo   Node.js %NODE_VER%
echo   位置    %NODE_EXE%
echo   正在启动，请稍候 ...（首次运行要装依赖、建库、导数据，约 1~3 分钟）
echo.

REM --- hand over to Node; console in UTF-8 while Node prints -----------------
if exist "%CHCP%" "%CHCP%" 65001 >nul 2>&1
"%NODE_EXE%" "tools\start.mjs" %*
set "RC=%errorlevel%"
if exist "%CHCP%" "%CHCP%" 936 >nul 2>&1

if "%RC%"=="0" goto :done
echo.
echo   ---- 启动过程报错，请把上面的信息截图发我 ----
echo.
pause
exit /b %RC%

:done
exit /b 0

:no_node
echo.
echo   [ERROR] Node.js not found. / 没有找到 Node.js
echo.
echo   已经查过这些位置：
echo     %ProgramFiles%\nodejs\node.exe
echo     %SystemDrive%\Program Files (x86)\nodejs\node.exe
echo     %LOCALAPPDATA%\Programs\nodejs\node.exe
echo.
echo   确实没装的话：去 https://nodejs.org 下载 LTS 版装上，再重新双击本文件。
echo.
echo   ！！如果确认装过 Node.js，那多半是系统 PATH 被改坏了 ！！
echo   请双击桌面「修复PATH工具」文件夹里的「一键修复PATH.bat」，
echo   修好之后再回来跑本文件。
echo.
pause
exit /b 1

:no_entry
echo.
echo   [ERROR] tools\start.mjs not found. / 找不到 tools\start.mjs
echo   安装包可能不完整，请重新解压后再试。
echo.
pause
exit /b 1
