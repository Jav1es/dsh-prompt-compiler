// C4: 类型声明。本项目为 JS、不编译；此文件仅供 TS 消费者/IDE 提供提示，不阻断运行。
// 声明 cordis Context 上的 promptCompiler 服务类型，使 `ctx.promptCompiler` 有补全。
//
// 服务由 lib/service.js 的 createPromptCompiler(ctx, externalConfig) 工厂返回普通对象
// （非 Service 子类，避免 link 包双实例），类型用本项目自描述的接口，不依赖 cordis 运行时类。
// E 组：工厂接收宿主 ctx（取 ctx.llm 驱动 analyze/compile，缺失则降级规则）。
// F1：五维评分由 lib/scoring.js 确定性计算，**与 LLM 无关** —— 任何路径下都带 score5d。

/** 单个维度的评分结果（0–20）。 */
export interface ScoreDim {
  /** 维度 id：goal / context / constraint / acceptance / ambiguity */
  id: 'goal' | 'context' | 'constraint' | 'acceptance' | 'ambiguity'
  /** 中文标签 */
  label: string
  /** 本维得分，0–20 */
  score: number
  /** 满分（恒为 20，便于前端算百分比） */
  max: number
  /** 扣分/加分理由，可直接展示给用户复核 */
  reasons: string[]
}

/** 五维评分结果（规则式、确定性、可解释；总分 = 五维之和，0–100）。 */
export interface Score5D {
  /** 0–100，恒等于五个 dims.score 之和 */
  total: number
  dims: {
    goal: ScoreDim
    context: ScoreDim
    constraint: ScoreDim
    acceptance: ScoreDim
    ambiguity: ScoreDim
  }
  /** 一句话总评 */
  summary: string
  /** 补充提示（可能为空串） */
  note: string
  /** 参与评分的原文长度 */
  inputLength: number
}

/** compile 结果的 Before/After 对比（三条返回路径统一收口）。 */
export interface ScoreDelta {
  total: { before: number; after: number; delta: number }
  perDim: Record<string, { label: string; before: number; after: number; delta: number }>
}

export interface AnalyzeResult {
  /** 缺失要素（中文短语） */
  missing: string[]
  /** 歧义点 */
  ambiguities: string[]
  /**
   * LLM 自评的 0–100 分。**仅作参考，不要拿来做 Before/After 对比或写进文档**：
   * 该值每次调用会漂移。要可复现的分请用 score5d。
   */
  score: number
  /** LLM 的评分理由（规则降级时为空串） */
  reasoning?: string
  /** 五维评分（确定性，恒存在） */
  score5d: Score5D
}

export interface CompileResult {
  /** 编译后的完整 prompt */
  compiled: string
  /** 编译过程中替用户做出的假设 */
  assumptions: string[]
  /** true = LLM 合成 */
  polished?: boolean
  /** true = 走了规则降级（无 LLM） */
  degraded?: boolean
  /** 排障用诊断信息 */
  diag?: Record<string, unknown>
  /** 编译后的五维评分（恒存在） */
  score5d: Score5D
  /** Before/After 对比（恒存在） */
  scoreDelta: ScoreDelta
}

export interface RenderResult {
  ok: boolean
  /** 渲染产物（ok=true 时存在） */
  prompt?: string
  /** 结构化错误（ok=false 时存在） */
  errors?: string[]
}

export interface TemplateMeta {
  id: string
  name: string
  version?: string
  category: string
  description?: string
  /** 变量 JSON Schema；**不含模板正文**（避免返回值过大） */
  variables: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

export interface ElicitQuestion {
  id: string
  text: string
  why: string
}

/**
 * 交互式澄清结果（E2）。
 *
 * `asked=false` 是**正常状态**，不是错误：本插件在 agentless 环境（没有
 * `ctx.userQuestions` 或无人挂 answerer）里必然走这条路径。
 * 调用方据此决定 UI：有 questions 就自己渲染成表单，没有就直接编译。
 */
export interface ElicitInteractiveResult {
  /** true = 真的问到了用户，answers 里有答案 */
  asked: boolean
  /**
   * ok       成功问到
   * partial  部分成功，后面的提问失败了（已答的答案保留）
   * no_questions      draft 已足够清楚
   * no_user_questions 宿主没有该服务（agentless 常态）
   * ask_failed        提问抛错（如 NO_PROVIDER / DELEGATED_CALLER）
   * declined          用户全部跳过
   */
  reason: 'ok' | 'partial' | 'no_questions' | 'no_user_questions' | 'ask_failed' | 'declined'
  /** 失败时的错误码（如 NO_PROVIDER） */
  error?: string
  questions: ElicitQuestion[]
  /** 题目 id → 答案 */
  answers: Record<string, string>
  /** 已把 answers 拼回原文的 draft（未答时与原 draft 相同） */
  draft: string
}

export interface PromptCompiler {
  analyze(draft: string): Promise<AnalyzeResult>
  elicit(draft: string): Promise<{ questions: ElicitQuestion[] }>
  /** 真的去问用户（E2）。拿不到提问能力时安全降级，绝不抛错。 */
  elicitInteractive(
    draft: string,
    options?: { timeoutMs?: number; shouldStop?: (answers: Record<string, string>) => boolean }
  ): Promise<ElicitInteractiveResult>
  compile(
    draft: string,
    options?: {
      answers?: Record<string, string>
      targetModel?: string
      strongTemplate?: boolean
      format?: unknown
      external?: {
        enabled: boolean
        baseUrl: string
        apiKey?: string
        model?: string
        provider?: string
        priority?: boolean
      }
      extPriority?: boolean
    }
  ): Promise<CompileResult>
  /** 按模板**确定性**渲染（评审类任务）；失败回结构化错误、不抛。 */
  render(templateId: string, variables?: Record<string, unknown>): RenderResult
  /** 列出模板元数据（不回正文）。 */
  listTemplates(): TemplateMeta[]
  setProviderOverride(provider: string): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prompt Compiler 服务：诊断分析 / 交互式澄清 / 结构化合成 / 模板渲染 / 五维评分。 */
    promptCompiler: PromptCompiler
  }
}

export { PromptCompiler }
