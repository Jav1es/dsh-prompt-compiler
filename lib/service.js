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

const COMPILE_SYSTEM = `你是一名 prompt 工程专家。用户会给你一个 JSON：{"draft": string（原始粗糙指令）, "answers": object（用户对澄清问题的回答，可能为空）}。
请将 draft 编译为一段精确、完整、可直接使用的 prompt，以 Markdown 文本返回（不要使用代码块包裹）。

【核心要求：文字整理与提示优化】
- 对 draft 做主动的**文字润色与提示优化**：消除口语化/冗余表述、补全省略的主语与对象、统一术语、把模糊词（"一些""尽量""相关"）替换为可量化或明确的说法、将散乱想法整理为清晰指令。
- 不是简单照搬原句，而是在**不改变用户真实意图**的前提下，让指令更清晰、更可执行、更少歧义。
- 逐字保留 draft 中的路径、命令、版本号、专有名词等具体信息；**禁止编造任何事实、数据或要求**（优化表达 ≠ 添加内容）。
- 若 answers 提供了补充信息，请将其融入对应段落。

强制包含以下四段：
## Task（任务目标）——用优化后的清晰语句重述"要做什么"
## Constraints（约束与边界）——列出硬性边界与禁用做法
## Output Format（期望交付形态）——明确交付结构（文本/JSON/表格/代码块等）
## Acceptance Criteria（验收标准）——可核验的"做对了"的标准`

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
 * @returns {{analyze:Function, elicit:Function, compile:Function}}
 */
function createPromptCompiler(ctx) {
  // 红线：LLM 能力只能从宿主 ctx 上拿，绝不 import。
  const llm = ctx && ctx.llm

  /**
   * 内部辅助：流式调用 LLM。
   * - 若 ctx.llm 不存在 → 返回 null（调用方据此降级规则）。
   * - 任何异常 / 空流 → 返回 null（降级规则），不向上抛。
   */
  async function callLLM(systemText, userText) {
    if (!llm) return null
    if (typeof llm.stream !== 'function') return null
    try {
      const stream = await llm.stream({
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userText },
        ],
        // purpose 必填且只能是 compaction/session-title；传 'session-title' 仅作占位，
        // 实际推理靠 source:{kind:'plugin'} 触发（竞品 yaoshuo530/dsh-prompt-enhancer 实证）。
        purpose: 'session-title',
        source: { kind: 'plugin' },
      })
      let out = ''
      for await (const chunk of stream) {
        out += (chunk.text ?? chunk.content ?? '')
      }
      return out || null
    } catch {
      return null
    }
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
  async function compile(draft, options) {
    const answers = (options && typeof options.answers === 'object' && options.answers) || {}
    const llmOut = await callLLM(
      COMPILE_SYSTEM,
      JSON.stringify({ draft: typeof draft === 'string' ? draft : '', answers })
    )
    if (llmOut == null) return ruleCompile(draft, options)

    // 把 LLM 返回的 markdown 当 compiled；assumptions 仍由规则兜底。
    const { missing } = ruleAnalyze(draft)
    const assumptions = missing
      .filter(m => ASSUMPTION_MAP[m])
      .map(m => ASSUMPTION_MAP[m])
    return { compiled: llmOut.trim(), assumptions }
  }

  return { analyze, elicit, compile }
}

module.exports = { createPromptCompiler }
