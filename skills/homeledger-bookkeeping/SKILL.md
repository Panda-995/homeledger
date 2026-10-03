---
name: homeledger-bookkeeping
description: 家账簿（HomeLedger）自动记账。当用户发送账单截图、支付记录截图或口述消费（如"午饭花了 35"）时，调用家账簿开放 API 自动记账并汇报结果。适用于 Hermes Agent、OpenClaw / PicoClaw、Claude Code 等支持 SKILL.md（agentskills.io 标准）的 AI 助手。
---

# 家账簿自动记账技能

## 前置配置

需要两个环境变量（技能环境变量、助手配置文件或对话中告知均可）：

- `HOMELEDGER_URL`：家账簿地址，例如 `http://<NAS_IP>:5111`（NAS 局域网内可达）
- `HOMELEDGER_TOKEN`：API 令牌，在家账簿「设置 → 开放 API」中生成（`hl_` 开头）

两个变量缺一个时，先向用户询问，不要猜。

## 工作流程

### 1. 用户发来账单/支付截图

把截图转为 dataURL（`data:image/png;base64,…`），调用：

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/ai/bill" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"images":["<dataURL>"],"confirm":true}'
```

- `confirm: true` 表示识别后直接入库；若用户说"先给我看看"，改为 `confirm: false`，
  把返回的 `drafts`（每笔含 `type/txn_date/amount_cents/merchant/note`）列给用户确认后再以 `confirm: true` 重发。
- 返回 `ok: true` 时，用 `created`（笔数）和 `warnings` 向用户汇报；`errors` 非空要如实转述。

**截图会自动存档**：`confirm: true` 入库时，家账簿会把本次图片一并保存到账本附件库，
并关联到这批记录上（一图一笔则一一对应，否则整组图挂在第一笔）。
响应里的 `images` 给出对应关系：

```json
{ "ok": true, "created": 1, "ids": [128],
  "images": [{ "id": 7, "path": "/uploads/202609/1730f3a2.png", "size": 42813, "txn_id": 128 }] }
```

- 想让 `confirm: false` 的草稿调用也留档，加 `"save_images": true`（默认不留档，避免试探性调用堆积无用图片）。
- 在聊天里回执时可以附原图：把 `path` 拼到家账簿地址后面即可，如
  `http://<NAS_IP>:5111/uploads/202609/1730f3a2.png`；
  或用带令牌的接口取回（适合家账簿不对外直连的场景）：
  `GET $HOMELEDGER_URL/api/open/attachments/7` + `Authorization: Bearer $HOMELEDGER_TOKEN`。

### 2. 用户口述消费 / 粘贴账单文字

优先走 AI 识别（能自动归类）：

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/ai/bill" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"昨天午饭 35 元，打车 26.5 元","confirm":true}'
```

一条明确简单的记录也可以直接记（更稳、更快）：

```bash
curl -sS -X POST "$HOMELEDGER_URL/api/open/transactions" \
  -H "Authorization: Bearer $HOMELEDGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"expense","amount":35,"category":"餐饮","account":"微信零钱","merchant":"面馆","note":"午饭","date":"2026-09-15"}'
```

**注意**：若家账簿尚未配置 AI 模型，`/ai/bill` 会退回内置规则引擎——它只能把整段文字解析成**一笔**记录，多笔口述（如"午饭 35 打车 26.5"）会丢账。此时应：
- 把多笔文本**拆成多条**，逐条走 `/transactions` 直记；或
- 在响应 `warnings` 提示下，引导用户到「设置 → AI 记账」配置视觉模型后再用截图/整段识别。

字段说明：
- `type`：`expense` 支出 / `income` 收入 / `transfer` 转账（也接受中文"支出/收入/转账"）
- `amount`：元（小数）；`category`：分类名，如"餐饮"、"交通/打车"（父/子分类）
- `account`：支付账户名，不存在会自动创建并在响应 `accounts_created` 里提示
- `date`：`YYYY-MM-DD`，缺省为今天

### 3. 查询连通性与最近记录

```bash
# 连通性
curl -sS "$HOMELEDGER_URL/api/open/ping" -H "Authorization: Bearer $HOMELEDGER_TOKEN"

# 最近 10 笔（每笔含 images：已关联的账单截图）
curl -sS "$HOMELEDGER_URL/api/open/transactions/recent?limit=10" -H "Authorization: Bearer $HOMELEDGER_TOKEN"
```

用户问「刚才那笔记上了吗」时用 `/transactions/recent` 回答，不要凭记忆编。

## 汇报格式

记账成功后向用户简要汇报，例如：

> ✅ 已记 2 笔：餐饮/午餐 ¥35.00（微信零钱）、交通/打车 ¥26.50（微信零钱），来自截图识别。

识别失败或 AI 未配置时，把接口返回的 `error` / `warnings` **原样**转述给用户，
不要自行下结论说「模型不支持图片」——先看 `warnings` 具体是哪一种：

| `warnings` 现象 | 原因 | 让用户做什么 |
| --- | --- | --- |
| `模型返回 429：该模型当前访问量过大` | 免费视觉模型高峰限流 | 「设置 → AI 记账」点**获取可用模型**，换成列表里带 ✅ 的另一个模型并保存 |
| `模型返回 400：… type 参数非法，取值范围 ['text']` | 当前配的是纯文本模型（如 `glm-4.7-flash`） | 同上：用「获取可用模型」换成标 ✅ 可读图的模型 |
| `当前模型未开启视觉能力，无法读取截图内容` | 设置页「模型支持图片（视觉）」没勾 | 勾选后保存 |
| `尚未配置 AI 模型…` | 没配模型 | 填接口地址与 API Key → 点「获取可用模型」选一个 → 点「测试连接」 |

**「获取可用模型」**在家账簿「设置 → AI 记账」的模型名称旁边：读取该接口的模型清单，
能读图的标 ✅，选中即自动填入并联动勾选视觉开关。模型名也可以手动填写，不限于清单。
