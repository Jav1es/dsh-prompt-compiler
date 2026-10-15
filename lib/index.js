'use strict'

// B2 + C2: 插件 host 半（函数形态，CommonJS，无 default export）
// 零 @deepseek-ai 运行时 import —— defineTool 取自本项目自带 lib/sdk.js；
// 服务用 lib/service.js 的工厂函数创建，由宿主 ctx.provide 注册（避免双实例）。
const { defineTool } = require('./sdk')
const { createPromptCompiler } = require('./service')
const settings = require('./settings')

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
  // 直连兜底配置（放宽红线后 opt-in）：从插件 config.promptCompiler.external 读取；
  // 默认 undefined → 工厂内判定 enabled=false，完全不启用。
  const externalConfig = (config && config.promptCompiler && config.promptCompiler.external) || undefined
  const promptCompiler = createPromptCompiler(ctx, externalConfig)
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

  // 模板编译（评审类）：给定模板 id 与变量，**确定性**渲染出 prompt。
  // 与 prompt_compile 的分工 —— 那个是"让 LLM 把草稿改写成好 prompt"（需推理、每次可能不同）；
  // 这个是"按固定模板 / 固定维度渲染"（要素固定、结果可复现、零模型成本）。
  // 不传 template 时退化为"列出可用模板"，让模型先发现再调用。
  ctx.tools.register(
    defineTool({
      name: 'prompt_template',
      description:
        '用内置模板确定性地渲染出结构化 prompt（如 portfolio-review 作品集评审）。' +
        '适合"按固定维度评一遍"这类可复现任务。不传 template 时列出所有可用模板及其变量要求。',
      parameters: {
        template: { type: 'string', description: '模板 id，如 portfolio-review；不传则只列出可用模板' },
        variables: {
          type: 'object',
          additionalProperties: true,
          description: '模板变量对象，如 { siteUrl, targetRoles, background }；未给的用模板默认值',
        },
      },
      output: {
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const id = String((args && args.template) || '').trim()
        if (!id) {
          return JSON.stringify(
            { hint: '传 template 与 variables 即可渲染。', templates: promptCompiler.listTemplates() },
            null, 2
          )
        }
        const r = promptCompiler.render(id, (args && args.variables) || {})
        if (!r.ok) {
          // 渲染失败是**可预期的用户输入问题**（缺变量 / 模板名错），
          // 回结构化 JSON 让模型能自我修正，而不是抛异常打断链路。
          return JSON.stringify(
            { ok: false, errors: r.errors, available: promptCompiler.listTemplates().map(t => t.id) },
            null, 2
          )
        }
        return r.text
      },
    })
  )

  // B4: 注册提示词 section（静态说明，无未定义花括号占位）
  ctx.systemPrompt.section({
    name: 'dsh-prompt-compiler',
    order: 100,
    text: '你有一个 prompt_compile 工具可用：当用户给出粗糙、含糊或缺少约束的指令时，可以建议用户调用 prompt_compile 把 draft 编译成结构化、可执行的 prompt。底层由可编程的 promptCompiler 服务提供（analyze/elicit/compile/render）。当任务属于"按固定维度评一遍"（例如评审作品集主页、代码审查这类要素固定的评审）时，改用 prompt_template 工具——它按内置模板确定性渲染，结果可复现，且不消耗模型调用。',
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
    // 显式 opt-in 的 LLM 链路自检路由（默认不跑；须传 {"run":true}）。
    // 用途：诊断「compile 为何走了规则降级」——2026-10-14 本次排障就是靠它一次拿到
    // 宿主原始 chunk（真因：messages[].content 传了字符串，宿主报
    // "content.some is not a function"），把此前五轮猜测一次性收敛。
    // 不传 run:true 时只回静态信息（provider/model 列表），零模型调用、零计费。
    const routes = {
      '/__dsh-prompt-compiler/api/selftest': async (body) => {
        const out = { ctxHasLlm: !!(ctx && ctx.llm) }
        const llm = ctx && ctx.llm
        if (!llm) return out
        try { out.providers = llm.listProviders() } catch (e) { out.providersErr = String(e && e.message || e) }
        if (!body || body.run !== true) {
          out.hint = '只返回静态信息（零模型调用）。要真实发起一次 stream 以定位降级原因，传 {"run":true}。'
          return out
        }
        out.streamAttempts = []
        const ids = (out.providers || [])
          .map(p => (typeof p === 'string' ? p : (p && (p.id || p.provider))))
          .filter(Boolean)
        // 只试 1 个 provider，避免自检本身烧掉多次模型调用（用户可传 provider/model 指定）。
        const provider = (body.provider && String(body.provider)) || ids[0]
        let model = body.model && String(body.model)
        if (!model && provider) {
          try {
            const ms = await llm.listModels(provider)
            if (Array.isArray(ms) && ms.length) model = ms[0].id || ms[0]
          } catch (e) { out.listModelsErr = String(e && e.message || e) }
        }
        if (!provider || !model) { out.hint = '未能确定 provider/model，请显式传 {"run":true,"provider":..,"model":..}' ; return out }
        const rec = { provider, model, chunks: [], error: null }
        try {
          const st = llm.stream({
            messages: [
              {
                role: 'system',
                id: 'selftest-sys-' + Date.now(),
                content: [{ type: 'text', text: '你是测试助手，只回复两个字：收到' }],
                source: { kind: 'plugin', plugin: 'dsh-prompt-compiler' },
              },
              {
                role: 'user',
                id: 'selftest-usr-' + Date.now(),
                content: [{ type: 'text', text: '测试' }],
                source: { kind: 'plugin', plugin: 'dsh-prompt-compiler' },
              },
            ],
            provider,
            model,
          })
          const full = []
          for await (const c of st) {
            // 只保留判别字段，避免把大对象/二进制塞进响应
            if (c && typeof c.text === 'string' && (c.type === 'text-delta' || c.type === 'reasoning-delta')) {
              full.push(c.text)
            }
            rec.chunks.push({
              type: c && c.type,
              text: c && typeof c.text === 'string' ? c.text.slice(0, 80) : undefined,
              reason: c && c.type === 'finish' ? c.reason : undefined,
            })
            if (rec.chunks.length >= 400) break
          }
          const joined = full.join('')
          rec.chunkCount = rec.chunks.length
          rec.joinedLength = joined.length
          out.joined = joined.slice(0, 4000)
        } catch (e) {
          rec.error = String(e && e.message || e)
          rec.code = e && e.code
        }
        out.streamAttempts.push(rec)
        return out
      },
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
        // 读取持久化设置作为**基线**（host 侧单一真相源），请求体只做本次覆盖。
        const st = settings.read()
        const options = { answers: body.answers && typeof body.answers === 'object' ? body.answers : {} }
        // 目标模型：请求体优先，其次设置页的默认值
        const tm = (typeof body.targetModel === 'string' && body.targetModel) ? body.targetModel : st.compile.targetModel
        if (tm) options.targetModel = tm
        if (body.strongTemplate !== undefined) options.strongTemplate = body.strongTemplate !== false
        else options.strongTemplate = st.compile.strongTemplate
        // 格式与可见性开关透传给 service
        options.format = st.format
        // 外部模型配置：请求体（UI 实时填写的）优先，否则用设置页持久化的
        const extSrc = (body.external && typeof body.external === 'object' && body.external.enabled && body.external.baseUrl)
          ? body.external
          : (st.external.enabled && st.external.baseUrl ? st.external : null)
        if (extSrc) {
          options.external = extSrc
          // extPriority=true ⇒ 外部模型**优先**；缺省/false ⇒ 宿主优先、外部兜底。
          options.extPriority = (body.extPriority === true || extSrc.priority === true)
          if (typeof extSrc.provider === 'string' && extSrc.provider) {
            promptCompiler.setProviderOverride(extSrc.provider)
          }
        }
        const { compiled, assumptions, polished, degraded, diag } = await promptCompiler.compile(draft, options)
        return { compiled, assumptions, polished, degraded, diag }
      },
      // —— 设置读写（设置页与编译逻辑共用同一份 host 侧配置） ——
      '/__dsh-prompt-compiler/api/settings': async (body) => {
        if (body && body.action === 'set' && body.settings && typeof body.settings === 'object') {
          // apiKey 回传空串 = 用户没改（view/UI 不回传明文）；applyUiPatch 会保留原值。
          const r = settings.applyUiPatch(body.settings)
          if (!r.ok) return { ok: false, error: r.error, settings: settings.view() }
          return { ok: true, settings: settings.view() }
        }
        if (body && body.action === 'reset') {
          const r = settings.write(settings.DEFAULTS)
          return { ok: r.ok, settings: settings.view() }
        }
        return { ok: true, settings: settings.view() }
      },
      // —— 模板编译（评审类）：确定性渲染，**不调 LLM** ——
      '/__dsh-prompt-compiler/api/templates': async () => {
        return { templates: promptCompiler.listTemplates() }
      },
      '/__dsh-prompt-compiler/api/render': async (body) => {
        const id = String((body && (body.template || body.id)) || '').trim()
        const r = promptCompiler.render(id, (body && body.variables) || {})
        // 校验失败 → 走下方统一 catch → 400 + {error}。
        // 是"用户输入问题"而非服务端故障，但 400 报文能让调用方拿到可读原因。
        if (!r.ok) throw new Error(r.errors.join('；'))
        return r
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
