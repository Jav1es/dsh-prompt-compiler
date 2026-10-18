'use strict'

// 2026-10-19 事故回归：**编译卡住 215 秒**。
//
// 现场：真实宿主 `/compile` 实测 215.7 秒；同一条 draft 用会话在跑的模型只要 5.8 秒。
// 三个叠加原因（每一个都单独可致「等很久什么都没看到」）：
//   ① 模型选择取 `listModels(provider)[0]` → 拿到 `hy4-preview-f`（2250 chunk）
//   ② `for await` 没有任何时限 → 宿主不结束就永远等
//   ③ 前端只有一句静态提示 → 用户无法区分「在跑」和「死了」
//
// 本文件锁死这三条的修复，并且**每条都要能被注入破坏击穿**（否则是恒真绿灯）。

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPromptCompiler } = require('../lib/service.js')

/** 造一个可控的 llm 桩：stream 行为由 opts 决定。 */
function makeLlm(opts) {
  const o = opts || {}
  const calls = []
  return {
    calls,
    listProviders: () => (o.providers || ['workbuddy']).map(id => ({ id })),
    listModels: async p => (o.models && o.models[p]) || [{ id: 'hy3-x' }],
    stream: async req => {
      calls.push({ provider: req.provider, model: req.model, purpose: req.purpose })
      if (o.hang) {
        // 永不产出、永不结束：模拟宿主连接挂住
        return (async function* () { await new Promise(() => {}) })()
      }
      return (async function* () {
        if (o.failWith) {
          yield { type: 'finish', reason: { kind: 'error', failure: o.failWith } }
          return
        }
        yield { type: 'text-delta', text: o.text != null ? o.text : '## Task\n写个爬虫\n\n## Constraints\n- 只用 GET' }
      })()
    },
  }
}

test('修复①：会话当前模型优先于 listModels 的第一个（不得盲取 [0]）', async () => {
  // workbuddy 列表首位故意放慢档 hy4-preview-f，模拟宿主真实排列
  const llm = makeLlm({ models: { workbuddy: [{ id: 'hy4-preview-f' }, { id: 'hy3-x' }] } })
  // 让会话模型可被读到（服务端按多字段探测，这里用最常见的一种）
  llm.currentModel = 'hy3-x'
  const pc = createPromptCompiler({ llm })
  const r = await pc.compile('帮我写个爬虫')
  const used = r.diag && r.diag.modelUsed
  assert.notEqual(used, 'hy4-preview-f', `不得盲取列表第一个慢档，实际用了 ${used}`)
  assert.equal(used, 'hy3-x', `应优先用会话当前模型 hy3-x，实际 ${used}`)
})

test('修复①b：读不到会话模型时，用 provider 优选档而不是列表第一个', async () => {
  const llm = makeLlm({ models: { workbuddy: [{ id: 'hy4-preview-f' }, { id: 'hy3-x' }] } })
  // 不给任何 currentModel/model 字段 → readSessionModel 读不到
  const pc = createPromptCompiler({ llm })
  const r = await pc.compile('帮我写个爬虫')
  const used = r.diag && r.diag.modelUsed
  assert.equal(used, 'hy3-x', `读不到会话模型时应退回优选档 hy3-x，实际 ${used}`)
})

test('修复②：宿主永不结束的流必须在 deadline 内被放弃，并降级出结果', async () => {
  const llm = makeLlm({ hang: true })
  const pc = createPromptCompiler({ llm })
  pc.setDeadlineMs(600) // 测试用短时限
  const t = Date.now()
  const r = await pc.compile('帮我写个爬虫')
  const ms = Date.now() - t

  assert.ok(ms < 5000, `必须在 deadline 附近返回，实际 ${ms}ms`)
  assert.equal(r.diag && r.diag.timedOut, true, 'diag.timedOut 必须为 true')
  assert.equal(r.degraded, true, '超时后必须走规则降级')
  assert.ok(typeof r.compiled === 'string' && r.compiled.length > 0, '超时后仍必须产出结果（宁可粗糙不可挂死）')
  // 超时说明必须存在且说清"多久 + 降级"
  assert.match(String(r.diag.timeoutNote), /超过/, 'timeoutNote 必须说明超时')
  assert.match(String(r.diag.timeoutNote), /降级/, 'timeoutNote 必须说明已降级')
})

