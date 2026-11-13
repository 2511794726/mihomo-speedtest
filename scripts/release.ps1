$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

# 1. 读取版本号与时间戳
$Pkg = Get-Content -Raw -Encoding UTF8 -Path "package.json" | ConvertFrom-Json
$Version = $Pkg.version
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BundleName = "mihomo-speedtest-v$Version-$Timestamp"

$ReleaseRoot = Join-Path $RootDir "release"
$StageDir = Join-Path $ReleaseRoot $BundleName
$BinStageDir = Join-Path $StageDir "bin"
$ZipPath = Join-Path $ReleaseRoot "$BundleName.zip"

Write-Host "=== 开始打包: $BundleName ===" -ForegroundColor Cyan

# 2. 构建 Vue 3 前端
Write-Host "[1/4] 正在构建 Vue 3 前端..."
npm --prefix web run build
if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }

# 3. 定位 Go 编译器并编译单文件 exe
$GoExe = "go"
if (-not (Get-Command $GoExe -ErrorAction SilentlyContinue)) {
  $FallbackGo = "C:\Program Files\Go\bin\go.exe"
  if (Test-Path $FallbackGo) {
    $GoExe = $FallbackGo
  } else {
    throw "未找到 Go 编译器，请先安装 Go 1.22+"
  }
}

New-Item -ItemType Directory -Force -Path $BinStageDir | Out-Null
$OutExe = Join-Path $StageDir "mihomo-speedtest.exe"

Write-Host "[2/4] 正在编译 mihomo-speedtest.exe..."
$env:GOPROXY = "https://goproxy.cn,direct"
& $GoExe build -ldflags="-s -w" -o $OutExe .
if ($LASTEXITCODE -ne 0) { throw "Go 编译失败" }

# 4. 准备 bin/ 文件夹与说明文件
Write-Host "[3/4] 正在准备 bin/ 内核目录与使用说明..."
$KernelCandidates = @(
  (Join-Path $RootDir "bin\mihomo.exe"),
  "C:\Program Files\Clash Verge\verge-mihomo.exe",
  "C:\Program Files\Clash Verge\mihomo.exe",
  "$env:LOCALAPPDATA\Programs\Clash Verge\verge-mihomo.exe",
  "$env:LOCALAPPDATA\Programs\Clash Verge\mihomo.exe"
)

$CopiedKernel = $false
foreach ($Candidate in $KernelCandidates) {
  if ($Candidate -and (Test-Path $Candidate)) {
    Copy-Item -Path $Candidate -Destination (Join-Path $BinStageDir "mihomo.exe") -Force
    $CopiedKernel = $true
    Write-Host "  已内置内核: $Candidate -> bin\mihomo.exe"
    break
  }
}

if (-not $CopiedKernel) {
  Set-Content -Path (Join-Path $BinStageDir "请放入mihomo.exe.txt") -Value "请将 Windows x64 版 mihomo.exe 放入本 bin 文件夹中（如果电脑已安装 Clash Verge，程序也会自动探测）。" -Encoding UTF8
}

$GuideText = @"
Mihomo Speedtest v$Version
构建时间: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

【快速使用】
1. 直接双击运行 mihomo-speedtest.exe。
2. 程序会自动分配可用端口（默认 19190）并自动打开浏览器界面。
3. 在页面顶部输入你的机场订阅链接，点击「开始测速」即可。
4. 若提示安全软件拦截，请将本目录加入白名单放行。

【目录说明】
- mihomo-speedtest.exe : 主程序（已内置 Web 界面，无需 Node.js）
- bin\mihomo.exe       : Mihomo 代理核心
- settings.json        : 首次运行后自动生成的个人配置文件
- results\             : 测速结果与历史留痕目录
"@
Set-Content -Path (Join-Path $StageDir "使用说明.txt") -Value $GuideText -Encoding UTF8

# 5. 打包成带版本和时间的 .zip 压缩包
Write-Host "[4/4] 正在生成压缩包..."
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path $StageDir -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "打包完成！" -ForegroundColor Green
Write-Host "发布目录: $StageDir"
Write-Host "压缩包路径: $ZipPath"
