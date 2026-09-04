#!/bin/bash
# MyCursor 换号助手 · macOS「已损坏 / 无法验证 / 已阻止以防恶意软件并移到废纸篓」一键修复
# 作用：把被系统丢进废纸篓的 App 放回「应用程序」+ 去掉下载隔离标记 + ad-hoc 重签，让未签名应用能正常打开。
# 用法：右键本文件 →「打开」（首次可能要去 系统设置 > 隐私与安全性 点「仍要打开」）。
#       双击提示「没有适当的访问权限」时，在终端里执行：chmod +x ~/Downloads/fix-macos.command && ~/Downloads/fix-macos.command

cd "$(dirname "$0")" 2>/dev/null

echo "==============================================="
echo "  MyCursor 换号助手 · macOS 一键修复"
echo "==============================================="
echo ""

# 先给下载目录里的 dmg 去隔离，防止重装时 App 再被删
for dmg in "$HOME/Downloads"/MyCursorSwitch-mac-*.dmg; do
  [ -f "$dmg" ] && xattr -cr "$dmg" 2>/dev/null && echo "已给安装包去隔离：$dmg"
done

APP=""
if [ -d "/Applications/MyCursorSwitch.app" ]; then
  APP="/Applications/MyCursorSwitch.app"
elif [ -d "$HOME/Applications/MyCursorSwitch.app" ]; then
  APP="$HOME/Applications/MyCursorSwitch.app"
elif [ -d "$HOME/.Trash/MyCursorSwitch.app" ]; then
  # macOS 15 起 Gatekeeper 可能直接把 App「移到废纸篓」，这里帮用户放回去
  echo "检测到 MyCursorSwitch.app 在废纸篓里（被系统拦截移入），正在放回「应用程序」…"
  if mv "$HOME/.Trash/MyCursorSwitch.app" /Applications/ 2>/dev/null; then
    APP="/Applications/MyCursorSwitch.app"
  else
    echo "❌ 放回失败，请手动到「废纸篓」右键 MyCursorSwitch.app →「放回原处」后再运行本脚本。"
    read -p "按回车退出…" _
    exit 1
  fi
else
  for cand in ./*.app ../*.app "$HOME/Downloads"/*.app; do
    if [ -d "$cand" ]; then APP="$cand"; break; fi
  done
fi

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "❌ 没找到 MyCursorSwitch.app。"
  echo "   请先打开下载的 .dmg，把里面的 App 拖进「应用程序」，再运行本脚本。"
  echo ""
  read -p "按回车退出…" _
  exit 1
fi

echo "处理应用：$APP"
echo ""
xattr -rd com.apple.quarantine "$APP" 2>/dev/null
xattr -cr "$APP" 2>/dev/null
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

echo "✅ 修复完成！现在去「应用程序」双击 MyCursorSwitch 打开即可。"
echo "   如果仍被拦：系统设置 > 隐私与安全性 > 拉到底 > 点「仍要打开」。"
echo "   还不行就用「开发者工具法」：终端运行 spctl developer-mode enable-terminal，"
echo "   到 系统设置 > 隐私与安全性 > 开发者工具 打开「终端」开关，重启后在终端 open -a MyCursorSwitch"
echo ""
read -p "按回车退出…" _
