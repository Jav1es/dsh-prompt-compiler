'use strict'

// host 半的注册与路由测试（lib/index.js）。
//
// 此前 host 的**工具注册与 HTTP 路由完全没有测试覆盖**，只有 client 半有渲染冒烟。
// 这里用一个 stub ctx 真实执行 apply()，把注册结果与路由行为钉住：
//   · 三个工具都注册了，且 prompt_template 能"先列模板、再渲染、失败回结构化错误"
//   · /api/templates 与 /api/render 返回 JSON
//   · 缺必填 → **400 + error 字段**（可读原因），不是 500
//   · 沿用 readJsonBody 的 1MB 限长与 400 兜底
//
// 注：这里刻意不提供 ctx.llm —— 模板渲染路径本就不该依赖模型。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 隔离 DSH_HOME，避免碰到真实用户配置
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-index-test-'))

const plugin = require('../lib/index.js')

/** 最小 stub ctx：只实现 index.js 实际用到的那几个接口。 */
function makeCtx() {
  const registered = { tools: [], sections: [], routes: [], provided: {} }
  const ctx = {
    tools: { register: (t) => registered.tools.push(t) },
    systemPrompt: { section: (s) => registered.sections.push(s) },
    webServer: { register: (r) => registered.routes.push(r) },
    provide(name, inst) { registered.provided[name] = inst; ctx[name] = inst },
  }
  return { ctx, registered }
}

/** 造一个可被 `for await` 消费的假 req。 */
function fakeReq(url, bodyObj) {
  const buf = bodyObj === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyObj), 'utf8')
  return {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      if (buf.length) yield buf
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    end(s) { this.body = s },
  }
}

/** 跑一次路由，返回 { status, json }。 */
async function callRoute(handler, url, bodyObj) {
  const res = fakeRes()
  await handler(fakeReq(url, bodyObj), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON 时留 null */ }
  return { status: res.statusCode, json, raw: res.body }
}

const { ctx, registered } = makeCtx()
plugin.apply(ctx, {})

// ---------------------------------------------------------------- 注册

test('apply: 注册三个工具，且注入的服务可用', () => {
  const names = registered.tools.map(t => t.name).sort()
  assert.deepEqual(names, ['prompt_compile', 'prompt_compiler_probe', 'prompt_template'])
  assert.ok(registered.sections.length >= 1, '应注册 systemPrompt section')
  assert.equal(registered.routes.length, 1, '应注册一个 webServer 前缀路由')
  assert.equal(registered.routes[0].kind, 'prefix')
  assert.equal(registered.routes[0].path, '/__dsh-prompt-compiler')
  assert.ok(registered.provided.promptCompiler, '应通过 ctx.provide 暴露 promptCompiler')
})

test('apply: systemPrompt section 文本不含未转义花括号（否则整个会话提示词装配会失败）', () => {
  for (const s of registered.sections) {
    assert.ok(!/\{\{/.test(s.text), `section「${s.name}」含 {{ —— 必须转义`)
  }
})

test('prompt_template: 不传 template 时列出可用模板', async () => {
  const tool = registered.tools.find(t => t.name === 'prompt_template')
  const out = JSON.parse(await tool.execute({}))
  assert.ok(Array.isArray(out.templates))
  assert.ok(out.templates.some(t => t.id === 'portfolio-review'))
  assert.equal(out.templates[0].template, undefined, '列表不得含模板正文')
})

test('prompt_template: 传 template + variables 时返回渲染后的 prompt 正文', async () => {
  const tool = registered.tools.find(t => t.name === 'prompt_template')
  const out = await tool.execute({
    template: 'portfolio-review',
    variables: { siteUrl: 'https://x.dev/', targetRoles: ['AI Agent 工程师'] },
  })
  assert.equal(typeof out, 'string')
  assert.match(out, /https:\/\/x\.dev\//)
  assert.match(out, /AI Agent 工程师/)
  assert.match(out, /# 角色/)
})

test('prompt_template: 渲染失败回结构化错误而不抛（模型可据此自我修正）', async () => {
  const tool = registered.tools.find(t => t.name === 'prompt_template')

  const badId = JSON.parse(await tool.execute({ template: 'no-such' }))
  assert.equal(badId.ok, false)
  assert.ok(badId.errors.some(e => e.includes('未找到模板')))
  assert.ok(Array.isArray(badId.available))

  const missingVar = JSON.parse(await tool.execute({ template: 'portfolio-review', variables: {} }))
  assert.equal(missingVar.ok, false)
  assert.ok(missingVar.errors.some(e => e.includes('siteUrl')))
})

// ---------------------------------------------------------------- 路由

test('路由 /api/templates: 返回 200 + JSON 模板清单', async () => {
  const handler = registered.routes[0].handler
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/templates', {})
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.json.templates))
  assert.ok(r.json.templates.some(t => t.id === 'portfolio-review'))
})

test('路由 /api/render: 正常输入返回 200 + 渲染结果', async () => {
  const handler = registered.routes[0].handler
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/render', {
    template: 'portfolio-review',
    variables: { siteUrl: 'https://y.dev/', targetRoles: ['FDE'] },
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.id, 'portfolio-review')
  assert.match(r.json.text, /https:\/\/y\.dev\//)
})

test('路由 /api/render: 缺必填 → 400 + error 字段（不是 500，也不是静默成功）', async () => {
  const handler = registered.routes[0].handler
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/render', {
    template: 'portfolio-review',
    variables: {},
  })
  assert.equal(r.status, 400)
  assert.ok(typeof r.json.error === 'string')
  assert.match(r.json.error, /siteUrl/)
})

