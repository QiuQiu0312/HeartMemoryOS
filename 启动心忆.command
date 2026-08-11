#!/bin/zsh

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js。心忆需要 Node.js 22.13 或更高版本。"
  echo "正在打开官方下载页；安装当前 LTS 版本后，再双击本文件。"
  open "https://nodejs.org/zh-cn/download" >/dev/null 2>&1
  echo ""
  read "?按回车键关闭…"
  exit 1
fi

exec node scripts/launch.mjs
