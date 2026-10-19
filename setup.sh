#!/usr/bin/env bash
# 开发环境准备：建立指向本地 DSH 部署的软链。
#
# 为什么需要这个脚本：`npm install` 会清理 node_modules 中它不认识的条目，
# 因此软链会在每次安装依赖后消失。安装完依赖后跑一次即可。
#
# 为什么用软链而不是 npm 安装：本机部署运行的是 0.1.2-rc.1，
# 而该版本在 npm 上不存在（404），直接安装会导致类型与运行时版本不一致。
set -euo pipefail

DSH_DEPLOY="${DSH_DEPLOY:-/opt/deepseek-dsh-012}"
PKGS=(cordis dsh-skill)

cd "$(dirname "$0")"
mkdir -p node_modules/@deepseek-ai

for pkg in "${PKGS[@]}"; do
  src="$DSH_DEPLOY/node_modules/@deepseek-ai/$pkg"
  if [ ! -d "$src" ]; then
    echo "错误：找不到 $src" >&2
    exit 1
  fi
  ln -sfn "$src" "node_modules/@deepseek-ai/$pkg"
  echo "已链接 $pkg"
done

echo "软链就绪"
