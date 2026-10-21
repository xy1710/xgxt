@echo off
REM ===========================================================================
REM  Liangzhi SMS . Unified Portal   ONE-CLICK START
REM
REM  This file is deliberately ASCII-only.
REM  Reason: cmd.exe parses .bat files using the system ANSI code page (GBK on
REM  Chinese Windows), so a UTF-8 .bat containing Chinese text gets mangled --
REM  titles become garbage and even variables can be corrupted.
REM  All the real work (and all the Chinese output) lives in tools\start.mjs,
REM  which Node reads as UTF-8 and prints correctly.
REM
REM  Change console to UTF-8 (65001) so Node's Chinese output renders properly.
REM ===========================================================================

setlocal
chcp 65001 >nul 2>&1

REM Force UTF-8 for Node's stdio on Windows.
set "PYTHONIOENCODING=utf-8"

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 call :find_node
if errorlevel 1 goto :no_node

if not exist "tools\start.mjs" goto :no_entry

node "tools\start.mjs" %*
goto :done

:find_node
REM ---------------------------------------------------------------------------
REM  Explorer's environment can be stale: if PATH was edited after login and
REM  Explorer was never restarted, "where node" fails even though Node is
REM  installed. Probe the usual install locations and prepend the hit to PATH.
REM ---------------------------------------------------------------------------
for /d %%D in (
  "D:\Node.js*"
  "%~dp0node*"
  "%~dp0..\node*"
  "%ProgramFiles%\nodejs"
  "%ProgramFiles(x86)%\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
  "%LOCALAPPDATA%\nodejs"
) do (
  if exist "%%~D\node.exe" (
    set "PATH=%%~D;%PATH%"
    echo   [INFO] Node.js found at: %%~D
    exit /b 0
  )
)
REM nvm for Windows keeps versions under %APPDATA%\nvm\vXX.YY.Z\
if exist "%APPDATA%\nvm" (
  for /f "delims=" %%V in ('dir /b /ad /o-n "%APPDATA%\nvm" 2^>nul') do (
    if exist "%APPDATA%\nvm\%%V\node.exe" (
      set "PATH=%APPDATA%\nvm\%%V;%PATH%"
      echo   [INFO] Node.js found at: %APPDATA%\nvm\%%V
      exit /b 0
    )
  )
)
exit /b 1

:no_node
echo.
echo   [ERROR] Node.js not found. / 没有找到 Node.js
echo.
echo   Please install Node.js 18 or higher, then run this file again.
echo   请先安装 Node.js 18 或更高版本，然后重新双击本文件。
echo.
echo   Download / 下载地址: https://nodejs.org   (choose LTS / 选 LTS)
echo.
pause
exit /b 1

:no_entry
echo.
echo   [ERROR] tools\start.mjs not found.
echo   The package looks incomplete -- please re-extract the archive.
echo.
echo   找不到 tools\start.mjs，包可能解压不完整，请重新解压。
echo.
pause
exit /b 1

:done
REM Keep the window open either way: on error so the user can read it,
REM on success so the URL stays visible (many users never notice that the
REM browser opened by itself, or have no default browser at all).
REM The launcher writes the real address (Vite may have shifted the port)
REM to tools\.last-url -- prefer it over the hard-coded default.
set "URL=http://localhost:5173"
if exist "tools\.last-url" (
  for /f "usebackq delims=" %%U in ("tools\.last-url") do set "URL=%%U"
)
if errorlevel 1 (
  echo.
  echo   ---- startup returned an error, see messages above ----
  echo   ---- 启动未成功，请看上面的提示 ----
  echo.
) else (
  echo.
  echo   Services are running in the background. Closing this window is safe.
  echo   服务已在后台运行，可以关闭本窗口（关闭不影响已经起来的服务）。
  echo   Website: %URL%
  echo.
)
pause
exit /b 0
