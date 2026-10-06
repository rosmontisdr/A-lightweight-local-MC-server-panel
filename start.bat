@echo off
rem 本文件必须是 GBK（CP936）编码：cmd.exe 按系统 ANSI 代码页逐字节解析，存成 UTF-8 会使中文字节错位、吞掉随后的 ASCII 字符，脚本无法执行。详见 README。
chcp 936 >nul
setlocal
title RS面板
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo.
  echo   本面板需要 Node.js 18 或更高版本，不需要 npm install，没有任何第三方依赖。
  echo   下载地址: https://nodejs.org/
  echo   安装后请关闭本窗口，重新双击 start.bat。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动面板...
echo   面板会独立在后台运行，随后自动打开浏览器。
echo.

node launch.js
set CODE=%errorlevel%

if not "%CODE%"=="0" (
  echo.
  echo   [错误] 面板没能启动，原因见上面的提示。
  echo   也可以在这个目录下运行 node server.js，直接看完整输出。
  echo.
  pause
  exit /b %CODE%
)
exit /b 0
