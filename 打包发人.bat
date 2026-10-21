@echo off
REM ===========================================================================
REM  Liangzhi SMS . Unified Portal   PACKAGE RELEASE
REM
REM  ASCII-only, so encoding never matters here.
REM  Same hardening rules as the main launcher (see the header of the launcher
REM  bat, the one whose name is Chinese): never find Node.js through PATH,
REM  call system utilities by absolute path.
REM  Unlike the launcher, this one does set HEAL_IN_BAT=1 so the shared
REM  detection block also repairs this session's PATH -- tools/package-release.mjs
REM  shells out to tar.exe and would silently fail without it.
REM ===========================================================================

setlocal EnableExtensions
cd /d "%~dp0"

set "HEAL_IN_BAT=1"

__DETECT__
if not exist "tools\package-release.mjs" goto :no_entry

goto :have_node

:no_node
echo.
echo   [ERROR] Node.js not found. Install Node.js 18+ from https://nodejs.org
echo   If Node.js IS installed, your system PATH is most likely broken --
echo   double-click "PATH repair tool" on the Desktop first.
echo.
pause
exit /b 1

:no_entry
echo.
echo   [ERROR] tools\package-release.mjs not found.
echo   The package looks incomplete -- please unpack it again.
echo.
pause
exit /b 1

:have_node
echo.
echo   Packaging with Node.js %NODE_VER%
echo.

if exist "%CHCP%" "%CHCP%" 65001 >nul 2>&1
"%NODE_EXE%" "tools\package-release.mjs" %*
set "RESULT=%errorlevel%"
if exist "%CHCP%" "%CHCP%" 936 >nul 2>&1

echo.
pause
exit /b %RESULT%
