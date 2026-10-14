'use strict'

// C2 + E 组：Prompt Compiler 服务化层（"可编程的 prompt 编译层"核心）。
//
// ⚠️ 关键纪律（来自项目 AGENTS.md 红线 #2 + 实测踩坑）：
//   第三方插件 lib/ 内**绝不能 `require('@deepseek-ai/cordis')`** 拿 Service 基类。
//   原因：link 包在 profile 下若 devDependencies 装了 cordis 副本，会与宿主 asar 内
//   的 cordis 形成「双实例」——`extends Service` 用的是我们的副本，其 `provide` 写入
//   我们副本的 store，而宿主 ctx 的 store 是另一份 ⇒ 服务注册失效、runtime 查不到 key。
//   实测现象：cordis_inspect_query 列不出 promptCompiler，且工具报
//   "cannot get property promptCompiler without inject" / "analyze is not a function"。
//
// 正确做法（与 oss-prompt-optimizer 等价，但避免双实例）：本文件只导出**纯工厂函数**，
// 返回普通对象 { analyze, elicit, compile }；由 lib/index.js 在 apply(ctx) 里用**宿主
// 传入的 ctx.provide('promptCompiler', instance)** 注册——provide 操作的是宿主 ctx 的
// store，零双实例风险。消费方 inject:['promptCompiler'] 后即可 ctx.promptCompiler 拿到
// （真正跨插件可编程，这正是 C3 证据）。
//
// 🔴 E 组（LLM 智能接入）红线：
//   lib/ 内**零 `@deepseek-ai` 运行时 import**（已满足，本文件无任何 require('@deepseek-ai/...')）。
//   LLM 能力只能从宿主 apply(ctx) 传入的 ctx 上拿（ctx.llm），绝不能 import。
//   ctx.llm 缺失（agentless / NO_PROVIDER）时，analyze/compile 必须降级为规则实现，不抛错。

// 规则式 analyze 用的关键词桶（兼顾中英文常见表述）。
const GOAL_KEYWORDS = ['目标', '目的', 'goal', 'objective', 'task', '任务']
const CONSTRAINT_KEYWORDS = ['约束', '限制', '要求', 'constraint', 'requirement', 'must']
const FORMAT_KEYWORDS = ['输出格式', '格式', 'output format', 'format', '返回', 'result']
const VAGUE_WORDS = ['等等', '一些', '某种', '相关', '之类', '尽量', '最好']

// 规则式 compile 用的「缺失要素 → 自动假设」映射（模块级，供 LLM 兜底 assumptions 复用）。
const ASSUMPTION_MAP = {
  '缺少目标（要做什么）': '假设目标是完成 draft 所述任务，未额外约束成功标准',
  '缺少约束（边界/要求）': '假设无额外边界，模型在合理范围内自行决策',
  '缺少输出格式（期望交付形态）': '假设输出为结构化 Markdown 文本',
}

// —— E 组：LLM 系统提示词（中文） ——
const ANALYZE_SYSTEM = `你是一名严谨的 prompt 工程评审。用户会给你一段粗糙的 draft（自然语言指令）。
请评估其作为可执行 prompt 的完整度，仅输出一个 JSON 对象。
严格规则：
1. 第一个字符必须是 {，最后一个字符必须是 }
2. 绝对禁止使用 markdown 代码块（不要写 \`\`\`json 或 \`\`\`）
3. 绝对禁止在 JSON 前后写任何说明文字、问候语或解释
4. 只允许输出这一个 JSON 对象，不要输出其他任何内容
JSON 结构如下（字段缺一不可）：
{
  "missing": string[]（draft 缺失的关键要素，如：目标 / 约束 / 上下文 / 验证标准 / 输出格式），
  "ambiguities": string[]（draft 中存在的歧义、模糊或可多重解读之处），
  "score": number（0-100 的完整度评分，越高越可直接使用），
  "reasoning": string（一句话评审说明）
}`

