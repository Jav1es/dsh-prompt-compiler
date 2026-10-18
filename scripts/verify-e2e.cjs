'use strict'

// H1 分层验收 —— e2e 层（verify:e2e）。
//
// ⚠️ 这一层的诚实边界（必须写清楚，否则等于自欺）：
//   真实宿主（Electron + DSH 0.2.0-rc.2）的 webServer 路由**需要鉴权**，
//   实测 `POST /__dsh-prompt-compiler/api/analyze` 在未带凭据时返回 401 / 超时。
//   ⇒ 本脚本**不假装能替你在浏览器里点一遍**；它做的是「宿主侧链路」端到端：
//     从插件入口 apply(ctx) → provide 服务 → 注册工具/路由 → 实际调用，
//     全部在真实 Node 进程里跑真实代码，只是不经过网络与 UI。
//
// 三层各自回答什么：
//   verify:static —— 仓库形态自洽吗（装上去会不会缺文件/版本错/踩红线）
//   verify:unit   —— 每个模块对不对（tests/*.test.js）
//   verify:e2e    —— 插件装进宿主后，服务与工具**真的能用吗**
//
// 若将来拿到宿主鉴权凭据，可加 `PC_E2E_URL` + `PC_E2E_TOKEN` 环境变量跑真网络层；
// 未提供时明确打印「跳过」，**退出码仍为 0 但绝不打印通过**。

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const ROOT = path.resolve(__dirname, '..')
const results = []
function pass(name, detail) {
  results.push({ name, status: 'pass', detail })
}
function fail(name, detail) {
  results.push({ name, status: 'fail', detail })
}
function skip(name, detail) {
  results.push({ name, status: 'skip', detail })
}

// 复刻宿主最小契约：apply(ctx, config) 里需要的 ctx 能力。
// 参照 tests/index.test.js 里已验证可用的 stub。
function makeCtx() {
  const provided = {}
  const tools = []
  const routes = []
  const sections = []
  const ctx = {
    provide(name, value) {
      provided[name] = value
    },
    tools: {
      register(t) {
        tools.push(t)
      },
    },
    // 插件在 apply 里调用 ctx.systemPrompt.section({name, order, text}) 注入系统提示片段。
    // 首版桩漏了这个（inject 声明了 'systemPrompt' 就必须提供），
    // 导致 e2e 直接挂在 "Cannot read properties of undefined (reading 'section')"。
    systemPrompt: {
      section(sec) {
        sections.push(sec)
        return () => {}
      },
    },
    webServer: {
      register(prefix, handler) {
        routes.push({ prefix, handler })
      },
    },
    effect(fn) {
      if (fn) fn()
    },
    on() {},
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get(name) {
      return provided[name]
    },
  }
  return { ctx, provided, tools, routes, sections }
}