test('修复②b：超时后不得再用另一个 purpose/provider 继续等（否则等于等 2-3 倍）', async () => {
  const llm = makeLlm({ hang: true })
  const pc = createPromptCompiler({ llm })
  pc.setDeadlineMs(400)
  const t = Date.now()
  await pc.compile('帮我写个爬虫')
  const ms = Date.now() - t
  // 若超时后仍换 purpose 重试，耗时会翻倍（>800ms）。这里留足余量但仍能区分。
  assert.ok(ms < 1200, `超时后应立即放弃 LLM 链路，实际 ${ms}ms`)
  assert.equal(llm.calls.length, 1, `超时后不应再发起调用，实际发了 ${llm.calls.length} 次`)
})

test('修复②c：正常（快）响应不受 deadline 影响，不得被误判超时', async () => {
  const llm = makeLlm({})
  const pc = createPromptCompiler({ llm })
  pc.setDeadlineMs(60000)
  const r = await pc.compile('帮我写个爬虫')
  assert.equal(r.degraded, false, '正常响应不应降级')
  assert.notEqual(r.diag && r.diag.timedOut, true, '正常响应不得被判超时')
  assert.ok(String(r.compiled).includes('写个爬虫'))
})

test('修复①c：会话模型不属于该 provider 时不得硬塞（按清单归属判定，不靠名字猜）', async () => {
  // 会话模型是 nvidia 的档，但候选 provider 只有 workbuddy
  const llm = makeLlm({ models: { workbuddy: [{ id: 'hy4-preview-f' }, { id: 'hy3-x' }] } })
  llm.currentModel = 'deepseek-v4-pro' // nvidia 的模型，不在 workbuddy 清单里
  const pc = createPromptCompiler({ llm })
  const r = await pc.compile('帮我写个爬虫')
  const used = r.diag && r.diag.modelUsed
  assert.notEqual(used, 'deepseek-v4-pro', `不得把不属于该 provider 的模型塞进去，实际用了 ${used}`)
  assert.equal(used, 'hy3-x', `应退回该 provider 的优选档，实际 ${used}`)
})

test('修复③：当前模型无法调用时必须说清是哪个模型（不得只说"降级了"）', async () => {
  const llm = makeLlm({ failWith: 'NO_ADAPTER' })
  llm.currentModel = 'hy3-x'
  const pc = createPromptCompiler({ llm })
  const r = await pc.compile('帮我写个爬虫')
  assert.equal(r.degraded, true)
  const msg = String(r.diag && r.diag.modelUnavailable)
  assert.ok(msg.length > 0, '必须给出 modelUnavailable 说明')
  assert.match(msg, /hy3-x/, `必须点名是哪个模型没调用成功，实际：${msg}`)
})

test('修复③b：宿主没有 llm 时也要给出可读原因（不是静默降级）', async () => {
  const pc = createPromptCompiler(null)
  const r = await pc.compile('帮我写个爬虫')
  assert.equal(r.degraded, true)
  assert.match(String(r.diag && r.diag.modelUnavailable), /ctx\.llm/, '应说明宿主未提供 ctx.llm')
})

test('deadline 默认值必须是 90 秒（用户拍板值，不得悄悄改动）', () => {
  const pc = createPromptCompiler(null)
  // 传 null = 清除覆盖、回落默认；返回值是**实际生效值**，应等于 90000。
  assert.equal(pc.setDeadlineMs(null), 90000, '默认 deadline 必须是 90000ms（90 秒）')
  // 显式设置要生效
  assert.equal(pc.setDeadlineMs(5000), 5000)
  // 设置后仍可清除回默认
  assert.equal(pc.setDeadlineMs(null), 90000)
})
