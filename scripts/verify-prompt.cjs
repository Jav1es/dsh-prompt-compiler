'use strict'

// H1 分层验收 —— 提示词层（verify:prompt）。
//
// ⚠️ 这一层为什么必须独立存在（不能塞在 e2e 里当一条子项）：
//   系统提示与工具注册表是**两处独立维护**的东西 —— 工具代码在 lib/index.js，
//   提示词文本也在 lib/index.js 但隔了几十行。它们各自都对，合起来却是错的：
//     · 提示词里写了 prompt_xxx，但工具没注册 → 模型会去调用一个不存在的工具
//     · 工具注册了，但提示词没提 → 模型不知道它存在，等于没装
//   这两种错**单测看不出来**（单测只测工具本身）、**e2e 主体也看不出来**
//   （服务能跑、路由能通，只是模型永远用不上它）。
//   ⇒ 只有"把两边拉在一起逐项比对"这一种检查能抓到，所以给它单独一层。
//
// 判据不写死名单：工具是不是"给模型用的"，看它自己的 description
// 是否自述为内部工具（"内部 / 探针 / probe"）。这样新加的内部工具只要如实
// 描述就自动豁免，不需要回来改脚本；而**如实描述**本身也是可审的。

const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const results = []
const pass = (name, detail) => results.push({ name, status: 'pass', detail })
const fail = (name, detail) => results.push({ name, status: 'fail', detail })
const skip = (name, detail) => results.push({ name, status: 'skip', detail })

/** 复刻宿主最小契约（只需 systemPrompt / tools 两个能力）。 */
function makeCtx() {
  const provided = {}
  const tools = []
  const sections = []
  const ctx = {
    provide(n, v) {
      provided[n] = v
    },
    tools: {
      register(t) {
        tools.push(t)
      },
    },
    systemPrompt: {
      section(sec) {
        sections.push(sec)
        return () => {}
      },
    },
    webServer: {
      register() {
        return () => {}
      },
    },
    effect(fn) {
      if (fn) fn()
    },
    on() {},
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get: n => provided[n],
  }
  return { ctx, tools, sections }
}

function main() {
  const pluginPath = path.join(ROOT, 'lib', 'index.js')
  const plugin = require(pluginPath)
  const { ctx, tools, sections } = makeCtx()

  // 注入声明检查：systemPrompt / tools 必须在 inject 里，否则 apply 时拿不到。
  const inject = Array.isArray(plugin.inject) ? plugin.inject : []
  const missingInject = ['tools', 'systemPrompt'].filter(s => !inject.includes(s))
  if (missingInject.length) {
    fail('inject 声明完整', `缺 ${missingInject.join(', ')} —— apply 时 ctx.<服务> 会是 undefined`)
  } else {
    pass('inject 声明完整', inject.join(', '))
  }

  try {
    plugin.apply(ctx, {})
  } catch (e) {
    fail('插件可激活', `apply 抛错：${e && e.message}`)
    return finish()
  }
  pass('插件可激活', 'apply 未抛错')

  const sec = sections.find(s => s && s.name === 'dsh-prompt-compiler')
  if (!sec) {
    fail('系统提示已注入', 'apply 里没有调 ctx.systemPrompt.section({name:"dsh-prompt-compiler"})')
    return finish()
  }
  const text = String(sec.text || '')
  if (!text.trim()) {
    fail('系统提示非空', 'section 文本为空 —— 等于没写提示词')
    return finish()
  }
  pass('系统提示非空', `${text.length} 字`)

  // 与 e2e 同一条判据：自述为内部工具的不算"给模型用的"。
  const isInternal = t => /内部|internal|探针|probe|排障|debug/i.test(String(t.description || ''))
  const modelTools = tools.filter(t => t.name && !isInternal(t))
  const internalTools = tools.filter(t => t.name && isInternal(t))

  if (modelTools.length === 0) {
    fail('存在给模型用的工具', '一个都没有 —— 提示词里的工具说明无从谈起')
    return finish()
  }

  const registered = new Set(modelTools.map(t => t.name))
  const mentioned = new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [])
  // 提示词里可能出现的非工具 snake_case 词（事件名、字段名），显式列出来而不是放宽正则。
  const KNOWN_NON_TOOLS = new Set(['source', 'kind', 'plugin'])
  const mentionedTools = [...mentioned].filter(w => !KNOWN_NON_TOOLS.has(w))

  const ghost = mentionedTools.filter(w => !registered.has(w))
  const undocumented = [...registered].filter(t => !mentioned.has(t))

  if (ghost.length) {
    fail(
      '反向：提示词提到的工具都已注册',
      `${ghost.join(', ')} —— 模型会去调用一个不存在的工具`
    )
  } else {
    pass('反向：提示词提到的工具都已注册', `${mentionedTools.length} 个全部命中`)
  }

  if (undocumented.length) {
    fail(
      '正向：已注册的工具都被提示词交代',
      `${undocumented.join(', ')} —— 模型不知道它存在，等于没装`
    )
  } else {
    pass(
      '正向：已注册的工具都被提示词交代',
      [...registered].join(', ') +
        (internalTools.length ? `（内部工具豁免：${internalTools.map(t => t.name).join(', ')}）` : '')
    )
  }

  return finish()
}

function finish() {
  const fails = results.filter(r => r.status === 'fail')
  const skips = results.filter(r => r.status === 'skip')
  for (const r of results) {
    const icon = r.status === 'pass' ? '✔' : r.status === 'skip' ? '○' : '✖'
    console.log(`${icon} ${r.name}  (${r.detail})`)
  }
  console.log()
  if (fails.length) {
    console.log(`✖ ${fails.length} 项失败`)
    process.exitCode = 1
  } else if (skips.length) {
    console.log(`○ ${skips.length} 项跳过（这些**没有**被验证，不要当成通过）`)
  } else {
    console.log('✔ verify:prompt 全部通过')
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ results }, null, 2))
  }
}

main()
