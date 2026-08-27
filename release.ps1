# 一键发布新版本：改 package.json 版本 → 提交 → 打 tag → 推送（带重试 + 断点续推）。
# 推送 tag 后 GitHub Actions 会自动构建 Windows/macOS 安装包并发布到 Release（不进草稿）。
# GitHub 偶发 443 超时/代理抖动时会自动重试；若整段没推完，等网络好再双击本脚本、输入同一个版本号即可补推。
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# 读 Windows 系统代理（Clash/Verge 开「系统代理」后会写到这里）。
# git 默认不走系统代理，而国内直连 github 常被墙（443 超时/连接重置），所以推送时要显式带上代理。
function Get-SystemProxy {
  try {
    $s = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    if ($s.ProxyEnable -eq 1 -and $s.ProxyServer) {
      if ($s.ProxyServer -match '(?:https?=)?(\d{1,3}(?:\.\d{1,3}){3}:\d+)') { return 'http://' + $Matches[1] }
      if ($s.ProxyServer -match '(?:https?=)?([^;]+:\d+)') { return 'http://' + $Matches[1] }
    }
  } catch { }
  return $null
}

function Push-WithRetry([string]$refspec) {
  $env:GIT_TERMINAL_PROMPT = 0
  $proxy = Get-SystemProxy
  $pa = @()
  if ($proxy) { $pa = @('-c', "http.proxy=$proxy", '-c', "https.proxy=$proxy") }
  for ($i = 1; $i -le 6; $i++) {
    $via = if ($proxy) { "，走代理 $proxy" } else { "，直连（没开系统代理）" }
    Write-Host "  推送 $refspec …（第 $i/6 次$via）" -ForegroundColor Cyan
    git @pa push origin $refspec
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($i -lt 6) { Write-Host "  失败，5 秒后重试…（github 直连常被墙；若一直失败请确认 Clash 已开『系统代理』）" -ForegroundColor Yellow; Start-Sleep -Seconds 5 }
  }
  return $false
}

$path = Join-Path $PSScriptRoot 'package.json'
$raw = [IO.File]::ReadAllText($path)
$m = [regex]::Match($raw, '"version"\s*:\s*"([^"]+)"')
$cur = if ($m.Success) { $m.Groups[1].Value } else { '0.0.0' }
Write-Host ""
Write-Host "  当前版本：v$cur" -ForegroundColor Cyan

$parts = $cur.Split('.')
$suggest = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
$inp = Read-Host "  输入要发布的新版本号（直接回车用 $suggest）"
$ver = if ([string]::IsNullOrWhiteSpace($inp)) { $suggest } else { $inp.Trim().TrimStart('v') }
if ($ver -notmatch '^\d+\.\d+\.\d+$') { Write-Host "  ✗ 版本号格式不对，应为 X.Y.Z（如 1.0.1）" -ForegroundColor Red; Read-Host "  按回车退出"; exit 1 }
$tag = "v$ver"

# 断点续推：若本地已存在该 tag（多半是上次推送没推完），跳过改版本/提交/打 tag，直接补推。
$tagExists = [bool](git tag --list $tag)
if ($tagExists) {
  Write-Host "  检测到本地已存在 tag $tag（上次可能没推完），本次直接补推，不再重复改版本/提交。" -ForegroundColor Yellow
} else {
  # 写回 package.json 的 version（UTF-8 无 BOM，避免影响 Node/electron-builder 读取）
  $raw2 = [regex]::Replace($raw, '("version"\s*:\s*")[^"]*(")', "`${1}$ver`${2}", 1)
  [IO.File]::WriteAllText($path, $raw2, (New-Object Text.UTF8Encoding($false)))
  Write-Host "  已把版本改为 v$ver" -ForegroundColor Green

  git add -A | Out-Null
  $name = (git config user.name 2>$null); $email = (git config user.email 2>$null)
  if (-not $name -or -not $email) {
    git -c user.name="mycursor" -c user.email="mycursor@users.noreply.github.com" commit -m "release $tag" | Out-Null
  } else {
    git commit -m "release $tag" | Out-Null
  }
  git tag $tag | Out-Null
}

Write-Host "  推送中…（若弹出 GitHub 登录，用 525372896 账号授权一次即可，之后不再问）" -ForegroundColor Cyan
$okMain = Push-WithRetry "main"
$okTag = Push-WithRetry $tag

Write-Host ""
if ($okMain -and $okTag) {
  Write-Host "  ✅ 已推送 $tag，GitHub Actions 正在出包，约 5-10 分钟后自动发布到 Release。" -ForegroundColor Green
  Write-Host "     构建进度： https://github.com/525372896/mycursor-switch/actions"
  Write-Host "     查码小站下载按钮/直链无需改动，始终指向最新版。"
} else {
  Write-Host "  ⚠ 推送没全部成功（main=$okMain, tag=$okTag）。" -ForegroundColor Yellow
  Write-Host "     等网络恢复后，重新双击本脚本、输入同一个版本号 $ver，即可从这里断点补推。" -ForegroundColor Yellow
}
Write-Host ""
Read-Host "  按回车退出"
