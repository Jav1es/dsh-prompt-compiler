'use strict'

// B2 + C2: 插件 host 半（函数形态，CommonJS，无 default export）
// 零 @deepseek-ai 运行时 import —— defineTool 取自本项目自带 lib/sdk.js；
// 服务用 lib/service.js 的工厂函数创建，由宿主 ctx.provide 注册（避免双实例）。
const { defineTool } = require('./sdk')
const { createPromptCompiler } = require('./service')

exports.name = 'prompt-compiler'
// ⚠️ 必须 inject 'llm'：Cordis 注入安全模型——ctx 上只有 inject 了的服务才可用。
// 漏了 'llm' 会导致 apply 时 ctx.llm 为 undefined，服务内 callLLM 直接降级规则
// （E4 实调踩坑：probe 返回规则输出、无 LLM 推理）。llm 是 dsh-base 注册的可注入服务。
exports.inject = ['tools', 'systemPrompt', 'llm', 'webServer']

exports.apply = function (ctx, config) {
  // C2 + E 组：注册服务（可编程层核心）。
  // ⚠️ 不用 `extends Service`（会 require cordis 形成双实例 → 注册失效）；
  // 改用宿主传入的 ctx.provide('promptCompiler', instance) —— provide 操作的是宿主
  // ctx 的 store，消费方 inject:['promptCompiler'] 后即可 ctx.promptCompiler 拿到。
  // E 组：把 apply 的 ctx 传入工厂，供内部取 ctx.llm（缺失则降级规则）。
  const promptCompiler = createPromptCompiler(ctx)
  ctx.provide('promptCompiler', promptCompiler)

  // B3: 注册工具 prompt_compile —— 工具内部消费闭包持有的服务实例（C3 部分证据）。
  // E 组：analyze/compile 已升级为 LLM 驱动（带规则降级），elicit 保留规则，对工具透明。
  ctx.tools.register(
    defineTool({
      name: 'prompt_compile',
      description: '把粗糙 draft 编译成结构化 prompt（合成阶段）',
      parameters: {
        draft: { type: 'string', required: true, description: '用户原始 draft' },
      },
      output: {
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const draft = (args.draft || '').trim()
        const { compiled } = await promptCompiler.compile(draft, {})
        return compiled
      },
    })
  )

  // C3 证据工具：证明服务可编程、三段结果可被调用方解析。
  // 走闭包持有的实例；同时本服务已 provide 到 ctx，任何其他插件 inject:['promptCompiler']
  // 即可复用（这是"可编程的 prompt 编译层"定位的硬证据）。
  ctx.tools.register(
    defineTool({
      name: 'prompt_compiler_probe',
      description: '内部探针：依次调用 promptCompiler.analyze/elicit/compile，返回结构化 JSON 证据。',
      parameters: {
        draft: { type: 'string', required: true, description: '用户原始 draft' },
      },
      output: {
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const draft = (args.draft || '').trim()
        const analysis = await promptCompiler.analyze(draft)
        const elicitation = await promptCompiler.elicit(draft)
        const { compiled, assumptions } = await promptCompiler.compile(draft, {})
        const payload = {
          analysis,
          elicitation,
          compile: { compiled, assumptions },
        }
        return JSON.stringify(payload, null, 2)
      },
    })
  )

  // B4: 注册提示词 section（静态说明，无未定义花括号占位）
  ctx.systemPrompt.section({
    name: 'dsh-prompt-compiler',
    order: 100,
    text: '你有一个 prompt_compile 工具可用：当用户给出粗糙、含糊或缺少约束的指令时，可以建议用户调用 prompt_compile 把 draft 编译成结构化、可执行的 prompt。底层由可编程的 promptCompiler 服务提供（analyze/elicit/compile）。',
  })

  // D4: 浏览器侧 UI 完整链路——注册 webServer 路由（前缀 /__dsh-prompt-compiler）。
  // 闭包持有 promptCompiler（apply 内创建），不重新 require、不 import cordis。
  // 原生 Node HTTP：自行读 body（1MB 限长），异常统一 400 兜底。
  const MAX_BODY = 1024 * 1024

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) throw new Error('请求体超过 1MB 限制')
      chunks.push(c)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }

  async function handle(req, res) {
    const url = (req.url || '').split('?')[0].split('#')[0]
    const ok = (payload) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
    }
    const fail = (status, error) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: String(error) }))
    }
    // 仅接受三种 API path（其余 404）。
    const routes = {
      '/__dsh-prompt-compiler/api/analyze': async (body) => {
        const analysis = await promptCompiler.analyze((body.draft || '').trim())
        return { analysis }
      },
      '/__dsh-prompt-compiler/api/elicit': async (body) => {
        const { questions } = await promptCompiler.elicit((body.draft || '').trim())
        return { questions }
      },
      '/__dsh-prompt-compiler/api/compile': async (body) => {
        const draft = (body.draft || '').trim()
        const options = { answers: body.answers && typeof body.answers === 'object' ? body.answers : {} }
        // 跨模型适配（审计：targetModel 可选，默认 model-agnostic markdown）
        if (typeof body.targetModel === 'string' && body.targetModel) options.targetModel = body.targetModel
        const { compiled, assumptions, polished, degraded, diag } = await promptCompiler.compile(draft, options)
        return { compiled, assumptions, polished, degraded, diag }
      },
    }
    const route = routes[url]
    if (!route || req.method !== 'POST') return fail(404, 'not found')
    try {
      const body = await readJsonBody(req)
      const payload = await route(body)
      ok(payload)
    } catch (e) {
      fail(400, e && e.message ? e.message : e)
    }
  }

  ctx.webServer.register({ kind: 'prefix', path: '/__dsh-prompt-compiler', handler: handle })
}