test('路由 /api/render: 未知模板 → 400 且提示可用模板', async () => {
  const handler = registered.routes[0].handler
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/render', { template: 'nope' })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /未找到模板/)
  assert.match(r.json.error, /portfolio-review/)
})

test('路由: 未知路径 / 非 POST 一律 404（不泄漏内部信息）', async () => {
  const handler = registered.routes[0].handler
  const unknown = await callRoute(handler, '/__dsh-prompt-compiler/api/nope', {})
  assert.equal(unknown.status, 404)

  const res = fakeRes()
  await handler({ method: 'GET', url: '/__dsh-prompt-compiler/api/templates' }, res)
  assert.equal(res.statusCode, 404, '非 POST 应 404')
})

test('路由: 超过 1MB 的请求体 → 400（沿用 readJsonBody 限长）', async () => {
  const handler = registered.routes[0].handler
  const huge = { template: 'x', variables: { pad: 'a'.repeat(1024 * 1024 + 100) } }
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/render', huge)
  assert.equal(r.status, 400)
  assert.match(r.json.error, /1MB|超过/)
})

test('路由: 非法 JSON → 400 而不是把进程带崩', async () => {
  const handler = registered.routes[0].handler
  const res = fakeRes()
  await handler({
    method: 'POST',
    url: '/__dsh-prompt-compiler/api/render',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{ not json', 'utf8') },
  }, res)
  assert.equal(res.statusCode, 400)
})

// —— E2：交互式澄清路由 ——
// 关键不变量：**没有 userQuestions 的宿主上，这个端点也必须立刻返回**，
// 不能挂着等 60 秒把前端吊死（agentless 是本插件的常态环境）。

test('路由 E2 · 无 userQuestions 时 elicit-interactive 立即返回问题列表（不阻塞）', async () => {
  const handler = registered.routes[0].handler
  const started = Date.now()
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/elicit-interactive', {
    draft: '帮我写个爬虫',
  })
  const elapsed = Date.now() - started
  assert.equal(r.status, 200)
  assert.equal(r.json.asked, false)
  assert.equal(r.json.reason, 'no_user_questions')
  assert.ok(Array.isArray(r.json.questions) && r.json.questions.length >= 1, '应回问题列表供 UI 自行渲染')
  assert.ok(elapsed < 5000, `耗时 ${elapsed}ms —— 无 provider 时不该阻塞`)
})

test('路由 E2 · draft 已经够清楚时返回空问题列表', async () => {
  const handler = registered.routes[0].handler
  const rich =
    '目标：抓取 news.example.com 首页标题。约束：仅用 requests，超时 10 秒。' +
    '输出格式：每行 JSON。验收标准：连续跑 3 天每天至少 20 条。'
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/elicit-interactive', { draft: rich })
  assert.equal(r.status, 200)
  assert.equal(r.json.asked, false)
  assert.equal(r.json.reason, 'no_questions')
  assert.equal(r.json.questions.length, 0)
})

test('路由 E2 · timeoutMs 被夹到上限（防止前端传巨大值把请求挂死）', async () => {
  const handler = registered.routes[0].handler
  const r = await callRoute(handler, '/__dsh-prompt-compiler/api/elicit-interactive', {
    draft: '帮我写个爬虫',
    timeoutMs: 999999999,
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.reason, 'no_user_questions')
})