// 跨模型格式约定（审计 S+跨模型A）：按 targetModel 注入语气/格式风格。
// 不新增独立阶段，只在合成时调整呈现，避免三阶段流程膨胀。
function modelStyle(targetModel) {
  switch (targetModel) {
    case 'claude':
      return '目标模型是 Claude：各段用 XML 标签包裹（如 <task>…</task>、<constraints>…</constraints>），不用 markdown 标题。'
    case 'gpt':
      return '目标模型是 GPT：保持 Markdown 标题结构，语气正式、指令清晰。'
    case 'local':
      return '目标模型是本地小模型：去除所有 Markdown 格式与修饰，用极简直白的自然语言指令，短句为主。'
    case 'deepseek':
    default:
      return '目标模型是 DeepSeek（默认）：Markdown 四段结构，清晰可执行。'
  }
}

// COMPILE_SYSTEM 改为工厂：注入 targetModel 风格（默认 model-agnostic markdown）。
function buildCompileSystem(targetModel) {
  return `你是一名 prompt 工程专家。用户会给你一个 JSON：{"draft": string（原始粗糙指令）, "answers": object（用户对澄清问题的回答，可能为空）}。
请将 draft 编译为一段精确、完整、可直接使用、且经过**文字整理与提示优化**的 prompt，以纯文本返回（不要用代码块包裹）。

【第一步：rewrite（先重写，再结构化）】
- 对 draft 做主动的全句重写：调整语序、补全省略的主语与对象、统一术语、把模糊词（"一些""尽量""相关"）替换为可量化或明确的说法、将散乱想法整理为连贯清晰的指令。
- **允许对 draft 已明示但表述含糊处做出合理具体化**（例如"快点"→"响应时间 < 200ms"），但**严格禁止引入 draft 未出现的任何新需求、新事实、新数字、新约束**。
- 不是简单照搬原句：在**不改变用户真实意图**的前提下，让指令更清晰、更可执行、更少歧义。若你的输出与原文逐字相同，视为失败——必须体现改写。

【第二步：structure（落入四段）】
## Task（任务目标）——用重写后的清晰语句重述"要做什么"
## Constraints（约束与边界）——列出硬性边界与禁用做法（不要用"明确、可执行"这类空话，写具体边界）
## Output Format（期望交付形态）——明确交付结构（文本/JSON/表格/代码块等）
## Acceptance Criteria（验收标准）——可核验的"做对了"的标准

【格式风格】
${modelStyle(targetModel)}

【自检（输出前默念）】四段是否齐全？是否已在第一步真正重写（非照搬）？Constraints/Output Format 是否写了具体内容而非空话？

参考示例：
- draft：「帮我写个爬虫，抓点新闻，越快越好」
- 优化后 Task：抓取目标新闻网站（用户指定 URL）首页的当日头条新闻标题与链接。
- 优化后 Constraints：仅使用 HTTP GET；遵守目标站 robots.txt；单页请求间隔 ≥ 1s；不抓取付费/登录后内容。
- 优化后 Output Format：每行一条 JSON：{"title": "...", "url": "..."}。
- 优化后 Acceptance Criteria：返回的每条记录含非空 title 与可访问 url；总数与首页头条一致。

若 answers 提供了补充信息，请将其融入对应段落。`
}

const COMPILE_SYSTEM = buildCompileSystem() // 兼容旧引用（默认 markdown）

function lowerIncludes(text, kw) {
  return text.toLowerCase().includes(kw.toLowerCase())
}