async function main() {
  const pluginPath = path.join(ROOT, 'lib', 'index.js')
  if (!fs.existsSync(pluginPath)) {
    fail('插件入口存在', 'lib/index.js 缺失')
    return finish()
  }
  const plugin = require(pluginPath)

  // ① 插件形态符合 DSH 约定（export name / inject / apply，函数形态）
  if (typeof plugin.name === 'string' && plugin.name) pass('导出 name', plugin.name)
  else fail('导出 name', '缺 name，DSH 无法识别插件')

  if (Array.isArray(plugin.inject)) pass('导出 inject', plugin.inject.join(', ') || '(空)')
  else fail('导出 inject', 'inject 必须是数组')

  if (typeof plugin.apply === 'function') pass('导出 apply（函数形态）', 'ok')
  else fail('导出 apply', `apply 不是函数（实得 ${typeof plugin.apply}），DSH 不会激活插件`)

  // ② 真实 apply：服务被 provide、工具被注册、路由被挂载
  const { ctx, provided, tools, routes, sections } = makeCtx()
  try {
    await plugin.apply(ctx, {})
    pass('apply 不抛错', 'ok')
  } catch (e) {
    fail('apply 不抛错', e && e.message)
    return finish()
  }

  if (provided.promptCompiler) pass('服务已 provide', 'ctx.promptCompiler')
  else fail('服务已 provide', '未 provide promptCompiler，其它插件无法 inject')

  const svc = provided.promptCompiler
  const wantTools = ['prompt_compile', 'prompt_template']
  for (const t of wantTools) {
    const hit = tools.find(x => x.name === t)
    if (hit) pass(`工具已注册：${t}`, typeof hit.execute === 'function' ? 'execute ok' : '缺 execute')
    else fail(`工具已注册：${t}`, `未注册，已注册的是：${tools.map(x => x.name).join(', ')}`)
  }

  if (routes.length > 0) pass('webServer 路由已挂载', routes.map(r => r.prefix).join(', '))
  else fail('webServer 路由已挂载', '没有挂载任何路由，前端 UI 将无法工作')

  // ③ 端到端真实调用：analyze / compile / render 三条主链
  if (svc) {
    try {
      const a = await svc.analyze('帮我写个爬虫')
      if (typeof a.score === 'number' && a.score5d && typeof a.score5d.total === 'number') {
        pass('E2E analyze', `score=${a.score} score5d=${a.score5d.total}`)
      } else {
        fail('E2E analyze', `返回体缺字段：${JSON.stringify(Object.keys(a || {}))}`)
      }
    } catch (e) {
      fail('E2E analyze', e && e.message)
    }

    try {
      const c = await svc.compile('帮我写个爬虫')
      if (typeof c.compiled === 'string' && c.compiled.length > 0 && c.scoreDelta) {
        pass('E2E compile', `degraded=${c.degraded} delta=${c.scoreDelta.total.delta}`)
      } else {
        fail('E2E compile', 'compile 返回体缺 compiled 或 scoreDelta')
      }
    } catch (e) {
      fail('E2E compile', e && e.message)
    }

    try {
      const r = svc.render('portfolio-review', { siteUrl: 'https://x.dev', targetRoles: ['A'] })
      if (r && r.ok === true) pass('E2E render（模板）', 'ok')
      else fail('E2E render（模板）', `render 失败：${JSON.stringify(r && r.errors)}`)
    } catch (e) {
      fail('E2E render（模板）', e && e.message)
    }
  }

  // ④ 工具真的能执行（不只是注册了）
  const compileTool = tools.find(t => t.name === 'prompt_compile')
  if (compileTool && typeof compileTool.execute === 'function') {
    try {
      const out = await compileTool.execute({ draft: '帮我写个爬虫' })
      // defineTool 的 render 可能返回块数组或字符串，这里只要求"非空"
      const text = typeof out === 'string' ? out : JSON.stringify(out)
      if (text && text.length > 0) pass('E2E 工具执行', 'prompt_compile 返回非空')
      else fail('E2E 工具执行', 'prompt_compile 返回空')
    } catch (e) {
      fail('E2E 工具执行', e && e.message)
    }
  }

  // ⑤ 提示词守门：系统提示里提到的工具名 ↔ 真实注册表必须**双向一致**
  //
  // 为什么这条重要：提示词是这个插件唯一"教模型怎么用工具"的入口。
  //   - 提示词提到但没注册 → 模型会去调一个不存在的工具，直接报错；
  //   - 注册了但提示词没提 → 模型不知道它存在，能力白做。
  //   这两种都是**静态检查看不出来**的（工具代码和提示词各行其是，各自都对）。
  ;(function checkPromptGate() {
    const name = '提示词守门：提示词与工具注册表一致'
    const sec = sections.find(s => s && s.name === 'dsh-prompt-compiler')
    if (!sec) return fail(name, '系统提示 section 未注入（apply 里没调 ctx.systemPrompt.section）')
    const text = String(sec.text || '')
    if (!text.trim()) return fail(name, '系统提示 section 文本为空')

    // 哪些工具是"给模型用的"：排除内部探针/排障工具。
    // 判据来自工具自己的 description（写明"内部"），不是硬编码名单 ——
    // 这样新加的内部工具只要如实描述就自动豁免，不必回来改这里。
    const isInternal = t => /内部|internal|探针|probe|排障|debug/i.test(String(t.description || ''))
    const modelTools = tools.filter(t => t.name && !isInternal(t))
    const internalTools = tools.filter(t => t.name && isInternal(t))

    const registered = new Set(modelTools.map(t => t.name))
    // 从提示词里抽出所有形如 xxx_yyy 的工具名（本项目工具都是下划线命名）
    const mentioned = new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [])
    const KNOWN_NON_TOOLS = new Set(['source', 'kind', 'plugin'])
    const mentionedTools = [...mentioned].filter(w => !KNOWN_NON_TOOLS.has(w))

    const ghost = mentionedTools.filter(w => !registered.has(w))
    if (ghost.length) {
      return fail(name, `提示词提到但未注册（或属内部工具）的工具：${ghost.join(', ')}（模型会调用不存在的工具）`)
    }

    const undocumented = [...registered].filter(t => !mentioned.has(t))
    if (undocumented.length) {
      return fail(name, `已注册但提示词没交代的工具：${undocumented.join(', ')}（模型不知道它存在）`)
    }

    pass(
      name,
      `双向一致：${[...registered].join(', ')}${internalTools.length ? `；内部工具豁免：${internalTools.map(t => t.name).join(', ')}` : ''}`
    )
  })()

  // ⑤ 真网络层：有凭据才跑，没有就明确跳过
  const url = process.env.PC_E2E_URL
  const token = process.env.PC_E2E_TOKEN
  if (url) {
    await probeHttp(url, token)
  } else {
    skip('真宿主 HTTP 链路', '未提供 PC_E2E_URL（宿主路由需鉴权），跳过而非假装通过')
  }

  return finish()
}

function probeHttp(url, token) {
  const name = `真宿主 HTTP 链路 ${url}`
  return new Promise(resolve => {
    try {
      const u = new URL('/__dsh-prompt-compiler/api/analyze', url)
      const body = JSON.stringify({ draft: '帮我写个爬虫' })
      const req = http.request(
        u,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          timeout: 15000,
        },
        res => {
          let data = ''
          res.on('data', d => (data += d))
          res.on('end', () => {
            if (res.statusCode === 200 && data.includes('score5d')) pass(name, 'ok')
            else fail(name, `HTTP ${res.statusCode}：${data.slice(0, 200)}`)
            resolve()
          })
        }
      )
      req.on('timeout', () => {
        req.destroy()
        fail(name, '超时')
        resolve()
      })
      req.on('error', e => {
        fail(name, e.message)
        resolve()
      })
      req.end(body)
    } catch (e) {
      fail(name, e && e.message)
      resolve()
    }
  })
}

function finish() {
  const isJSON = process.argv.includes('--json')
  const failures = results.filter(r => r.status === 'fail')
  const skipped = results.filter(r => r.status === 'skip')
  if (isJSON) {
    process.stdout.write(JSON.stringify({ layer: 'e2e', results }, null, 2) + '\n')
  } else {
    console.log('\n=== verify:e2e ===\n')
    for (const r of results) {
      const mark = r.status === 'pass' ? '✔' : r.status === 'fail' ? '✖' : '○'
      console.log(`${mark} ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
    }
    if (skipped.length) {
      console.log(`\n○ ${skipped.length} 项跳过（这些**没有**被验证，不要当成通过）`)
    }
    console.log('')
  }
  process.exit(failures.length ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
