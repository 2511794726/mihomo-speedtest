@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Mihomo Speedtest 启动器

cd /d "%~dp0"

:: 1. 检查 Node.js 是否已安装
where node >nul 2>nul
if errorlevel 1 (
  echo [提示] 未检测到 Node.js 环境（需要 Node.js v18 或更高版本）。
  where winget >nul 2>nul
  if not errorlevel 1 (
    set /p INSTALL_CHOICE=是否使用 Windows 自带的 winget 自动安装 Node.js LTS？(Y/n): 
    if /i not "!INSTALL_CHOICE!"=="n" (
      echo 正在通过 winget 安装 OpenJS.NodeJS.LTS，请稍候...
      winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
      if errorlevel 1 (
        echo [错误] winget 安装失败，正在为你打开 Node.js 官网手动下载...
        start "" "https://nodejs.org"
        pause
        exit /b 1
      )
      echo.
      echo [完成] Node.js 安装成功！请关闭本窗口后重新双击“启动测速面板.bat”。
      pause
      exit /b 0
    )
  )
  echo 正在为你打开 Node.js 官网下载页，安装 LTS 版本后请重新运行本脚本...
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

:: 2. 检查 Node.js 主版本号是否 >= 18
for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_VER=%%a
set NODE_MAJOR=%NODE_VER:v=%
if %NODE_MAJOR% LSS 18 (
  echo [错误] 当前 Node.js 版本为 v%NODE_MAJOR% ，本项目需要 v18 或更高版本！
  echo 正在为你打开 Node.js 官网下载最新版本...
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

:: 3. 首次运行自动安装精简运行依赖
if not exist "node_modules\" (
  echo [首次运行] Node.js v%NODE_MAJOR% 检查通过，正在安装运行依赖...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络连接后重试。
    pause
    exit /b 1
  )
)

:: 4. 启动服务并打开图形界面
echo [环境就绪] Node.js v%NODE_MAJOR% | 正在启动 Mihomo Speedtest 图形界面...
node src/launcher.js
if errorlevel 1 (
  echo.
  echo [异常退出] 请查看上方错误信息。
  pause
)
