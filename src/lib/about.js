'use strict';
/**
 * 「关于」页静态数据与反馈配置
 *
 * GITHUB_REPO：功能需求提交跳转的仓库地址。
 *   - 当前已配置；更换仓库时改这里即可（环境变量 HOMELEDGER_GITHUB_REPO 优先）。
 *   - 留空时，关于页的反馈按钮会置灰并提示「仓库暂未配置」，
 *     页面其余内容不受影响。
 */
const GITHUB_REPO = 'https://github.com/sucraft-hub/homeledger';

const APP = {
  name: '家账簿 HomeLedger',
  slogan: '为家庭打造的轻量自托管记账系统',
  description:
    '纯后端 SSR 架构，数据 100% 存放在你自己的 NAS / 服务器上。' +
    '支持文字与截图 AI 自动记账、订阅扣费管理、预算与储蓄目标、开放 API 对接，' +
    '零原生依赖，单进程即可运行。',
  author: '蘇先生',
  aiNote: '本项目的部分代码与文档由 AI 辅助生成。',
};

/** 功能亮点（关于页卡片） */
const FEATURES = [
  { ico: '🤖', title: 'AI 智能记账', desc: '发一句「午饭 35 元」或一张账单截图，自动识别并入库' },
  { ico: '🧾', title: '订阅扣费', desc: '管理软件/网站的每月自动扣费，月均与年化成本一目了然' },
  { ico: '🎯', title: '预算与目标', desc: '分类预算超支预警，储蓄目标进度可视' },
  { ico: '🤝', title: '借贷台账', desc: '人情往来、借入借出，到期自动提醒' },
  { ico: '📥', title: '账单导入', desc: '支持微信、支付宝账单 CSV 一键导入并自动分类' },
  { ico: '🔌', title: '开放 API', desc: '令牌鉴权的 REST API，小龙虾 / 脚本 / 自动化随手接' },
];

/**
 * 版本更新日志（倒序）。发布新版本时在数组头部加一条即可，
 * 关于页与未来的「检查更新」都读这里。
 */
const CHANGELOG = [
  {
    version: '1.2.2',
    date: '2026-10-03',
    tag: '当前版本',
    items: [
      'UI 全面改版：Lucide 线条图标、全新设计体系（浅色/深色）、桌面端自定义下拉框与确认弹窗',
      '开放 API 全量开放：交易增删改查与批量、账户/分类/标签/借贷/预算/目标/订阅/周期账单、站点与 AI 设置',
      '权限收紧：令牌跟随成员关系、读写角色分层、每令牌频控、AI 密钥永不外发',
      '订阅管理页外链白名单（阻断 javascript: 存储型 XSS）；图表颜色渲染下沉白名单校验',
      '修复：余额调整方向、批量删除/报销事务、备份快照一致性、周期账单自动记账失效、订阅改价被吞等',
      '部署：镜像构建加测试门禁、依赖锁定可复现、fpk 打包修复',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-25',
    tag: '',
    items: [
      '首个公开发布版本：核心记账、预算与储蓄目标、借贷台账、账单导入',
      '订阅扣费管理：周期扣费自动生成流水，月均/年化成本统计与到期提醒',
      'AI 记账助手：站内文字/截图自动记账，规则引擎兜底，模型可自由切换',
      '开放 API：令牌鉴权 REST 接口，支持小龙虾 / 脚本 / 自动化接入',
      '顶栏用户菜单：头像上传与用户名修改，审计日志中文化',
      '「关于」页：产品介绍、功能亮点、版本日志、隐私声明一站呈现',
      '飞牛 fnOS fpk 应用包，桌面内嵌运行',
    ],
  },
];

/** 技术栈（关于页展示） */
const TECH = [
  { name: 'Node.js ≥ 22', desc: '零原生依赖，纯 JS 单进程' },
  { name: 'SQLite', desc: 'node:sqlite 内置驱动，数据自持' },
  { name: 'EJS SSR', desc: '服务端渲染，低带宽也流畅' },
  { name: '飞牛 fnOS', desc: 'fpk 应用包，桌面内嵌运行' },
];

/**
 * 仓库地址：环境变量 HOMELEDGER_GITHUB_REPO 优先，其次下方 GITHUB_REPO。
 * 运行时读取，便于测试与不同环境覆盖。
 */
function repoUrl() {
  const repo = String(process.env.HOMELEDGER_GITHUB_REPO || GITHUB_REPO || '').trim();
  return repo.replace(/\/+$/, '');
}

/** GitHub Issues 入口（未配置仓库时返回 null，由页面降级展示） */
function issuesUrl() {
  const repo = repoUrl();
  if (!repo || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return repo + '/issues';
}

module.exports = { APP, FEATURES, CHANGELOG, TECH, GITHUB_REPO, repoUrl, issuesUrl };
