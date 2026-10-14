'use strict'

// 插件设置：host 侧持久化（单一真相源）。
//
// 为什么需要它：
//   原先外部模型配置只存在**浏览器 localStorage**（见 client.js 的 EXT_KEY），
//   host 侧 Node 读不到、也无法在别处复用；用户反馈"配了却仍走本地"、
//   "找不到设置的地方"。现在把可配置项统一落到 host 侧的一个 JSON 文件，
//   并通过 /api/settings 读写，使：
//     · 设置与浏览器无关（换浏览器/清缓存不丢）
//     · 设置页与编译逻辑共用同一份真相源
//     · 其它插件 inject promptCompiler 时也能读到这些偏好
//
// 存储位置：~/.dsh/prompt-compiler/settings.json
//   （用 dshHomePath()，与 sdk.js 一致，避免污染 profile 目录）
// 红线不变：本文件零 @deepseek-ai 运行时 import，只用 node 内置模块。

const fs = require('node:fs')
const path = require('node:path')
const { dshHomePath } = require('./sdk')

const DIR = dshHomePath('prompt-compiler')
const FILE = path.join(DIR, 'settings.json')

// 默认值 = "什么都不配也能正常工作"的姿态。
// 每一项都对应设置页里的一个控件；新增项务必同时更新 sanitize()。
const DEFAULTS = {
  // —— ① 模型来源与优先级 ——
  external: {
    enabled: false,      // 是否启用外部模型
    priority: false,     // true=外部优先；false=宿主优先、外部兜底
    baseUrl: '',         // 端点地址
    apiKey: '',          // 密钥（仅本机文件，不入日志）
    model: '',           // 模型名
  },

  // —— ② 编译风格 / 目标模型 ——
  compile: {
    targetModel: '',     // '' = 通用 / claude / gpt / deepseek / local
    strongTemplate: true, // 是否使用强化编译提示词（真改写而非套模板）
  },

  // —— ③ 清理与格式开关 ——
  format: {
    stripHeadings: false,  // 输出去掉 ## 标题，仅留正文
    dropReasoning: true,   // 丢弃思维链（reasoning-delta）——默认开，几乎总是想要
    collapseBlank: true,   // 折叠多余空行
  },

  // —— ④ 降级与诊断可见性 ——
  diagnostics: {
    showScore: true,       // 显示诊断评分
    showModelBadge: true,  // 显示模型徽章
    showDiagMeta: true,    // 显示 chunk 数等技术细节
    warnOnDegrade: true,   // 规则降级时显示警告横幅
  },

  // —— ⑤ 默认行为 ——
  behavior: {
    autoApply: false,      // 编译完成后自动回填输入框（仍不自动发送）
    showAssumptions: true, // 显示"自动假设"清单
  },
}

/** 深合并默认值（只认识已知键，其余丢弃——避免旧版本残留字段污染）。 */
function sanitize(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {}
  const out = {}
  for (const [group, defs] of Object.entries(DEFAULTS)) {
    out[group] = {}
    const given = (src[group] && typeof src[group] === 'object') ? src[group] : {}
    for (const [k, dv] of Object.entries(defs)) {
      const v = given[k]
      if (typeof dv === 'boolean') out[group][k] = typeof v === 'boolean' ? v : dv
      else if (typeof dv === 'string') out[group][k] = typeof v === 'string' ? v : dv
      else if (typeof dv === 'number') out[group][k] = (typeof v === 'number' && Number.isFinite(v)) ? v : dv
    }
  }
  return out
}

function read() {
  try {
    const txt = fs.readFileSync(FILE, 'utf8')
    return sanitize(JSON.parse(txt))
  } catch (e) {
    // 不存在 / 损坏 / 权限问题 → 一律回默认值（绝不抛，否则插件起不来）
    return sanitize(null)
  }
}

function write(patch) {
  // 读-改-写，且必须**按分组做一层深合并**。
  //
  // 🔴 踩坑记录（2026-10-14，被 settings.test.js 的 apiKey 用例抓出来）：
  //   最初写成 `sanitize({ ...cur, ...patch })` —— 这是**浅**合并：
  //   patch.external = { model: 'x' } 会用整个 patch.external **替换** cur.external，
  //   于是同组内未被 patch 的字段（baseUrl / enabled / apiKey …）全部被 sanitize
  //   回落到默认值 ⇒ 用户"只改一个字段"却把同组其它配置清空了。
  //   实测：write({external:{model:'other'}}) 后 enabled 变 false、baseUrl 变 ''。
  //   正确做法：逐组合并 cur[group] 与 patch[group]，只让显式给出的键生效。
  const cur = read()
  const merged = sanitize(cur)   // 归一化基线（含默认值）
  if (patch && typeof patch === 'object') {
    for (const group of Object.keys(DEFAULTS)) {
      const given = patch[group]
      if (!given || typeof given !== 'object') continue
      merged[group] = { ...merged[group], ...given }
    }
  }
  const next = sanitize(merged)
  try {
    fs.mkdirSync(DIR, { recursive: true })
    // 先写临时文件再原子重命名，避免半截文件（崩溃/并发写）
    const tmp = FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, FILE)
    return { ok: true, settings: next }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), settings: cur }
  }
}

/** 给 UI 用的安全视图：apiKey 不回传明文，只回传"是否已设置"。 */
function view() {
  const s = read()
  return {
    ...s,
    external: {
      ...s.external,
      apiKey: '',                       // 永不回传明文
      apiKeySet: !!(s.external.apiKey), // 只告诉 UI "已配置"
    },
    _path: FILE,
  }
}

/**
 * 处理来自 UI 的写入补丁。
 *
 * 关键约定：`external.apiKey === ''` 表示「用户没改密钥」（因为 view() 从不回传明文，
 * 表单里该字段天然为空）——此时必须**保留磁盘上的原值**，否则每次保存其它设置都会
 * 把密钥清空。这是很容易写错的一处，故单独抽出来并加测试。
 *
 * @param {object} patch 来自设置页/快捷卡的分组补丁
 * @returns {{ok:boolean, settings?:object, error?:string}}
 */
function applyUiPatch(patch) {
  const p = patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : {}
  if (p.external && typeof p.external === 'object' && p.external.apiKey === '') {
    delete p.external.apiKey   // 空串 = 不改动，交由 write() 的合并保留原值
  }
  return write(p)
}

module.exports = { DEFAULTS, read, write, view, sanitize, applyUiPatch, FILE }
