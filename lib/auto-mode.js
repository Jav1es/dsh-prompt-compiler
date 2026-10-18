'use strict'

// E4：`agent/pre-step` 自动模式（**默认关闭，且默认不可用**）。
//
// ============================================================================
// 为什么这项要格外小心（写在这里，防止后来者"好心"打开它）
// ============================================================================
// 1. **语义危险**：这个钩子能把用户消息**整体替换**后再交给模型。
//    一旦逻辑有 bug，用户说的和他以为模型听到的会不一致 —— 这比崩溃更难发现，
//    因为没有任何报错，只是"模型怎么没按我说的做"。
// 2. **每步都烧一次 LLM**：agent 的每个 step 都会触发；一个长任务几十步，
//    就是几十次额外调用，而且这些调用**发生在用户看不见的地方**。
// 3. 官方描述原话：`Reject a proposed step or replace the messages that enter it.`
//    —— replace 是它的本职能力，拦都拦不住，只能靠"默认不开"来守。
//
// ⇒ 本模块的立场：
//   - 默认**完全关闭**，且需要**两道**显式开关同时打开才生效
//     （`auto.enabled === true` **且** `auto.iUnderstandTheRisk === true`）；
//   - 即便打开，也只做**加法**（在末尾追加一条提示消息），**绝不替换或删除**
//     用户原有消息 —— 这样"模型听到的 ⊇ 用户说的"这条不变量永远成立；
//   - 每一步都记日志，用户能事后审计到底改了什么。
//
// 为什么保留"骨架"而不是干脆不写：
//   NEXT-STEPS 里这条标的是"（可选）"。把它做成一个**不会伤人的空壳**，
//   将来真要开时不用重新调研宿主契约；而默认路径下它对运行零影响。

/**
 * 从 config 里读出 E4 的实际设置，并归一化成 { enabled, reason }。
 *
 * enabled 只有在**两个开关都为 true** 时才是 true —— 故意设计成"双钥匙"：
 * 单看 `enabled: true` 很像随手打开的配置项，而 `iUnderstandTheRisk` 必须由人
 * 亲手写进配置，能有效防止"某个导出的模板把它抄进去了"。
 */
function readAutoMode(auto) {
  const a = auto && typeof auto === 'object' ? auto : {}
  if (a.enabled !== true) return { enabled: false, reason: 'disabled' }
  if (a.iUnderstandTheRisk !== true) return { enabled: false, reason: 'risk_not_acknowledged' }
  return { enabled: true, reason: 'enabled' }
}

/**
 * 挂载 agent/pre-step 监听。
 *
 * @param {object} ctx  宿主 ctx（必须已有 ctx.on）
 * @param {object} opts
 * @param {object} opts.auto   config 里的 auto 段
 * @param {Function} [opts.log] 日志函数（默认 console.warn），用于事后审计
 * @returns {{ enabled: boolean, reason: string, dispose: Function|null }}
 */
function installAutoMode(ctx, opts) {
  const o = opts || {}
  const state = readAutoMode(o.auto)
  const log = typeof o.log === 'function' ? o.log : msg => console.warn(`[prompt-compiler][auto] ${msg}`)

  if (!state.enabled) {
    // 默认路径：**不注册任何监听**。不是"注册了但立刻 return" ——
    // 后者仍会在每个 step 上多一次函数调用，属于无谓开销。
    return { enabled: false, reason: state.reason, dispose: null }
  }

  if (!ctx || typeof ctx.on !== 'function') {
    return { enabled: false, reason: 'no_event_bus', dispose: null }
  }

  log('自动模式已开启（enabled + iUnderstandTheRisk 双开关均置位）')

  const listener = async ({ agent, messages, turn, signal }, next) => {
    // 语法糖：先把下游结果拿到手，再决定要不要追加。
    // 这样**下游的 reject 决策不受影响** —— 我们无权推翻别的插件的拒绝。
    const downstream = await next()

    try {
      if (!downstream || downstream.kind !== 'enter') return downstream
      if (!Array.isArray(downstream.messages) || downstream.messages.length === 0) return downstream
      if (!Array.isArray(messages) || messages.length === 0) return downstream
      if (signal && signal.aborted) return downstream

      const note = buildHint(messages)
      if (!note) return downstream

      // 🔴 不变量：原有消息**一条不少、一条不改**，只在末尾追加。
      //   这里刻意不碰 downstream.messages 的内容，只 append 一条。
      const merged = [...downstream.messages, note]
      log(
        `turn=${turn} step=${(o.meta && o.meta.step) || '?'} 追加提示 ${note.content.length} 字，` +
          `原消息 ${downstream.messages.length} 条未改动`
      )
      return { ...downstream, messages: merged }
    } catch (e) {
      // 自动模式**绝不能**因为自身 bug 让用户的对话失败 —— 出错就原样放行。
      log(`改写失败，已原样放行：${e && e.message}`)
      return downstream
    }
  }

  let dispose = null
  try {
    dispose = ctx.on('agent/pre-step', listener)
  } catch (e) {
    log(`注册 agent/pre-step 失败：${e && e.message}`)
    return { enabled: false, reason: 'register_failed', dispose: null }
  }

  return {
    enabled: true,
    reason: 'enabled',
    dispose: typeof dispose === 'function' ? dispose : null,
  }
}

/**
 * 构造要追加的提示消息。
 *
 * 当前骨架阶段的策略：**只有在用户消息里明显缺少约束/验收时**追加一句**提醒**
 * （不是替用户改写，而是让模型自己注意）。这条策略刻意保守 —— 骨架阶段宁可少提示。
 *
 * @returns {{ role: 'user', content: string } | null}
 */
function buildHint(messages) {
  const text = extractText(messages)
  if (!text) return null

  const HINT = '（提示：这条需求如果缺少验收标准，请先按最合理的理解执行，并在回复末尾列出你的假设。）'
  // 已经提到验收标准就不打扰
  if (/验收|acceptance|怎么算(做对|成功)|done\s*when/i.test(text)) return null
  // 太短的用户输入（"继续"、"好的"）不该被塞提示
  if (text.replace(/\s/g, '').length < 12) return null
  return { role: 'user', content: HINT }
}

/** 把 messages 里的文本抽出来（content 可能是字符串或块数组）。 */
function extractText(messages) {
  const parts = []
  for (const m of messages) {
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text)
      }
    }
  }
  return parts.join('\n').trim()
}

module.exports = { installAutoMode, readAutoMode, buildHint, extractText }
