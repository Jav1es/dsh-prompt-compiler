// C4: 类型声明。本项目为 JS、不编译；此文件仅供 TS 消费者/IDE 提供提示，不阻断运行。
// 声明 cordis Context 上的 promptCompiler 服务类型，使 `ctx.promptCompiler` 有补全。
//
// 服务由 lib/service.js 的 createPromptCompiler(ctx) 工厂返回普通对象（非 Service 子类，
// 避免 link 包双实例），类型用本项目自描述的接口，不依赖 cordis 运行时类。
// E 组：工厂现接收宿主 ctx（取 ctx.llm 驱动 analyze/compile，缺失则降级规则）；
// PromptCompiler 接口签名本身不变（analyze/compile/elicit 对消费方透明）。

export interface PromptCompiler {
  analyze(draft: string, ctx?: unknown): Promise<{
    missing: string[]
    ambiguities: string[]
    score: number
  }>
  elicit(draft: string): Promise<{
    questions: Array<{ id: string; text: string; why: string }>
  }>
  compile(
    draft: string,
    options?: { answers?: Record<string, string> }
  ): Promise<{ compiled: string; assumptions: string[] }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prompt Compiler 服务：诊断分析 / 交互式澄清 / 结构化合成。 */
    promptCompiler: PromptCompiler
  }
}

export { PromptCompiler }