// 从 LLM 返回文本里抓取第一个 {...} JSON（竞品 R6 经验：正则抓取后 JSON.parse）。
// 增强：先剥 markdown 代码块围栏（```json / ```），再抓 {...}，容忍前后缀文字。
function extractJson(text) {
  if (typeof text !== 'string') return null
  let s = text.trim()
  // 去代码块围栏：```json ... ``` 或 ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // 抓第一个 { 到最后一个 } 之间的内容（容忍前后缀）
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  const candidate = s.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

/**
 * 创建 Prompt Compiler 服务实例（普通对象，非 Service 子类）。
 * E 组：analyze/compile 升级为 LLM 驱动（带规则降级），elicit 保留规则。
 * @param {object} [ctx] 宿主 cordis Context；从中取 ctx.llm（可能 undefined → 触发降级）。
 * @param {object} [externalConfig] 直连兜底配置（放宽红线后的 opt-in 第二层）。
 *   结构：{ enabled:boolean, baseUrl:string, apiKey:string, model:string }
 *   仅当 enabled=true 且 baseUrl 非空时才启用；默认完全关闭，绝不主动外联。
 * @returns {{analyze:Function, elicit:Function, compile:Function}}
 */
function createPromptCompiler(ctx, externalConfig) {
  // 红线放宽（2026-10-14 用户拍板）：宿主 ctx.llm 不可用时，允许用户显式配置的外部 endpoint 直调。
  // 约束：enabled 默认 false、仅内存/配置持有密钥、绝不自动探测、失败仍降级规则。
  const ext = (externalConfig && externalConfig.enabled && externalConfig.baseUrl)
    ? externalConfig
    : null

  // 直连兜底：OpenAI-compatible / ollama。宿主为 Node 进程，全局 fetch 可用。
  // 返回 { text, err }；任何失败返回 text=null（不抛），由调用方降级规则。
  async function callExternalLLM(systemText, userText, extCfg) {
    const cfg = extCfg || ext
    if (!cfg) return { text: null, err: 'external disabled' }
    try {
      const isOllama = /localhost|127\.0\.0\.1/.test(cfg.baseUrl)
      const body = isOllama
        ? { model: cfg.model || 'llama3.2', messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }], stream: false }
        : { model: cfg.model || '', messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }], stream: false }
      const headers = { 'Content-Type': 'application/json' }
      if (!isOllama && cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey
      const res = await fetch(cfg.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) return { text: null, err: 'HTTP ' + res.status }
      const data = await res.json()
      const text = isOllama
        ? (data && data.message && data.message.content) || ''
        : (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
      return { text: text || null, err: text ? null : 'empty response' }
    } catch (e) {
      return { text: null, err: String(e && e.message ? e.message : e) }
    }
  }

  // 红线：LLM 能力优先从宿主 ctx 上拿，绝不 import。
  const llm = ctx && ctx.llm

  /**
   * 内部辅助：流式调用 LLM。
   * - 若 ctx.llm 不存在 → 返回 null（调用方据此降级规则）。
   * - 任何异常 / 空流 → 返回 null（降级规则），不向上抛。
   */
  // 从单个 stream chunk 提取文本片段。非字符串一律忽略——
  // 真实故障（2026-10-14）：宿主 chunk 含布尔字段（text:false / choices[0].text:false），
  // 直接 += 会被拼成字符串 "false"，让"编译成功"变成假阳性、UI 不显示降级横幅。
  function extractText(chunk) {
    if (typeof chunk === 'string') return chunk
    if (!chunk || typeof chunk !== 'object') return ''
    const cands = [chunk.text, chunk.content]
    if (typeof chunk.delta === 'string') cands.push(chunk.delta)
    else if (chunk.delta && typeof chunk.delta === 'object') cands.push(chunk.delta.text, chunk.delta.content)
    if (chunk.message) cands.push(chunk.message.content)
    if (Array.isArray(chunk.choices) && chunk.choices[0]) {
      const ch = chunk.choices[0]
      cands.push(ch.text)
      if (ch.delta && typeof ch.delta === 'object') cands.push(ch.delta.content, ch.delta.text)
      if (ch.message) cands.push(ch.message.content)
    }
    for (const v of cands) if (typeof v === 'string' && v) return v
    return ''
  }

  // NO_ADAPTER 根因（2026-10-14 实测）：宿主报 no adapter registered for provider "undefined"
  // ⇒ 调用时必须带上模型/provider 标识。字段名未知，故先探测 ctx.llm / ctx 上的键名并冗余传参。
  const llmKeys = (function () {
    try { return llm && typeof llm === 'object' ? Object.keys(llm).slice(0, 30) : [] } catch (e) { return [] }
  })()
  const ctxKeys = (function () {
    try { return ctx && typeof ctx === 'object' ? Object.keys(ctx).slice(0, 40) : [] } catch (e) { return [] }
  })()
  // 探测可能的模型标识字段（只取字符串/对象浅描，避免把大对象塞进 diag）
  const modelId = (function () {
    try {
      const cand = llm && (llm.model || llm.defaultModel || llm.currentModel || llm.modelId || llm.current)
      if (typeof cand === 'string') return cand
      if (cand && typeof cand === 'object') return cand.id || cand.name || cand.model || null
      return null
    } catch (e) { return null }
  })()
  // 允许外部（index.js，来自 ⚙ 卡 / externalConfig.provider）覆盖默认 provider 候选。
  // 挂到 callLLM 上，使 createPromptCompiler 在 apply 阶段可注入。
  callLLM._overrideProvider = null
  function setProviderOverride(p) { callLLM._overrideProvider = (typeof p === 'string' && p) ? p : null }

  // 诊断探针（审计建议）：记录 callLLM 失败原因，供 UI/返回体暴露，避免静默降级吞掉全部原因。
  let lastDiag = null
  async function callLLM(systemText, userText) {
    const diag = {
      hasLlm: !!llm, hasStream: !!(llm && typeof llm.stream === 'function'), err: null, emptyStream: false,
      llmKeys, ctxKeys, modelId,
    }
    if (!llm) { lastDiag = diag; return null }
    if (typeof llm.stream !== 'function') { lastDiag = diag; return null }

    // 关键修复（2026-10-14 源码实证 dsh-llm:2286 → :1777）：stream 必须带 provider（已注册 provider id），
    // 否则 directory.get(provider) === undefined → 抛 NO_ADAPTER。从 listProviders() 取真实列表，
    // 它是内存直读、无网络依赖（dsh-llm:1899）。默认优先 workbuddy（本机会话模型 workbuddy/hy3-x 等）。
    let registeredProviders = []
    try {
      if (typeof llm.listProviders === 'function') {
        const ps = llm.listProviders()
        registeredProviders = (Array.isArray(ps) ? ps : [])
          .map(p => (typeof p === 'string' ? p : (p && (p.id || p.provider))))
          .filter(Boolean)
      }
    } catch (e) { diag.listErr = String(e && e.message ? e.message : e).slice(0, 120) }
    diag.registeredProviders = registeredProviders

    // 候选 provider：options.provider 覆盖 > 注册列表（workbuddy 置顶）> 兜底 workbuddy
    const override = (callLLM._overrideProvider) || null
    let candidates = override ? [override] : registeredProviders.slice()
    if (!override) {
      if (candidates.includes('workbuddy')) candidates = ['workbuddy', ...candidates.filter(p => p !== 'workbuddy')]
      else if (!candidates.length) candidates = ['workbuddy']
    }
    diag.candidates = candidates

    // 单次尝试：purpose 仅 compaction/session-title；provider 必填；model 留空吃 route 默认。
    async function attempt(purpose, provider, model) {
      const d = { purpose, provider, model: model || undefined, chunkCount: 0, firstShape: null, types: [], reject: null, err: null, out: '' }
      try {
        const base = {
          messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
          ],
          purpose,
          source: { kind: 'plugin' },
          provider,
        }
        if (model) base.model = model
        const stream = await llm.stream(base)
        for await (const chunk of stream) {
          d.chunkCount++
          if (d.chunkCount === 1) {
            try {
              d.firstShape = (chunk && typeof chunk === 'object')
                ? (Array.isArray(chunk) ? 'array:' + chunk.length : 'object keys=[' + Object.keys(chunk).join(',') + ']')
                : typeof chunk
            } catch (e) { d.firstShape = 'unprobed' }
          }
          // 记录每个 chunk 的事件类型（实测宿主回 {type:'finish', reason:{...}}）。reason 可能是对象 → JSON 化。
          if (chunk && typeof chunk === 'object' && typeof chunk.type === 'string') {
            if (d.types.length < 8) d.types.push(chunk.type)
            if (!d.reject) {
              const r = chunk.reason !== undefined
                ? (typeof chunk.reason === 'string' ? chunk.reason : JSON.stringify(chunk.reason))
                : ''
              d.reject = chunk.type + (r ? ': ' + r.slice(0, 300) : '')
            }
          }
          d.out += extractText(chunk)
        }
      } catch (e) {
        d.err = String(e && e.message ? e.message : e)
      }
      return d
    }

    // 双重循环：provider × purpose。首个有内容的即采纳；NO_ADAPTER 则换下一个 provider。
    const attempts = []
    let used = null
    outer:
    for (const provider of candidates) {
      for (const purpose of ['compaction', 'session-title']) {
        const d = await attempt(purpose, provider, undefined)
        attempts.push(d)
        if (d.out.trim()) { used = d; break outer }
        // 该 provider 命中但 model 默认路径失败：再带显式 model 重试一次
        if (modelId && (!d.reject || /NO_ADAPTER|INVALID/.test(d.reject))) {
          const d2 = await attempt(purpose, provider, modelId)
          attempts.push(d2)
          if (d2.out.trim()) { used = d2; break outer }
        }
      }
    }
    diag.attempts = attempts.map(a => a.purpose + '@' + a.provider)
    // 两次尝试都完整暴露：各自 chunk 数、事件类型序列、拒绝块内容（横幅据此定位真因）
    diag.attemptsDetail = attempts.map(a =>
      a.purpose + '@' + a.provider + (a.model ? '#' + a.model : '') + ' | chunk=' + a.chunkCount
      + ' | types=[' + (a.types.join(',') || '-') + ']'
      + (a.reject ? ' | reject=' + a.reject : '')
      + (a.err ? ' | err=' + a.err.slice(0, 120) : '')
      + ' | textLen=' + a.out.trim().length
    )
    diag.purpose = used ? used.purpose : null
    diag.providerUsed = used ? used.provider : null
    diag.chunkCount = used ? used.chunkCount : 0
    diag.chunkTypes = used ? used.types : []
    diag.firstShape = used ? used.firstShape : null
    diag.reject = attempts.map(a => a.reject).filter(Boolean)[0] || null
    diag.err = used ? used.err || null : (attempts.map(a => a.err).filter(Boolean)[0] || null)
    const out = used ? used.out : ''
    const trimmed = out.trim()
    if (!trimmed) diag.emptyStream = true
    // 退化输出守卫：宿主把布尔/空值当文本吐出来（如 "false"/"true"/"[object Object]"）时，不能当成"编译成功"。
    if (trimmed && /^(false|true|null|undefined|nan|\[object object\]|<empty>|empty)$/i.test(trimmed)) {
      diag.degenerateOutput = trimmed.slice(0, 40)
      lastDiag = diag
      return null
    }
    lastDiag = diag
    return out || null
  }

  // —— 规则实现（降级兜底，原逻辑搬此，不删） ——
  function ruleAnalyze(draft) {
    const text = typeof draft === 'string' ? draft.trim() : ''
    const missing = []
    const ambiguities = []

    if (text.length < 10) missing.push('内容过短（<10 字）')

    const hasGoal = GOAL_KEYWORDS.some(k => lowerIncludes(text, k))
    const hasConstraint = CONSTRAINT_KEYWORDS.some(k => lowerIncludes(text, k))
    const hasFormat = FORMAT_KEYWORDS.some(k => lowerIncludes(text, k))

    if (!hasGoal) missing.push('缺少目标（要做什么）')
    if (!hasConstraint) missing.push('缺少约束（边界/要求）')
    if (!hasFormat) missing.push('缺少输出格式（期望交付形态）')

    for (const w of VAGUE_WORDS) {
      if (text.includes(w)) ambiguities.push(`含模糊表述「${w}」，需量化或举例`)
    }

    // 粗略评分：长度基础分（≤40） + 三要素各 +20。
    let score = Math.min(40, Math.floor(text.length / 2))
    if (hasGoal) score += 20
    if (hasConstraint) score += 20
    if (hasFormat) score += 20
    score = Math.max(0, Math.min(100, score))

    return { missing, ambiguities, score, reasoning: '' }
  }

  // 规则降级的轻量文字整理：去掉口语填充词、拆分长句、规整空白。
  // 不做语义改写（无 LLM），只做确定性清理，让 Task 段比原样 draft 更整齐。
  function tidyDraft(text) {
    let s = text.trim()
    // 去口语填充词（保留其后的标点/空格）
    const fillers = ['帮我', '请帮我', '我想让你', '我希望你', '能不能', '可以吗', '就是', '的话']
    for (const f of fillers) {
      s = s.split(f).join('')
    }
    // 规整空白与首尾标点
    s = s.replace(/\s+/g, ' ').replace(/^[，,。.\s]+/, '').replace(/[，,]+$/, '').trim()
    // 长句按中文/英文句号拆分，逐行列出，便于阅读
    const parts = s.split(/(?<=[。.!?！？])/).map(p => p.trim()).filter(Boolean)
    return parts.length ? parts.join('\n') : s
  }

  function ruleCompile(draft, options) {
    const text = typeof draft === 'string' ? draft.trim() : ''
    const answers = (options && typeof options.answers === 'object' && options.answers) || {}
    const { missing } = ruleAnalyze(draft)

    const assumptions = []
    for (const m of missing) {
      if (ASSUMPTION_MAP[m]) assumptions.push(ASSUMPTION_MAP[m])
    }

    const goalLine = answers.goal || tidyDraft(text) || '(empty draft)'
    const constraintLine = answers.constraint || '明确、可执行、无歧义'
    const formatLine = answers.format || '结构化、可直接使用'

    const sections = [
      '# Compiled Prompt',
      '',
      '## Task',
      goalLine,
      '',
      '## Constraints',
      `- ${constraintLine}`,
      '',
      '## Output Format',
      `- ${formatLine}`,
    ]
    if (assumptions.length > 0) {
      sections.push(
        '',
        '## Assumptions (auto-inferred, please verify)',
        ...assumptions.map(a => `- ${a}`)
      )
    }
    return { compiled: sections.join('\n'), assumptions }
  }

  // —— analyze：LLM 驱动 + 规则降级 ——
  async function analyze(draft) {
    const llmOut = await callLLM(ANALYZE_SYSTEM, draft)
    if (llmOut == null) return ruleAnalyze(draft)

    const parsed = extractJson(llmOut)
    if (!parsed) return ruleAnalyze(draft)

    const { missing, ambiguities, score, reasoning } = parsed
    // 容错：LLM 返回的 JSON 必须含 missing(数组)/ambiguities(数组)/score(数字)，
    // 缺字段则整体降级规则。
    if (!Array.isArray(missing) || !Array.isArray(ambiguities) || typeof score !== 'number') {
      return ruleAnalyze(draft)
    }
    return {
      missing,
      ambiguities,
      score: Math.max(0, Math.min(100, score)),
      reasoning: typeof reasoning === 'string' ? reasoning : '',
    }
  }

  // —— elicit：保留规则实现不变（不接 LLM，更快更可预测） ——
  // 注意内部调用 ruleAnalyze，而非 analyze，确保 elicit 路径绝不触 LLM。
  async function elicit(draft) {
    const { missing } = ruleAnalyze(draft)
    const pool = [
      {
        id: 'goal',
        match: '缺少目标（要做什么）',
        text: '这个 prompt 的核心目标是什么？希望模型产出什么具体结果？',
        why: '不答：模型无从判断"做对"的标准，易跑偏或过度发挥；结果可能完全偏离你的真实意图。',
      },
      {
        id: 'constraint',
        match: '缺少约束（边界/要求）',
        text: '有哪些硬性约束或边界（禁用做法、输入/输出限制、性能/格式要求）？',
        why: '不答：模型默认选择任意合理路径，可能踩中你不接受的方案；结果"能用但不符合你的规矩"。',
      },
      {
        id: 'format',
        match: '缺少输出格式（期望交付形态）',
        text: '期望的交付形态是什么（结构化文本 / JSON / 表格 / 代码块）？',
        why: '不答：模型自行决定呈现形式，下游可能无法直接解析；需要你二次加工才能接入工具链。',
      },
    ]
    const questions = pool
      .filter(p => missing.includes(p.match))
      .map(p => ({ id: p.id, text: p.text, why: p.why }))
    return { questions: questions.slice(0, 3) }
  }

  // —— compile：LLM 驱动 + 规则降级 ——
  // 返回体：{ compiled, assumptions, polished, degraded }
  //   polished: true=LLM 合成；degraded: true=走了规则降级（无 LLM）
  async function compile(draft, options) {
    const answers = (options && typeof options.answers === 'object' && options.answers) || {}
    const targetModel = (options && typeof options.targetModel === 'string') ? options.targetModel : undefined
    // 直连兜底配置：UI 实时填写（options.external）优先，fallback 工厂注入的 config（ext）。
    const effectiveExt = (options && options.external && options.external.enabled && options.external.baseUrl)
      ? options.external
      : ext
    const llmOut = await callLLM(
      buildCompileSystem(targetModel),
      JSON.stringify({ draft: typeof draft === 'string' ? draft : '', answers })
    )
    if (llmOut == null) {
      // 直连兜底（放宽红线后 opt-in）：宿主 LLM 不可用且用户配了外部 endpoint 时，第二层调用。
      if (effectiveExt) {
        const extOut = await callExternalLLM(
          buildCompileSystem(targetModel),
          JSON.stringify({ draft: typeof draft === 'string' ? draft : '', answers }),
          effectiveExt
        )
        if (extOut && extOut.text) {
          const compiled = extOut.text.trim()
          const hasMarkdown = ['## Task', '## Constraints', '## Output Format', '## Acceptance'].every(h => compiled.includes(h))
          const hasXml = ['<task', '<constraints', '<output', '<acceptance'].some(t => compiled.toLowerCase().includes(t))
          const { missing } = ruleAnalyze(draft)
          const assumptions = missing.filter(m => ASSUMPTION_MAP[m]).map(m => ASSUMPTION_MAP[m])
          return { compiled, assumptions, polished: hasMarkdown || hasXml, degraded: false, external: true, diag: { ...lastDiag, external: extOut.err || 'ok' } }
        }
        // 外部也失败 → 降级规则，diag 记录 external 错误
        lastDiag = { ...lastDiag, external: extOut ? extOut.err : 'no response' }
      }
      const r = ruleCompile(draft, options)
      return { ...r, polished: false, degraded: true, diag: lastDiag }
    }

    // LLM 合成：后处理（S2）——四段标题校验，缺则提示但不强制（LLM 可能用 XML 标签）。
    const compiled = llmOut.trim()
    const hasMarkdown = ['## Task', '## Constraints', '## Output Format', '## Acceptance'].every(h => compiled.includes(h))
    const hasXml = ['<task', '<constraints', '<output', '<acceptance'].some(t => compiled.toLowerCase().includes(t))
    // 四段既非 markdown 也非 xml（local 极简风格允许无结构）→ 仍接受，但标记 polished 让 UI 知晓。
    const { missing } = ruleAnalyze(draft)
    const assumptions = missing
      .filter(m => ASSUMPTION_MAP[m])
      .map(m => ASSUMPTION_MAP[m])
    return { compiled, assumptions, polished: hasMarkdown || hasXml, degraded: false, diag: lastDiag }
  }

  return { analyze, elicit, compile, setProviderOverride }
}

module.exports = { createPromptCompiler }
