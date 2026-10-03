#!/bin/bash
# 家账簿 → 飞牛 fnOS .fpk 打包脚本
# 用法: ./build-fpk.sh [版本号]   (默认读 package.json 的 version)
# 依赖: bash + curl + tar + fnpack 官方打包工具
#       下载: https://developer.fnnas.com/docs/cli/fnpack/
#         Linux x86: https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64
#         Windows:   https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64
# 产物: dist/homeledger.fpk
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_BASE="$(mktemp -d)"
FPK_DIR="${OUT_BASE}/homeledger-fpk"
NODE_VER="22.22.2"

VERSION="${1:-$(node -p "require('${REPO_ROOT}/package.json').version")}"
: "${FNPACK_BIN:=$(command -v fnpack || true)}"
[ -n "${FNPACK_BIN}" ] || { echo "❌ 未找到 fnpack，请从 https://developer.fnnas.com/docs/cli/fnpack/ 下载"; exit 1; }

echo "==> 1/5 生成项目骨架"
mkdir -p "${FPK_DIR}/app/runtime" "${FPK_DIR}/app/homeledger" \
         "${FPK_DIR}/cmd" "${FPK_DIR}/config" "${FPK_DIR}/wizard" \
         "${FPK_DIR}/app/ui/images"

echo "==> 2/5 下载 Node ${NODE_VER} linux-x64 运行时"
curl -sL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.gz" \
  | tar -xz -C "${OUT_BASE}" "node-v${NODE_VER}-linux-x64/bin/node"
mv "${OUT_BASE}/node-v${NODE_VER}-linux-x64/bin/node" "${FPK_DIR}/app/runtime/node"
chmod +x "${FPK_DIR}/app/runtime/node"

echo "==> 3/5 复制应用源码（排除数据/测试/文档）"
cp "${REPO_ROOT}/server.js" "${REPO_ROOT}/package.json" "${REPO_ROOT}/package-lock.json" \
   "${FPK_DIR}/app/homeledger/"
cp -r "${REPO_ROOT}/src"     "${FPK_DIR}/app/homeledger/src"
cp -r "${REPO_ROOT}/public"  "${FPK_DIR}/app/homeledger/public"
cp -r "${REPO_ROOT}/node_modules" "${FPK_DIR}/app/homeledger/node_modules"
find "${FPK_DIR}" \( -name ".DS_Store" -o -name "Thumbs.db" \) -delete

echo "==> 4/5 写入打包配置"
cat > "${FPK_DIR}/manifest" <<EOF
appname               = homeledger
version               = ${VERSION}
display_name          = 家账簿
desc                  = 纯后端家庭记账网站：账号密码登录，支持支出/收入/转账/借贷/投资/报销/退款等全类型记账；AI 截图/文本自动记账（支持 OpenAI 兼容接口与规则兜底）；支付宝/微信账单导入；多人共享账本、预算、周期账单、储蓄目标、报表图表；开放 API 可对接小龙虾等自动化工具。数据全部存储在本机 SQLite，不上传云端。
platform              = x86
source                = thirdparty
maintainer            = sucraft-hub
maintainer_url        = https://github.com/sucraft-hub/homeledger
distributor           = su
distributor_url       = https://github.com/sucraft-hub/homeledger
os_min_version        = 0.8.0
desktop_uidir         = ui
desktop_applaunchname = homeledger.Application
service_port          = 5111
checkport             = true
disable_authorization_path = true
changelog             = v${VERSION}
EOF

# 图标：外层 ICON.* 供 .fpk 展示，ui/images 供桌面入口引用
cp "$(dirname "$0")/ICON.PNG"    "${FPK_DIR}/ICON.PNG"
cp "$(dirname "$0")/ICON_256.PNG" "${FPK_DIR}/ICON_256.PNG"
cp "${FPK_DIR}/ICON.PNG"          "${FPK_DIR}/app/ui/images/icon_64.png"
cp "${FPK_DIR}/ICON_256.PNG"      "${FPK_DIR}/app/ui/images/icon_256.png"

cat > "${FPK_DIR}/config/privilege" <<'EOF'
{
    "defaults":
    {
        "run-as": "package"
    }
}
EOF

cat > "${FPK_DIR}/config/resource" <<'EOF'
{
  "data-share": {
    "shares": [
      {
        "name": "homeledger"
      },
      {
        "name": "homeledger/data"
      }
    ]
  }
}
EOF

cat > "${FPK_DIR}/app/ui/config" <<'EOF'
{
    ".url": {
        "homeledger.Application": {
            "title": "家账簿",
            "icon": "images/icon_{0}.png",
            "type": "url",
            "protocol": "http",
            "port": "5111",
            "url": "/",
            "allUsers": false
        }
    }
}
EOF

cp "$(dirname "$0")/cmd-main" "${FPK_DIR}/cmd/main" && chmod +x "${FPK_DIR}/cmd/main"

echo "==> 5/6 fnpack build"
mkdir -p "${REPO_ROOT}/dist"
(cd "${FPK_DIR}" && "${FNPACK_BIN}" build)

echo "==> 6/6 修复 tar 权限位（Windows 打包会丢失 Unix 可执行位）"
# fnpack 在 Windows/macOS 上生成的 app.tgz 所有条目 mode=666，
# NAS 解压后 runtime/node 无法执行（应用启动失败）。这里解包后按类型重设权限再重打。
WORK="${OUT_BASE}/repack"
mkdir -p "${WORK}/outer" "${WORK}/app"
FPK_RAW="${FPK_DIR}/../homeledger.fpk"
[ -f "${FPK_RAW}" ] || FPK_RAW="${PWD}/homeledger.fpk"

tar -xzf "${FPK_RAW}" -C "${WORK}/outer"
tar -xzf "${WORK}/outer/app.tgz" -C "${WORK}/app"
find "${WORK}/app" -type d -exec chmod 755 {} +
find "${WORK}/app" -type f -exec chmod 644 {} +
chmod 755 "${WORK}/app/runtime/node" \
          "${WORK}/app/homeledger/server.js" \
          "${WORK}/app/homeledger/node_modules/.bin/"* 2>/dev/null || true
find "${WORK}/app/homeledger/node_modules" -name "*.sh" -exec chmod 755 {} + 2>/dev/null || true

# 外层 cmd/ 脚本同样需要可执行位
find "${WORK}/outer/cmd" -type f -exec chmod 755 {} +

tar -czf "${WORK}/outer/app.tgz" -C "${WORK}/app" homeledger runtime ui
tar -czf "${REPO_ROOT}/dist/homeledger-${VERSION}.fpk" -C "${WORK}/outer" \
    app.tgz cmd config ICON.PNG ICON_256.PNG manifest wizard

rm -rf "${OUT_BASE}" "${FPK_RAW}"
echo ""
echo "✅ 打包完成: dist/homeledger-${VERSION}.fpk"
echo "   安装: 飞牛桌面 → 应用中心 → 右上角设置 → 手动安装应用"
