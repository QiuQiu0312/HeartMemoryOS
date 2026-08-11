$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "心忆需要 Node.js 22.13 或更高版本。" -ForegroundColor Cyan

if (Get-Command winget -ErrorAction SilentlyContinue) {
  $answer = Read-Host "是否允许使用 Windows 自带的 winget 安装 Node.js LTS？输入 Y 继续"
  if ($answer -match '^[Yy]$') {
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    Write-Host "安装命令已完成。若启动窗口仍提示找不到 Node.js，请关闭窗口后重新双击。" -ForegroundColor Green
    exit 0
  }
}

Write-Host "未自动安装。现在打开 Node.js 官方下载页。" -ForegroundColor Yellow
Start-Process "https://nodejs.org/zh-cn/download"
