# 飞牛 fnOS 应用打包（.fpk）

把家账簿打包为飞牛 fnOS 应用中心的 `.fpk` 安装包（**原生应用**，非 Docker：内置 Node.js 运行时，无需注册表/镜像仓库）。

## 前置条件

| 依赖 | 说明 |
|---|---|
| fnpack | 官方打包工具，[下载](https://developer.fnnas.com/docs/cli/fnpack/)。Linux x86: `fnpack-1.2.3-linux-amd64`，Windows: `fnpack-1.2.3-windows-amd64`，下载后 `chmod +x` 或用 `FNPACK_BIN` 指定路径 |
| bash / curl / tar / node | 打包机需要（在 NAS 或 WSL/Git Bash 里跑均可） |

## 打包

```bash
cd packaging/fpk
bash build-fpk.sh          # 版本号默认取 package.json
bash build-fpk.sh 1.0.1    # 或显式指定（飞牛要求 X.Y.Z 格式）
```

产物：`dist/homeledger-<版本>.fpk`

脚本流程：生成 fnpack 项目骨架 → 下载 Node v22 linux-x64 官方运行时 → 复制源码与 node_modules（纯 JS，零原生依赖）→ 写入 manifest/privilege/resource/ui 配置 → `fnpack build`。

### 备用：make-fpk.py（不依赖 fnpack 的纯 Python 打包）

Windows 上 fnpack 生成的 tar 会丢 Unix 可执行位，`make-fpk.py` 直接以 Python tarfile 显式写权限位，适合本地快速出包：

```bash
# 0) 准备工作目录 fpk-work/app/：runtime/node 放官方 node-v22.22.2-linux-x64 二进制
#    （校验: sha256sum 应为 81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90）
# 1) 同步源码（每次发版都要重新同步！）
rm -rf fpk-work/app/homeledger
mkdir -p fpk-work/app/homeledger
cp server.js package.json package-lock.json fpk-work/app/homeledger/
cp -r src public node_modules fpk-work/app/homeledger/
# 2) 清掉上次的外层残留 —— make-fpk.py 的 write_text 只在文件不存在时写入，
#    不清的话 manifest 会停留在旧版本号（踩过：打出来还是 1.0.1）
rm -rf fpk-work/outer
# 3) 打包（版本号自动取 package.json）
python packaging/fpk/make-fpk.py . dist/homeledger-<版本>.fpk ../fpk-work
# 4) 校验：外层 manifest version / app.tgz 内 package.json 版本 / runtime/node 与 server.js 的 mode=755 / 回调脚本为空实现
```

## 安装到飞牛

1. `.fpk` 上传到 NAS 任意目录
2. 飞牛桌面 → **应用中心** → 右上角 **设置** → **手动安装应用** → 选择 `.fpk`
3. 桌面出现「家账簿」图标，浏览器打开，端口 **5111**

## 包内结构

```
manifest              应用元数据（appname=homeledger, service_port=5111, platform=x86）
app.tgz
  homeledger/         源码 + node_modules（Express/EJS，纯 JS）
  runtime/node        Node.js v22 官方 linux-x64 运行时（node:sqlite 需 ≥22.5）
  ui/config           桌面入口（http://<NAS>:5111）
  ui/images/          桌面图标
cmd/main              生命周期：start/stop/status（PID + 日志写入 TRIM_PKGVAR）
config/privilege      以 package 专用用户运行（非 root）
config/resource       data-share 声明（数据目录由飞牛托管）
ICON.PNG / ICON_256   应用图标
wizard/               安装向导（空）
```

## 数据与升级

**应用代码与数据分处两个目录**，安装动作只替换代码：

| 内容 | 目录 | 安装/升级时 |
| --- | --- | --- |
| 应用代码（server.js、src、runtime/node） | `/vol1/@appcenter/homeledger/app` | 整体替换（版本变新才生效） |
| 账本数据（`homeledger.db` + `uploads/` 截图） | `/vol1/@appdata/homeledger/data` | **不动** |

- **覆盖安装 / 升级不丢数据**：应用中心 → 手动安装 → 选新的 `.fpk` 覆盖即可
- `cmd/main` 启动时的数据目录固定为 `${TRIM_PKGVAR}/data`，安装脚本（`uninstall_*` / `upgrade_*`）都是空实现，从不触碰数据目录
- **会丢数据的只有卸载**：飞牛卸载第三方应用时会询问是否「清除本地数据」，勾选即删除 `@appdata/homeledger`。所以升级时**不要先卸载再装**
- 备份两条路：
  1. 应用内「导出备份页（/export）」→ 下载一份当前数据（含全部账本与截图）
  2. SSH 直接拷贝数据目录：
     ```bash
     find /vol1 -name homeledger.db 2>/dev/null   # 先确认路径
     cp -r /vol1/@appdata/homeledger/data /vol1/某个安全目录/homeledger-backup-$(date +%F)
     ```
- 恢复：停用应用 → 把备份内容放回 `data/` → 启动（或用应用内「系统管理 → 恢复备份」上传）

## 已知限制

- 仅 x86_64（飞牛第三方应用当前只支持 x86 平台）
- `checkport=true`：安装时若 5111 被占用会提示，需先释放端口
- AI 截图识别需在应用内配置模型服务（见 README「配置 AI 识别」）

### 桌面打开方式：url vs iframe（v1.1.1 起）

`ui/config` 入口的 `type` 字段决定桌面点图标的行为：

| type | 行为 | 适用 |
| --- | --- | --- |
| `url` | 浏览器新标签页打开 | 老版本 fnOS 不支持 iframe 时的兜底 |
| `iframe` | 飞牛桌面内嵌窗口打开（v1.1.1 默认） | 桌面体验一致，不跳浏览器 |

注意：
- iframe 模式要求应用**不发送** `X-Frame-Options` / CSP `frame-ancestors` 响应头，否则内嵌空白。家账簿未设置这些头，天然支持；若以后引入 helmet 之类中间件需关掉 frameguard。
- 两种模式 URL 拼接都是 `{protocol}://{桌面地址的 hostname}:{port}{url}`，改了 `protocol`/`port` 要同步 manifest 的 `service_port`。
- 改动只涉及 `ui/config`，服务端代码无需变更；重打包仍走上面的 make-fpk.py 流程。
