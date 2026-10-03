# 📒 家账簿 HomeLedger（Panda-995 维护版）

> 本仓库是 [sucraft-hub/homeledger](https://github.com/sucraft-hub/homeledger) 的 fork。感谢原作者 [@蘇先生](https://github.com/sucraft-hub) 的优秀项目——本仓库在其基础上持续增强：全新 UI/移动端适配、开放 API 全量开放、AI 助手接入、大量安全与功能修复。上游有价值的更新也会酌情同步。

**自托管的家庭记账系统**：网页手动记账 + AI 截图/文本自动记账 + 开放 API 对接聊天机器人（Hermes / OpenClaw 等），所有账目数据都留在你自己的 NAS / 服务器上。

---

## ✨ 本 fork 的增强（相对源仓库）

| 方向 | 内容 |
| --- | --- |
| 🎨 UI/UX | 全新设计体系（浅色/深色）、Lucide 线条图标、桌面端自定义下拉框与确认弹窗 |
| 📱 移动端 | 汉堡抽屉导航、底部弹层、触控目标加大、筛选横滚、23 页零横向溢出 |
| 🤖 开放 API | 除令牌管理与跨账本外的全量能力：交易增删改查与批量、账户/分类/标签/借贷/预算/目标/订阅/周期账单、站点与 AI 设置；权限分层 + 频控 + 全量审计 |
| 🗣️ AI 助手接入 | 内置 Hermes Agent（agentskills.io 标准）与 OpenClaw / PicoClaw 技能包，发截图/说一句话自动记账 |
| 🔒 安全 | 存储型 XSS、越权、SSRF、时区、备份一致性等 70+ 项修复（详见文末更新记录） |

## 🚀 快速开始

新建空目录，保存为 `docker-compose.yml`：

```yaml
services:
  homeledger:
    image: ghcr.milu.moe/panda-995/homeledger:latest   # 加速中转；直连可用 ghcr.io/panda-995/homeledger:latest
    container_name: homeledger
    user: "0:0"        # 免 chown 方案；或对宿主机 data 目录执行 chown -R 1000:1000 后删掉本行
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      SESSION_SECRET: "请改成随机长字符串"     # openssl rand -hex 32
      ADMIN_USER: "admin"
      ADMIN_PASSWORD: "请改成你的强密码"
    ports:
      - "5111:5111"
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

打开 `http://<NAS或服务器IP>:5111` 即可使用（首次启动自动创建管理员，账号密码即上方环境变量）。

- **升级**：`docker compose pull && docker compose up -d`（数据在 `./data`，升级不丢账）
- **手机访问**：同一局域网浏览器直接打开，已完整适配移动端
- 其他部署方式（源码运行 / 飞牛 fnOS 应用包）见源仓库文档，同样适用

## 🗣️ AI 助手自动记账（Hermes / OpenClaw）

1. 「设置 → 开放 API」生成令牌（`hl_` 开头，明文只展示一次）
2. Hermes：把 `skills/homeledger-bookkeeping/` 复制到 `~/.hermes/skills/`；OpenClaw/PicoClaw：用 `openclaw-skill/homeledger-bookkeeping/`
3. 技能读 `HOMELEDGER_URL` 与 `HOMELEDGER_TOKEN` 两个环境变量，之后发截图或说"午饭 35"即可自动记账

AI 截图/文本识别使用 OpenAI 兼容接口（智谱 GLM、通义、DeepSeek、本地 Ollama 均可），在「设置 → AI 记账」中配置。

## 📦 更新记录

> 本节随每次发版更新；完整交互式日志见应用内「关于」页。

### v1.5.0（2026-10-03）

- ✨ **UI/交互打磨**：过渡曲线统一为业界基准（.15s ease-in-out + Material 标准缓动），按压/悬停/行切换反馈补齐
- 🌗 主题切换平滑过渡（浅↔深不再闪变）；页面平滑滚动
- 🖱️ 交易明细：点分类名即按该分类筛选；余额调整改中性色显示并保留正负号
- ♿ 键盘焦点环统一 3.5px 主色

### v1.4.1（2026-10-03）

- README 重写为 fork 版；下拉框 aria-expanded 残留、CSV 回导类型丢失等修复；E2E 首次覆盖（回导保真/备份/性能/多用户/AI 面板）

### v1.4.0（2026-10-03）

- 📱 **移动端全面适配**：汉堡抽屉导航（全部 23 页手机可达）、触控目标 ≥42px、筛选 chips 横滚、确认弹窗改底部弹层、记一笔卡片重排（主表单→分类→保存）、23 页零横向溢出
- 🐛 修复下拉框**关闭后选项面板悬浮不消失**的问题（"点开回不去"的根源）
- 🎨 下拉菜单内容重排：emoji 图标列对齐、余额等副文本右对齐、长文本省略、分组吸顶
- 🐛 修复余额调整交易显示双负号
- ✨ 桌面细节：内容入场动效、选区配色、悬停反馈统一

### v1.3.1（2026-10-03）

- 归档账本真正只读；预算口径与报表统一；加入账本改确认页 + POST；导出上限提升；物理删除用户迁移孤儿数据；已取消订阅编辑不复活

### v1.3.0（2026-10-03）

- 修复周期账单月末锚点跳月（29-31 号规则整月漏记）与年付 2/29 漂移
- 安全：账本更新/归档越权、邀请码三洞、改密踢会话、账本接任提权
- 导入：微信「收/支 = /」行正确归入不计收支；导出 CSV 增加机读类型列，回导不再破坏类型
- 部署：镜像安装 tzdata（TZ 环境变量此前静默失效）

### v1.2.x（2026-10-03）

- 开放 API 全量能力（40+ 端点）+ 权限分层（读/写/站点管理员）+ 频控
- hermes / OpenClaw 技能包内置；部署源切换 ghcr.milu.moe；CI 加测试门禁
- 修复订阅改价被吞、AI Key 外发（SSRF）、周期账单 payload 断裂、adjust 负号翻转等

### v1.1.0（2026-10-03）

- UI/UX 全面改版：Lucide 图标、新设计体系、自定义下拉框、确认弹窗
- 安全修复：存储型 XSS×2、批量操作事务崩溃、余额调整方向反转、开放 API 越权、级联删除等

### v1.0.0（2026-09-25）

- 首个公开发布版本（源仓库）：核心记账、预算、借贷、订阅、AI 记账、开放 API、飞牛应用包

---

## 🔒 安全说明

- 所有数据存放在本机 `data/` 目录（SQLite + 截图附件），备份 = 拷贝该目录
- 开放 API 令牌只存 SHA-256 摘要，可随时吊销；权限跟随账本成员关系；写操作全量审计
- 建议仅在局域网/VPN 内暴露端口；如需公网访问，请置于反向代理之后并启用 HTTPS

## 🙏 致谢

- 原项目：[sucraft-hub/homeledger](https://github.com/sucraft-hub/homeledger)（作者 @蘇先生，应用内「关于」页保留了原署名与 AI 辅助声明）
- 图标：[Lucide](https://lucide.dev)（ISC License）

## 📄 许可

与源仓库保持一致。本 fork 的改动同样开放，欢迎 Issue/PR。
